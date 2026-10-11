/**
 * The unified provider resolver, pure half: ranking, policy and requester
 * rules over fixture rows, and parity with the per-surface resolvers it will
 * replace. The SQL predicate is tested against real Postgres in
 * apps/web/tests/db/provider-resolve.test.ts.
 */
import { describe, expect, it, mock } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';

// Only the chat parity oracle (`resolveInferenceCredential`) touches these.
let dbRows: unknown[] = [];
mock.module('../db', () => ({
  db: { query: { secrets: { findMany: async () => dbRows }, teams: { findFirst: async () => null } } },
}));
mock.module('../secrets', () => ({ decrypt: (v: string) => fakeDecrypt(v) }));

import {
  eligibleProviders,
  providerCredentialWhere,
  providerEnvKeysAllowed,
  resolvePurposes,
  selectProviderCredential,
  type ProviderCredentialRow,
  type SelectContext,
} from '../providers/resolve';
import { surfacePolicy, type CredentialPolicy, type ProviderId, type Surface } from '../providers';
import { pickMostSpecificCredential } from '../secrets/team-scope';
import {
  competingScopes,
  endpointWinsRanking,
  rankEndpointRows,
  validateAgentEndpointInput,
} from '../agent-endpoint';

const W = 'ws-1';
const W2 = 'ws-2';
const A = 'acct-1';
const A2 = 'acct-2';
const U = 'user-1';
const U2 = 'user-2';

function fakeDecrypt(v: string): string {
  if (v.startsWith('bad:')) throw new Error('bad ciphertext');
  return v.replace(/^enc:/, '');
}

let seq = 0;
function row(over: Partial<ProviderCredentialRow> & { purpose: string }): ProviderCredentialRow {
  seq++;
  return {
    id: `s${seq}`,
    label: null,
    encryptedValue: `enc:SECRET-${seq}`,
    accountId: null,
    workspaceId: null,
    userId: null,
    healthStatus: 'healthy',
    tokenExpiresAt: null,
    updatedAt: new Date(Date.UTC(2026, 0, 1) + seq * 1000),
    ...over,
  };
}
const anth = (over: Partial<ProviderCredentialRow> = {}) => row({ purpose: 'inference_key', label: 'anthropic', ...over });

function ctx(over: Partial<SelectContext> & { surface: Surface; team?: Record<string, unknown> | null; providers?: ProviderId[] }): SelectContext {
  const { team = null, providers, ...rest } = over;
  return {
    workspaceId: W,
    accountId: null,
    requesterUserId: null,
    eligible: eligibleProviders(over.surface, providers).eligible,
    policy: surfacePolicy(team, over.surface),
    env: { allowed: false, values: {} },
    ...rest,
  };
}

const pick = (rows: ProviderCredentialRow[], c: SelectContext) => selectProviderCredential(rows, c, fakeDecrypt);

// ── Policy × requester × scopes ─────────────────────────────────────────────

describe('policy × requester × scopes available', () => {
  const personal = anth({ userId: U });
  const other = anth({ userId: U2 });
  const workspace = anth({ workspaceId: W });
  const team = anth();
  const all = [personal, other, workspace, team];

  type Want = string | 'none';
  // [surface, credentialPolicy (null = unset), requester, rows, expected winner id]
  const TABLE: Array<[Surface, CredentialPolicy | null, string | null, ProviderCredentialRow[], Want | 'no_personal']> = [
    // chat: personal_first is the default and the requester's own key wins
    ['chat', null, U, all, personal.id],
    ['chat', null, null, all, workspace.id],
    ['chat', 'team', U, all, workspace.id],
    ['chat', 'personal_first', U, all, personal.id],
    ['chat', 'personal_first', U2, [personal, workspace], workspace.id],
    ['chat', 'personal_only', U, all, personal.id],
    ['chat', 'personal_only', U, [workspace, team], 'no_personal'],
    ['chat', 'personal_only', null, all, 'no_personal'],
    ['chat', 'personal_first', U, [team], team.id],
    // agent: NULL credentialPolicy ⇒ team scopes only, never personal
    ['agent-claude', null, U, all, workspace.id],
    ['agent-claude', null, U, [personal], 'none'],
    ['agent-claude', 'team', U, all, workspace.id],
    ['agent-claude', 'personal_first', U, all, personal.id],
    ['agent-claude', 'personal_first', null, all, workspace.id],
    ['agent-claude', 'personal_first', U2, [personal, team], team.id],
    ['agent-claude', 'personal_only', U, all, personal.id],
    ['agent-claude', 'personal_only', U, [workspace, team], 'no_personal'],
    ['agent-claude', 'personal_only', null, all, 'no_personal'],
    ['cloud-egress', null, U, all, workspace.id],
    ['cloud-egress', 'personal_first', U, all, personal.id],
  ];

  for (const [surface, credentialPolicy, requester, rows, want] of TABLE) {
    it(`${surface} policy=${credentialPolicy ?? 'unset'} requester=${requester ?? 'none'} → ${want}`, () => {
      const r = pick(rows, ctx({
        surface,
        team: credentialPolicy ? { credentialPolicy } : null,
        requesterUserId: requester,
        providers: ['anthropic'],
      }));
      if (want === 'none' || want === 'no_personal') {
        expect(r.none).toBe(true);
        if (r.none) expect(r.reason).toBe(want === 'no_personal' ? 'no_personal_credential' : 'no_credential');
      } else {
        expect(r.none).toBeUndefined();
        expect(r.source?.secretId).toBe(want);
      }
    });
  }

  it('never serves another person’s row, whoever asks', () => {
    for (const surface of ['chat', 'agent-claude', 'cloud-egress'] as Surface[]) {
      for (const p of ['team', 'personal_first', 'personal_only'] as CredentialPolicy[]) {
        for (const requester of [null, U2]) {
          const r = pick([personal], ctx({ surface, team: { credentialPolicy: p }, requesterUserId: requester, providers: ['anthropic'] }));
          expect(r.none).toBe(true);
        }
      }
    }
  });

  it('a seat stays team-only until personal seats ship (pendingScopes)', () => {
    const seat = row({ purpose: 'oauth_token', userId: U });
    const r = pick([seat], ctx({ surface: 'agent-claude', team: { credentialPolicy: 'personal_first' }, requesterUserId: U }));
    expect(r.none).toBe(true);
    expect(r.why.join('\n')).toContain('no personal credentials yet');
  });
});

// ── Ranking rules ────────────────────────────────────────────────────────────

describe('ranking', () => {
  it('agent: workspace > account > team; another workspace or account never applies', () => {
    const t = anth();
    const a = anth({ accountId: A });
    const w = anth({ workspaceId: W });
    const wa = anth({ workspaceId: W, accountId: A });
    const otherW = anth({ workspaceId: W2 });
    const otherA = anth({ accountId: A2 });
    const c = ctx({ surface: 'agent-claude', accountId: A, providers: ['anthropic'] });
    expect(pick([t, a, w, wa, otherW, otherA], c).source?.secretId).toBe(wa.id);
    expect(pick([t, a, w, otherW, otherA], c).source?.secretId).toBe(w.id);
    expect(pick([t, a, otherW, otherA], c).source?.secretId).toBe(a.id);
    expect(pick([t, otherW, otherA], c).source?.secretId).toBe(t.id);
    expect(pick([otherW, otherA], c).none).toBe(true);
  });

  it('agent: an account-scoped row needs the claiming account (no legacy fallback)', () => {
    const a = anth({ accountId: A });
    expect(pick([a], ctx({ surface: 'agent-claude', accountId: null, providers: ['anthropic'] })).none).toBe(true);
  });

  it('chat: account > workspace > team > legacy account row for a caller with no account', () => {
    const t = anth();
    const a = anth({ accountId: A });
    const w = anth({ workspaceId: W });
    expect(pick([t, a, w], ctx({ surface: 'chat', accountId: A, providers: ['anthropic'] })).source?.secretId).toBe(a.id);
    expect(pick([t, a, w], ctx({ surface: 'chat', accountId: null, providers: ['anthropic'] })).source?.secretId).toBe(w.id);
    expect(pick([a], ctx({ surface: 'chat', accountId: null, providers: ['anthropic'] })).source?.secretId).toBe(a.id);
    expect(pick([a], ctx({ surface: 'chat', accountId: A2, providers: ['anthropic'] })).none).toBe(true);
  });

  it('canonical storage beats the legacy alias in the same scope, and the source says which', () => {
    const legacy = row({ purpose: 'anthropic_api_key', updatedAt: new Date(Date.UTC(2027, 0, 1)) });
    const canonical = anth();
    for (const surface of ['chat', 'agent-claude'] as Surface[]) {
      const r = pick([legacy, canonical], ctx({ surface, providers: ['anthropic'] }));
      expect(r.source?.secretId).toBe(canonical.id);
      expect(r.source?.legacy).toBe(false);
      const l = pick([legacy], ctx({ surface, providers: ['anthropic'] }));
      expect(l.source?.legacy).toBe(true);
    }
  });

  it('an Anthropic inference_key serves agents (parity by construction)', () => {
    const r = pick([anth()], ctx({ surface: 'agent-claude' }));
    expect(r.provider).toBe('anthropic');
    expect(r.credential?.shape).toBe('api_key');
  });

  it('agent: a revoked row never shadows a live one, but is a last resort', () => {
    const revokedWs = anth({ workspaceId: W, healthStatus: 'revoked' });
    const liveTeam = anth();
    const c = ctx({ surface: 'agent-claude', providers: ['anthropic'] });
    expect(pick([revokedWs, liveTeam], c).source?.secretId).toBe(liveTeam.id);
    expect(pick([revokedWs], c).source?.secretId).toBe(revokedWs.id);
  });

  it('chat: scope before health, as resolveInferenceCredential ranks', () => {
    const revokedWs = anth({ workspaceId: W, healthStatus: 'revoked' });
    const liveTeam = anth();
    expect(pick([revokedWs, liveTeam], ctx({ surface: 'chat', providers: ['anthropic'] })).source?.secretId).toBe(revokedWs.id);
  });

  it('agent: dead refresh families are dropped', () => {
    const dead = row({ purpose: 'claude_credential', workspaceId: W, tokenExpiresAt: null });
    const revoked = row({ purpose: 'claude_credential', workspaceId: W, tokenExpiresAt: new Date(), healthStatus: 'revoked' });
    const live = row({ purpose: 'claude_credential', tokenExpiresAt: new Date() });
    const r = pick([dead, revoked, live], ctx({ surface: 'agent-claude' }));
    expect(r.source?.secretId).toBe(live.id);
    expect(r.provider).toBe('claude-subscription');
    expect(r.credential?.shape).toBe('oauth_managed');
    expect(pick([dead, revoked], ctx({ surface: 'agent-claude' })).none).toBe(true);
  });

  it('provider preference orders within a scope, never across scopes', () => {
    const anthTeam = anth();
    const orTeam = row({ purpose: 'inference_key', label: 'openrouter' });
    const orWs = row({ purpose: 'inference_key', label: 'openrouter', workspaceId: W });
    expect(pick([anthTeam, orTeam], ctx({ surface: 'chat', providers: ['openrouter', 'anthropic'] })).provider).toBe('openrouter');
    expect(pick([anthTeam, orTeam], ctx({ surface: 'chat', providers: ['anthropic', 'openrouter'] })).provider).toBe('anthropic');
    expect(pick([anthTeam, orWs], ctx({ surface: 'chat', providers: ['anthropic', 'openrouter'] })).provider).toBe('openrouter');
  });

  it('a label is matched exactly: an openai inference_key never serves anthropic', () => {
    const r = pick([row({ purpose: 'inference_key', label: 'openai' })], ctx({ surface: 'chat', providers: ['anthropic'] }));
    expect(r.none).toBe(true);
  });

  it('a decrypt failure falls through to the next row', () => {
    const broken = anth({ workspaceId: W, encryptedValue: 'bad:x' });
    const team = anth();
    const r = pick([broken, team], ctx({ surface: 'agent-claude', providers: ['anthropic'] }));
    expect(r.source?.secretId).toBe(team.id);
    expect(r.why.some(l => l.includes(broken.id) && l.includes('could not be decrypted'))).toBe(true);
  });

  it('env stands in on chat only, after every row, and never under personal_only', () => {
    const env = { allowed: true, values: { ANTHROPIC_API_KEY: 'ENVKEY' } };
    const chat = pick([], ctx({ surface: 'chat', providers: ['anthropic'], env }));
    expect(chat.scope).toBe('env');
    expect(chat.source?.envVar).toBe('ANTHROPIC_API_KEY');
    expect(pick([anth()], ctx({ surface: 'chat', providers: ['anthropic'], env })).scope).toBe('team');
    expect(pick([], ctx({ surface: 'chat', providers: ['anthropic'], env, team: { credentialPolicy: 'personal_only' }, requesterUserId: U })).none).toBe(true);
    expect(pick([], ctx({ surface: 'agent-claude', providers: ['anthropic'], env })).none).toBe(true);
    expect(pick([], ctx({ surface: 'chat', providers: ['anthropic'], env: { ...env, allowed: false } })).none).toBe(true);
  });
});

// ── Endpoints ────────────────────────────────────────────────────────────────

function endpointRow(blob: Record<string, unknown>, over: Partial<ProviderCredentialRow> = {}): ProviderCredentialRow {
  const v = validateAgentEndpointInput(blob);
  if (!v.ok) throw new Error(`fixture endpoint invalid: ${v.error}`);
  return row({ purpose: 'agent_endpoint', encryptedValue: `enc:${JSON.stringify(v.blob)}`, ...over });
}
const customBlob = { kind: 'anthropic-compatible', baseUrl: 'https://ep.example.com', apiKey: 'EPKEY', authHeader: 'x-api-key' };
const gatewayBlob = { kind: 'gateway' };

describe('endpoints', () => {
  it('an endpoint wins a tie and loses to a more specific credential', () => {
    const ep = endpointRow(customBlob);
    const key = anth();
    const wsKey = anth({ workspaceId: W });
    expect(pick([ep, key], ctx({ surface: 'agent-claude' })).provider).toBe('custom-endpoint');
    expect(pick([ep, wsKey], ctx({ surface: 'agent-claude' })).provider).toBe('anthropic');
    const r = pick([ep, key], ctx({ surface: 'agent-claude' }));
    expect(r.credential?.endpoint?.kind).toBe('anthropic-compatible');
  });

  it('codex: an anthropic-compatible endpoint is refused with the registry reason; a gateway routes', () => {
    const custom = endpointRow(customBlob);
    const r = pick([custom], ctx({ surface: 'agent-codex' }));
    expect(r.none).toBe(true);
    expect(r.why.join('\n')).toContain('only the Anthropic Messages API');
    const gw = pick([endpointRow(gatewayBlob)], ctx({ surface: 'agent-codex' }));
    expect(gw.provider).toBe('litellm');
  });

  it('a team endpoint narrowed by appliesTo skips other workspaces', () => {
    const narrowed = endpointRow({ ...customBlob, appliesTo: [W2] });
    expect(pick([narrowed], ctx({ surface: 'agent-claude' })).none).toBe(true);
    expect(pick([narrowed], ctx({ surface: 'agent-claude', workspaceId: W2 })).provider).toBe('custom-endpoint');
  });

  it('endpoints are never account-scoped, personal, or read on chat', () => {
    expect(pick([endpointRow(customBlob, { accountId: A })], ctx({ surface: 'agent-claude', accountId: A })).none).toBe(true);
    expect(pick([endpointRow(customBlob, { userId: U })], ctx({ surface: 'agent-claude', requesterUserId: U, team: { credentialPolicy: 'personal_first' } })).none).toBe(true);
    expect(pick([endpointRow(customBlob)], ctx({ surface: 'chat' })).none).toBe(true);
    expect(resolvePurposes('chat', eligibleProviders('chat').eligible)).not.toContain('agent_endpoint');
  });

  it('a litellm gateway row is not a direct agent credential', () => {
    const gw = row({ purpose: 'inference_key', label: 'litellm' });
    expect(pick([gw], ctx({ surface: 'agent-claude' })).none).toBe(true);
    expect(pick([gw], ctx({ surface: 'chat', providers: ['litellm'] })).provider).toBe('litellm');
  });
});

// ── why ──────────────────────────────────────────────────────────────────────

describe('why', () => {
  it('names the policy, the requester, every eligible provider and impossible ones — never a value', () => {
    const rows = [anth({ userId: U }), anth({ workspaceId: W }), anth(), row({ purpose: 'oauth_token' }), endpointRow(customBlob)];
    const r = pick(rows, ctx({ surface: 'agent-claude', team: { credentialPolicy: 'personal_first' }, requesterUserId: U }));
    const text = r.why.join('\n');
    expect(text).toContain('policy: personal_first');
    expect(text).toContain('requester: present');
    expect(text).toContain('outranked by personal anthropic');
    for (const rw of rows) expect(text).not.toContain(fakeDecrypt(rw.encryptedValue));
    expect(text).not.toContain('EPKEY');
    expect(text).not.toContain('SECRET-');
  });

  it('eligibleProviders reports impossible pairs with the registry reason', () => {
    const { eligible, impossible } = eligibleProviders('agent-codex', ['anthropic', 'openai']);
    expect(eligible).toEqual(['openai']);
    expect(impossible).toEqual([{ provider: 'anthropic', reason: expect.stringContaining('Codex CLI') }]);
  });
});

// ── SQL predicate shape (the behaviour is in the real-PG test) ──────────────

describe('providerCredentialWhere', () => {
  const dialect = new PgDialect();
  const render = (w: ReturnType<typeof providerCredentialWhere>) => dialect.sqlToQuery(w);
  const base = { teamId: 'T', workspaceId: W, accountId: null, requesterUserId: U, purposes: ['inference_key'], legacyAccountRows: false };

  it('reaches a personal row only through user_id = requester, and only when allowed', () => {
    const allowed = render(providerCredentialWhere({ ...base, personalAllowed: true }));
    expect(allowed.params).toContain(U);
    const denied = render(providerCredentialWhere({ ...base, personalAllowed: false }));
    expect(denied.params).not.toContain(U);
    expect(denied.sql).toContain('"user_id" is null or false');
    const noRequester = render(providerCredentialWhere({ ...base, requesterUserId: null, personalAllowed: true }));
    expect(noRequester.sql).toContain('"user_id" is null or false');
  });
});

// ── Parity with the per-surface resolvers ───────────────────────────────────

/** Deterministic PRNG, so a failure reproduces. */
function prng(seed: number) {
  return () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
}

describe('parity: chat ≡ resolveInferenceCredential', async () => {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  const { resolveInferenceCredential } = await import('../inference-keys');
  const rand = prng(42);
  const scopes: Array<Partial<ProviderCredentialRow>> = [
    {}, { workspaceId: W }, { workspaceId: W2 }, { accountId: A }, { accountId: A2 }, { userId: U }, { userId: U2 },
    { workspaceId: W, accountId: A },
  ];
  const kinds: Array<{ purpose: string; label?: string }> = [
    { purpose: 'inference_key', label: 'anthropic' }, { purpose: 'anthropic_api_key' },
    { purpose: 'inference_key', label: 'openai' }, { purpose: 'inference_key', label: 'Anthropic' },
  ];

  it('matches on 600 random fixtures × policy × requester × account', async () => {
    let compared = 0;
    for (let i = 0; i < 600; i++) {
      const rows: ProviderCredentialRow[] = [];
      const n = 1 + Math.floor(rand() * 5);
      for (let j = 0; j < n; j++) {
        const k = kinds[Math.floor(rand() * kinds.length)];
        rows.push(row({
          purpose: k.purpose, label: k.label ?? null,
          ...scopes[Math.floor(rand() * scopes.length)],
          healthStatus: rand() < 0.25 ? 'revoked' : 'healthy',
        }));
      }
      for (const keyPolicy of ['team', 'team_or_own', 'own'] as const) {
        for (const requester of [U, null]) {
          for (const accountId of [null, A]) {
            dbRows = rows;
            const old = await resolveInferenceCredential({ provider: 'anthropic', teamId: 'T', workspaceId: W, userId: requester, accountId, keyPolicy });
            const now = pick(rows, ctx({ surface: 'chat', team: { inferenceKeyPolicy: keyPolicy }, requesterUserId: requester, accountId, providers: ['anthropic'] }));
            expect({ i, keyPolicy, requester, accountId, id: now.source?.secretId ?? null })
              .toEqual({ i, keyPolicy, requester, accountId, id: old?.secretId ?? null });
            compared++;
          }
        }
      }
    }
    expect(compared).toBe(600 * 12);
  });
});

describe('parity: env rule ≡ inference-keys envKeysAllowed', () => {
  it('agrees on every NODE_ENV × opt-in combination', async () => {
    const { envKeysAllowed } = await import('../inference-keys');
    const saved = { NODE_ENV: process.env.NODE_ENV, OPT: process.env.BUILDD_ALLOW_ENV_INFERENCE_KEYS };
    try {
      for (const nodeEnv of ['production', 'test', 'development', undefined]) {
        for (const opt of ['1', '0', undefined]) {
          const env = { NODE_ENV: nodeEnv, BUILDD_ALLOW_ENV_INFERENCE_KEYS: opt };
          for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
          expect({ nodeEnv, opt, allowed: providerEnvKeysAllowed(env) }).toEqual({ nodeEnv, opt, allowed: envKeysAllowed() });
        }
      }
    } finally {
      process.env.NODE_ENV = saved.NODE_ENV;
      if (saved.OPT === undefined) delete process.env.BUILDD_ALLOW_ENV_INFERENCE_KEYS; else process.env.BUILDD_ALLOW_ENV_INFERENCE_KEYS = saved.OPT;
    }
  });
});

describe('parity: agent (credentialPolicy unset, no requester) ≡ today’s agent pick', () => {
  const rand = prng(7);
  const scopes: Array<Partial<ProviderCredentialRow>> = [
    {}, { workspaceId: W }, { workspaceId: W2 }, { accountId: A }, { accountId: A2 }, { userId: U }, { workspaceId: W, accountId: A },
  ];

  it('anthropic_api_key: pickMostSpecificCredential', () => {
    for (let i = 0; i < 400; i++) {
      const rows = Array.from({ length: 1 + Math.floor(rand() * 5) }, () => row({
        purpose: 'anthropic_api_key',
        ...scopes[Math.floor(rand() * scopes.length)],
        healthStatus: rand() < 0.3 ? 'revoked' : 'healthy',
      }));
      const old = pickMostSpecificCredential(rows, { accountId: A, workspaceId: W });
      const now = pick(rows, ctx({ surface: 'agent-claude', accountId: A, requesterUserId: U, providers: ['anthropic'] }));
      expect({ i, id: now.source?.secretId ?? null }).toEqual({ i, id: old?.id ?? null });
    }
  });

  it('claude_credential: resolveClaudeCredential’s live filter + pickMostSpecificCredential', () => {
    for (let i = 0; i < 400; i++) {
      const rows = Array.from({ length: 1 + Math.floor(rand() * 5) }, () => row({
        purpose: 'claude_credential',
        ...scopes[Math.floor(rand() * scopes.length)],
        tokenExpiresAt: rand() < 0.2 ? null : new Date(Date.UTC(2026, 5, 1)),
        healthStatus: rand() < 0.2 ? 'revoked' : 'healthy',
      }));
      const live = rows.filter(r => r.tokenExpiresAt !== null && r.healthStatus !== 'revoked');
      const old = pickMostSpecificCredential(live, { accountId: A, workspaceId: W });
      const now = pick(rows, ctx({ surface: 'agent-claude', accountId: A, providers: ['claude-subscription'] }));
      expect({ i, id: now.source?.secretId ?? null }).toEqual({ i, id: old?.id ?? null });
    }
  });

  it('endpoint vs anthropic_api_key: resolveAgentModelRoute’s ranking', () => {
    const epScopes: Array<Partial<ProviderCredentialRow>> = [{}, { workspaceId: W }, { workspaceId: W2 }];
    for (let i = 0; i < 400; i++) {
      const eps = Array.from({ length: Math.floor(rand() * 3) }, () =>
        endpointRow(customBlob, { ...epScopes[Math.floor(rand() * epScopes.length)], healthStatus: rand() < 0.2 ? 'revoked' : 'healthy' }));
      const keys = Array.from({ length: Math.floor(rand() * 3) }, () => row({
        purpose: 'anthropic_api_key',
        ...scopes[Math.floor(rand() * scopes.length)],
        healthStatus: rand() < 0.2 ? 'revoked' : 'healthy',
      }));
      const endpoint = rankEndpointRows(eps, W)[0];
      const keyPick = pickMostSpecificCredential(keys, { accountId: A, workspaceId: W });
      let oldId: string | null;
      if (!endpoint) oldId = keyPick?.id ?? null;
      else {
        const won = endpointWinsRanking(endpoint.workspaceId ? 'workspace' : 'team', competingScopes(keys, { workspaceId: W, accountId: A }));
        oldId = won ? endpoint.id : keyPick?.id ?? null;
      }
      const now = pick([...eps, ...keys], ctx({ surface: 'agent-claude', accountId: A, providers: ['custom-endpoint', 'anthropic'] }));
      expect({ i, id: now.source?.secretId ?? null }).toEqual({ i, id: oldId });
    }
  });
});
