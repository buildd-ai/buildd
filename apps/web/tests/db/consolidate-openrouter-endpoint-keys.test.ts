/**
 * The OpenRouter endpoint key backfill against real Postgres
 * (packages/core/scripts/consolidate-openrouter-endpoint-keys.ts).
 *
 * What it rewrites is decided by a decrypt plus the stored-key lookup, and
 * written by compare-and-set statements; a mocked db would see none of that.
 * Each case seeds its own team and runs the backfill scoped to it, so other
 * files' rows are never touched. Fixtures are illustrative, nothing is a key.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { encrypt, decrypt } from '@buildd/core/secrets';
import { resolveAgentEndpoint } from '@buildd/core/agent-endpoint';
import { consolidateOpenRouterEndpointKeys, formatCounts } from '../../../../packages/core/scripts/consolidate-openrouter-endpoint-keys';
import { assertDbConfigured, q, seedWorkspace } from './harness';

if (!process.env.ENCRYPTION_KEY || process.env.ENCRYPTION_KEY.length < 32) {
  process.env.ENCRYPTION_KEY = 'openrouter-backfill-db-test-key-0123456789abcdef';
}

const BASE = 'https://openrouter.ai/api';
const inlineBlob = (apiKey: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ kind: 'openrouter', baseUrl: BASE, apiKey, authHeader: 'authorization', ...extra });

async function secret(teamId: string, o: { purpose: string; label?: string | null; value: string; workspaceId?: string | null }): Promise<string> {
  const [s] = await q<{ id: string }>(sql`
    INSERT INTO secrets (team_id, purpose, label, encrypted_value, workspace_id)
    VALUES (${teamId}::uuid, ${o.purpose}, ${o.label ?? null}, ${encrypt(o.value)}, ${o.workspaceId ?? null}::uuid)
    RETURNING id`);
  return s.id;
}
const endpoint = (teamId: string, value: string, workspaceId: string | null = null) =>
  secret(teamId, { purpose: 'agent_endpoint', value, workspaceId });
const openRouterKey = (teamId: string, value: string, workspaceId: string | null = null) =>
  secret(teamId, { purpose: 'inference_key', label: 'openrouter', value, workspaceId });

async function blobOf(id: string): Promise<Record<string, unknown>> {
  const [r] = await q<{ encrypted_value: string }>(sql`SELECT encrypted_value FROM secrets WHERE id = ${id}::uuid`);
  return JSON.parse(decrypt(r.encrypted_value));
}
async function openRouterKeys(teamId: string): Promise<Array<{ workspace_id: string | null; value: string }>> {
  const rows = await q<{ workspace_id: string | null; encrypted_value: string }>(sql`
    SELECT workspace_id, encrypted_value FROM secrets
    WHERE team_id = ${teamId}::uuid AND purpose = 'inference_key' AND label = 'openrouter'`);
  return rows.map((r) => ({ workspace_id: r.workspace_id, value: decrypt(r.encrypted_value) }));
}
const run = (teamId: string, apply = true) => consolidateOpenRouterEndpointKeys({ apply, teamId });

beforeAll(() => {
  assertDbConfigured();
});

describe('consolidate-openrouter-endpoint-keys', () => {
  test('equal key: the inline key is stripped and the endpoint resolves the stored key', async () => {
    const { teamId, workspaceId } = await seedWorkspace();
    await openRouterKey(teamId, 'sk-or-same-fixture');
    const id = await endpoint(teamId, inlineBlob('sk-or-same-fixture', { capabilities: { toolSearch: false } }));

    const counts = await run(teamId);
    expect(counts).toMatchObject({ scanned: 1, stripped: 1, created: 0, flagged: 0, failed: 0, raced: 0 });
    expect(await blobOf(id)).toEqual({ kind: 'openrouter', baseUrl: BASE, authHeader: 'authorization', capabilities: { toolSearch: false } });
    const r = await resolveAgentEndpoint({ teamId, workspaceId });
    expect(r).toMatchObject({ secretId: id, kind: 'openrouter', apiKey: 'sk-or-same-fixture', toolSearch: false });
  });

  test('a workspace endpoint matches the team key (broader scope) and is stripped', async () => {
    const { teamId, workspaceId } = await seedWorkspace();
    await openRouterKey(teamId, 'sk-or-team-fixture');
    const id = await endpoint(teamId, inlineBlob('sk-or-team-fixture'), workspaceId);
    expect(await run(teamId)).toMatchObject({ stripped: 1 });
    expect(await blobOf(id)).not.toHaveProperty('apiKey');
    expect((await resolveAgentEndpoint({ teamId, workspaceId }))?.apiKey).toBe('sk-or-team-fixture');
  });

  test('no stored key: one is created at the endpoint\'s scope, then the endpoint references it', async () => {
    const { teamId, workspaceId } = await seedWorkspace();
    const teamRow = await endpoint(teamId, inlineBlob('sk-or-team-only-fixture'));
    const wsRow = await endpoint(teamId, inlineBlob('sk-or-ws-only-fixture'), workspaceId);

    // Workspace rows go first, so the workspace row gets its own key at its
    // scope instead of being flagged against the team key created after it.
    const counts = await run(teamId);
    expect(counts).toMatchObject({ created: 2, flagged: 0, failed: 0, raced: 0, unreadable: 0 });
    expect(await blobOf(teamRow)).not.toHaveProperty('apiKey');
    expect(await blobOf(wsRow)).not.toHaveProperty('apiKey');
    const keys = await openRouterKeys(teamId);
    expect(keys).toHaveLength(2);
    expect(keys).toContainEqual({ workspace_id: null, value: 'sk-or-team-only-fixture' });
    expect(keys).toContainEqual({ workspace_id: workspaceId, value: 'sk-or-ws-only-fixture' });
    expect((await resolveAgentEndpoint({ teamId, workspaceId: null }))?.apiKey).toBe('sk-or-team-only-fixture');
    expect((await resolveAgentEndpoint({ teamId, workspaceId }))?.apiKey).toBe('sk-or-ws-only-fixture');
  });

  test('no stored key at a workspace endpoint with no team key: created at the workspace, never team-wide', async () => {
    const { teamId, workspaceId } = await seedWorkspace();
    const id = await endpoint(teamId, inlineBlob('sk-or-ws-fixture'), workspaceId);
    expect(await run(teamId)).toMatchObject({ created: 1, stripped: 0 });
    expect(await openRouterKeys(teamId)).toEqual([{ workspace_id: workspaceId, value: 'sk-or-ws-fixture' }]);
    expect(await blobOf(id)).not.toHaveProperty('apiKey');
    expect((await resolveAgentEndpoint({ teamId, workspaceId }))?.apiKey).toBe('sk-or-ws-fixture');
  });

  test('different key: the endpoint is left inline and flagged, and keeps routing its own key', async () => {
    const { teamId, workspaceId } = await seedWorkspace();
    await openRouterKey(teamId, 'sk-or-stored-fixture');
    const id = await endpoint(teamId, inlineBlob('sk-or-inline-fixture'));
    expect(await run(teamId)).toMatchObject({ flagged: 1, stripped: 0, created: 0 });
    expect(await blobOf(id)).toEqual({
      kind: 'openrouter', baseUrl: BASE, apiKey: 'sk-or-inline-fixture', authHeader: 'authorization', capabilities: { legacyInlineKey: true },
    });
    expect((await resolveAgentEndpoint({ teamId, workspaceId }))?.apiKey).toBe('sk-or-inline-fixture');
    expect(await openRouterKeys(teamId)).toEqual([{ workspace_id: null, value: 'sk-or-stored-fixture' }]);
  });

  test('the legacy decision_key counts as the stored key', async () => {
    const { teamId } = await seedWorkspace();
    await secret(teamId, { purpose: 'decision_key', value: 'sk-or-legacy-fixture' });
    const id = await endpoint(teamId, inlineBlob('sk-or-legacy-fixture'));
    expect(await run(teamId)).toMatchObject({ stripped: 1, created: 0 });
    expect(await blobOf(id)).not.toHaveProperty('apiKey');
    expect(await openRouterKeys(teamId)).toEqual([]);
  });

  test('dry run writes nothing; a second applied run changes nothing', async () => {
    const { teamId } = await seedWorkspace();
    await openRouterKey(teamId, 'sk-or-a-fixture');
    const equal = await endpoint(teamId, inlineBlob('sk-or-a-fixture'));
    const other = await seedWorkspace();
    const created = await endpoint(other.teamId, inlineBlob('sk-or-b-fixture'));
    const third = await seedWorkspace();
    await openRouterKey(third.teamId, 'sk-or-c-fixture');
    const different = await endpoint(third.teamId, inlineBlob('sk-or-d-fixture'));
    const gateway = await endpoint(teamId, JSON.stringify({ kind: 'gateway' }), (await seedWorkspaceIn(teamId)));

    const snapshot = async () => q<{ id: string; encrypted_value: string }>(sql`
      SELECT id, encrypted_value FROM secrets WHERE team_id IN (${teamId}::uuid, ${other.teamId}::uuid, ${third.teamId}::uuid) ORDER BY id`);
    const before = await snapshot();

    const dry = [await run(teamId, false), await run(other.teamId, false), await run(third.teamId, false)];
    expect(dry[0]).toMatchObject({ stripped: 1, otherKind: 1 });
    expect(dry[1]).toMatchObject({ created: 1 });
    expect(dry[2]).toMatchObject({ flagged: 1 });
    expect(await snapshot()).toEqual(before);

    for (const t of [teamId, other.teamId, third.teamId]) await run(t);
    const afterFirst = await snapshot();
    expect(afterFirst).not.toEqual(before);

    const second = [await run(teamId), await run(other.teamId), await run(third.teamId)];
    expect(second[0]).toMatchObject({ alreadyReference: 1, otherKind: 1, stripped: 0, created: 0, flagged: 0 });
    expect(second[1]).toMatchObject({ alreadyReference: 1, stripped: 0, created: 0, flagged: 0 });
    expect(second[2]).toMatchObject({ alreadyFlagged: 1, stripped: 0, created: 0, flagged: 0 });
    expect(await snapshot()).toEqual(afterFirst);
    expect(await blobOf(gateway)).toEqual({ kind: 'gateway' });
    for (const id of [equal, created]) expect(await blobOf(id)).not.toHaveProperty('apiKey');
    expect(await blobOf(different)).toHaveProperty('apiKey', 'sk-or-d-fixture');
  });

  test('a flagged row whose stored key now matches is stripped, flag and all', async () => {
    const { teamId } = await seedWorkspace();
    await openRouterKey(teamId, 'sk-or-now-same-fixture');
    const id = await endpoint(teamId, inlineBlob('sk-or-now-same-fixture', { capabilities: { legacyInlineKey: true } }));
    expect(await run(teamId)).toMatchObject({ stripped: 1 });
    expect(await blobOf(id)).toEqual({ kind: 'openrouter', baseUrl: BASE, authHeader: 'authorization' });
  });

  test('the printed report is counts only: no key, no id, no team', async () => {
    const { teamId } = await seedWorkspace();
    const id = await endpoint(teamId, inlineBlob('sk-or-print-fixture'));
    const out = formatCounts(await run(teamId, false), false);
    expect(out).toContain('DRY RUN');
    expect(out).not.toContain('sk-or-print-fixture');
    expect(out).not.toContain(id);
    expect(out).not.toContain(teamId);
    expect(out).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  });
});

async function seedWorkspaceIn(teamId: string): Promise<string> {
  const [w] = await q<{ id: string }>(sql`
    INSERT INTO workspaces (name, team_id) VALUES (${`w-${crypto.randomUUID()}`}, ${teamId}::uuid) RETURNING id`);
  return w.id;
}
