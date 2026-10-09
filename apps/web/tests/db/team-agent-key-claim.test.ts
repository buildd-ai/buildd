/**
 * A team's Anthropic or OpenAI API key, on real Postgres, through every agent
 * reader: the host claim's key attach, the Claude route decision, the endpoint
 * ranking, the Codex key, and server-side Anthropic auth (cloud egress).
 *
 * Provider parity: the key's canonical storage is `inference_key` with the
 * provider's label (the row chat reads); `anthropic_api_key` / `openai_api_key`
 * are legacy aliases. Agent readers read both, canonical first within one
 * scope. The properties, on real rows and real WHERE clauses:
 *
 * - a team with only a legacy row is served exactly as before;
 * - a team with only a canonical row now gets that key on agent runs;
 * - canonical beats legacy in the same scope, a more specific scope beats both;
 * - a personal row (`user_id` set) never comes back on the team path.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { encrypt } from '@buildd/core/secrets';
import { resolveAgentModelRoute } from '@buildd/core/agent-endpoint';
import { attachServerManagedSecrets } from '@/app/api/workers/claim/credential-injection';
import { resolveClaudeModelRoute } from '@/app/api/workers/claim/claude-model-route';
import { hasOpenAiApiKey, resolveOpenAiApiKey } from '@/lib/openai-credential';
import { resolveAnthropicAuth } from '@/lib/claude-credential';
import { assertDbConfigured, q, seedWorkspace } from './harness';

if (!process.env.ENCRYPTION_KEY || process.env.ENCRYPTION_KEY.length < 32) {
  process.env.ENCRYPTION_KEY = 'team-agent-key-claim-db-test-key-0123456789';
}

const LEGACY_ANTHROPIC = 'sk-ant-api03-fixture-legacy-key';
const CANONICAL_ANTHROPIC = 'sk-ant-api03-fixture-canonical-key';
const LEGACY_OPENAI = 'sk-proj-fixture-legacy-key';
const CANONICAL_OPENAI = 'sk-proj-fixture-canonical-key';

async function account(teamId: string): Promise<string> {
  const k = `k-${crypto.randomUUID()}`;
  const [a] = await q<{ id: string }>(sql`
    INSERT INTO accounts (type, name, api_key, team_id) VALUES ('service', ${k}, ${k}, ${teamId}::uuid) RETURNING id`);
  return a.id;
}

async function user(): Promise<string> {
  const [u] = await q<{ id: string }>(sql`INSERT INTO users (email) VALUES (${`u-${crypto.randomUUID()}@example.test`}) RETURNING id`);
  return u.id;
}

async function secret(teamId: string, o: {
  purpose: string; label?: string | null; value: string; workspaceId?: string | null; userId?: string | null; updatedAt?: string;
}): Promise<string> {
  const [r] = await q<{ id: string }>(sql`
    INSERT INTO secrets (team_id, purpose, label, encrypted_value, workspace_id, user_id, updated_at)
    VALUES (${teamId}::uuid, ${o.purpose}, ${o.label ?? null}, ${encrypt(o.value)}, ${o.workspaceId ?? null}::uuid,
      ${o.userId ?? null}::uuid, ${o.updatedAt ?? '2026-09-01T00:00:00Z'}::timestamptz)
    RETURNING id`);
  return r.id;
}

/** A fresh team, workspace and claiming account per case: no case sees another's rows. */
async function fresh() {
  const { teamId, workspaceId } = await seedWorkspace();
  return { teamId, workspaceId, accountId: await account(teamId) };
}

async function claimKey(s: { teamId: string; workspaceId: string; accountId: string }): Promise<Record<string, unknown>> {
  const cw = { id: 'w-1', taskId: 't-1', task: { id: 't-1', workspaceId: s.workspaceId, backend: 'claude', workspace: { teamId: s.teamId } } } as any;
  await attachServerManagedSecrets([cw], s.accountId);
  return cw;
}

const route = (s: { teamId: string; workspaceId: string; accountId: string }) => resolveClaudeModelRoute({
  ...s, cloudExecutor: false, llmProviderOverride: false, runnerSupportsEndpoint: false, encryptionKeySet: true,
});

beforeAll(() => {
  assertDbConfigured();
});

describe('team Anthropic key: canonical and legacy storage on real rows', () => {
  test('only a legacy row: served exactly as before', async () => {
    const s = await fresh();
    const id = await secret(s.teamId, { purpose: 'anthropic_api_key', value: LEGACY_ANTHROPIC });
    const cw = await claimKey(s);
    expect(cw.serverApiKey).toBe(LEGACY_ANTHROPIC);
    expect(Object.keys(cw).sort()).toEqual(['id', 'serverApiKey', 'task', 'taskId']);
    expect(await route(s)).toBe('anthropic_api_key');
    expect(await resolveAnthropicAuth({ teamId: s.teamId, workspaceId: s.workspaceId })).toMatchObject({ purpose: 'anthropic_api_key', secretId: id });
  });

  test('only a canonical row: agent runs get that key', async () => {
    const s = await fresh();
    const id = await secret(s.teamId, { purpose: 'inference_key', label: 'anthropic', value: CANONICAL_ANTHROPIC });
    expect((await claimKey(s)).serverApiKey).toBe(CANONICAL_ANTHROPIC);
    expect(await route(s)).toBe('anthropic_api_key');
    const auth = await resolveAnthropicAuth({ teamId: s.teamId, workspaceId: s.workspaceId });
    expect(auth).toMatchObject({ purpose: 'inference_key', secretId: id });
    expect(auth!.headers['x-api-key']).toBe(CANONICAL_ANTHROPIC);
  });

  test('both in one scope: canonical wins, even against a newer legacy row', async () => {
    const s = await fresh();
    await secret(s.teamId, { purpose: 'inference_key', label: 'anthropic', value: CANONICAL_ANTHROPIC, updatedAt: '2026-09-01T00:00:00Z' });
    await secret(s.teamId, { purpose: 'anthropic_api_key', value: LEGACY_ANTHROPIC, updatedAt: '2026-09-05T00:00:00Z' });
    expect((await claimKey(s)).serverApiKey).toBe(CANONICAL_ANTHROPIC);
    expect((await resolveAnthropicAuth({ teamId: s.teamId, workspaceId: s.workspaceId }))!.headers['x-api-key']).toBe(CANONICAL_ANTHROPIC);
  });

  test('a workspace legacy row beats a team canonical row', async () => {
    const s = await fresh();
    await secret(s.teamId, { purpose: 'inference_key', label: 'anthropic', value: CANONICAL_ANTHROPIC });
    await secret(s.teamId, { purpose: 'anthropic_api_key', value: LEGACY_ANTHROPIC, workspaceId: s.workspaceId });
    expect((await claimKey(s)).serverApiKey).toBe(LEGACY_ANTHROPIC);
  });

  test('a personal canonical row never reaches the team path', async () => {
    const s = await fresh();
    const u = await user();
    await secret(s.teamId, { purpose: 'inference_key', label: 'anthropic', value: CANONICAL_ANTHROPIC, userId: u });
    expect((await claimKey(s)).serverApiKey).toBeUndefined();
    expect(await route(s)).toBe('oauth_seat');
    expect(await resolveAnthropicAuth({ teamId: s.teamId, workspaceId: s.workspaceId })).toBeNull();
  });

  test('another provider’s chat key is not the Anthropic key', async () => {
    const s = await fresh();
    await secret(s.teamId, { purpose: 'inference_key', label: 'openrouter', value: 'sk-or-v1-fixture-chat-key' });
    expect((await claimKey(s)).serverApiKey).toBeUndefined();
    expect(await route(s)).toBe('oauth_seat');
    expect(await resolveAnthropicAuth({ teamId: s.teamId, workspaceId: s.workspaceId })).toBeNull();
  });

  test('a workspace canonical key keeps that workspace off a team endpoint', async () => {
    const s = await fresh();
    await secret(s.teamId, {
      purpose: 'agent_endpoint',
      value: JSON.stringify({ kind: 'anthropic-compatible', baseUrl: 'https://endpoint.example.com', apiKey: 'fixture-endpoint-key', authHeader: 'authorization' }),
    });
    await secret(s.teamId, { purpose: 'inference_key', label: 'anthropic', value: CANONICAL_ANTHROPIC, workspaceId: s.workspaceId });
    const d = await resolveAgentModelRoute({ ...s, backend: 'claude' });
    expect(d?.winner).toBe('anthropic');
    // The same key never competes for a Codex run.
    expect((await resolveAgentModelRoute({ ...s, backend: 'codex' }))?.winner).toBe('endpoint');
  });
});

describe('team OpenAI key: canonical and legacy storage on real rows', () => {
  test('only a legacy row: served exactly as before', async () => {
    const s = await fresh();
    const id = await secret(s.teamId, { purpose: 'openai_api_key', value: LEGACY_OPENAI });
    expect(await resolveOpenAiApiKey(s)).toEqual({ apiKey: LEGACY_OPENAI, secretId: id });
  });

  test('only a canonical row: Codex runs get that key', async () => {
    const s = await fresh();
    const id = await secret(s.teamId, { purpose: 'inference_key', label: 'openai', value: CANONICAL_OPENAI });
    expect(await resolveOpenAiApiKey(s)).toEqual({ apiKey: CANONICAL_OPENAI, secretId: id });
    expect(await hasOpenAiApiKey(s)).toBe(true);
  });

  test('both in one scope: canonical wins', async () => {
    const s = await fresh();
    await secret(s.teamId, { purpose: 'openai_api_key', value: LEGACY_OPENAI, updatedAt: '2026-09-05T00:00:00Z' });
    await secret(s.teamId, { purpose: 'inference_key', label: 'openai', value: CANONICAL_OPENAI });
    expect((await resolveOpenAiApiKey(s))?.apiKey).toBe(CANONICAL_OPENAI);
  });

  test('a personal canonical row never reaches the team path', async () => {
    const s = await fresh();
    await secret(s.teamId, { purpose: 'inference_key', label: 'openai', value: CANONICAL_OPENAI, userId: await user() });
    expect(await resolveOpenAiApiKey(s)).toBeNull();
    expect(await hasOpenAiApiKey(s)).toBe(false);
  });
});
