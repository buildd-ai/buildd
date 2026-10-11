/**
 * The request → grant state machine against an in-memory table that applies
 * conditional UPDATEs and the open-row dedupe index atomically, as Postgres
 * does. Covers dedupe, double-click / approve-vs-deny races, revocation
 * stopping the next call, role change and terminal tasks mid-run.
 */
import { describe, it, expect, beforeEach, mock } from 'bun:test';

// ── a tiny drizzle stand-in: columns are names, conditions are predicates ────

type Row = Record<string, any>;
type Pred = (r: Row) => boolean;
const col = (name: string) => ({ __col: name });
const tableOf = (name: string, cols: string[]) => Object.assign({ __table: name }, Object.fromEntries(cols.map(c => [c, col(c)])));

mock.module('drizzle-orm', () => ({
  eq: (c: any, v: any): Pred => r => r[c.__col] === v,
  and: (...ps: Pred[]): Pred => r => ps.every(p => p(r)),
  inArray: (c: any, vs: any[]): Pred => r => vs.includes(r[c.__col]),
  lte: (c: any, v: any): Pred => r => r[c.__col] != null && r[c.__col] <= v,
  desc: (c: any) => ({ desc: c.__col }),
}));

const GRANT_COLS = ['id', 'teamId', 'workspaceId', 'taskId', 'workerId', 'status', 'capability', 'dedupeKey', 'expiresAt', 'decidedAt', 'requestedAt'];
const schema = {
  capabilityGrants: tableOf('grants', GRANT_COLS),
  capabilityPolicies: tableOf('policies', ['teamId', 'id']),
  tasks: tableOf('tasks', ['id']),
  workers: tableOf('workers', ['id']),
};
mock.module('@buildd/core/db/schema', () => schema);

const T: Record<string, Row[]> = { grants: [], policies: [], tasks: [], workers: [] };
let seq = 0;
const tick = () => new Promise(r => setTimeout(r, 0));

const finder = (name: string) => ({
  findFirst: async (q: { where?: Pred } = {}) => { await tick(); return T[name].find(r => !q.where || q.where(r)) ?? undefined; },
  findMany: async (q: { where?: Pred } = {}) => { await tick(); return T[name].filter(r => !q.where || q.where(r)).map(r => ({ ...r })); },
});

const db = {
  query: { capabilityGrants: finder('grants'), capabilityPolicies: finder('policies'), tasks: finder('tasks'), workers: finder('workers') },
  update: (t: any) => ({
    set: (v: Row) => ({
      where: (p: Pred) => {
        // Atomic: match and write in one step, like UPDATE … WHERE.
        const run = async () => { await tick(); const hit = T[t.__table].filter(p); hit.forEach(r => Object.assign(r, v)); return hit.map(r => ({ ...r })); };
        const pr = run();
        return Object.assign(pr, { returning: () => pr });
      },
    }),
  }),
  insert: (t: any) => ({
    values: (v: Row) => ({
      onConflictDoNothing: () => ({
        returning: async () => {
          await tick();
          const open = T[t.__table].some(r => r.dedupeKey === v.dedupeKey && ['pending', 'granted'].includes(r.status));
          if (open) return [];
          const row = { id: `g${++seq}`, requestedAt: new Date(), decidedByUserId: null, revokedAt: null, reason: null, decisionReason: null, ...v };
          T[t.__table].push(row);
          return [{ ...row }];
        },
      }),
    }),
  }),
};
mock.module('@buildd/core/db', () => ({ db }));

const audit: any[] = [];
mock.module('./agent-capabilities/audit', () => ({ recordCapabilityDecision: (r: any) => { audit.push(r); return Promise.resolve(); } }));

// Discovery: one Axiom candidate whose shape each test can change.
const AXIOM = '44444444-4444-4444-8444-444444444444';
let candidate: any;
mock.module('./connector-capabilities-store', () => ({ loadDiscoveryInput: async () => ({ stub: true }) }));
const realCaps = await import('./connector-capabilities');
mock.module('./connector-capabilities', () => ({
  ...realCaps,
  resolveCapability: (_i: any, cap: string) => ({ capability: cap, role: null, candidates: candidate ? [candidate] : [], operator: null, unclassifiedConnectors: [], runtime: '', summary: '' }),
}));

const { requestCapability, decideCapabilityRequest, authorizeCapabilityUse, capabilityGrantSource, loadGrant } = await import('./capability-grants-store');
const { parseCapabilityRequest } = await import('./capability-grants');

// ── fixtures (illustrative) ──────────────────────────────────────────────────

const TEAM = 'team-a';
const WS = '33333333-3333-4333-8333-333333333333';
const TASK = '22222222-2222-4222-8222-222222222222';
const WORKER = '11111111-1111-4111-8111-111111111111';
const PRINCIPAL = { kind: 'agent_run' as const, via: 'task_token' as const, workerId: WORKER, taskId: TASK, workspaceId: WS, teamId: TEAM, accountId: 'acct-1' };
const ADMIN = { userId: 'user-admin' };
const USE = { capability: 'observability:query', provider: 'axiom', connectorId: AXIOM, tool: 'queryApl', resource: null, environment: null };

function axiom(over: Record<string, unknown> = {}) {
  return {
    provider: { slug: 'axiom', name: 'Axiom', catalogPolicy: 'available' },
    connector: { id: AXIOM, name: 'Axiom', ownership: 'team', transport: 'http' },
    match: 'exact', access: 'ask_admin', availableNow: false, reasons: [], nextSteps: [],
    workspace: 'default_enabled', health: 'ok',
    roles: { evaluated: { slug: 'builder', mounts: false }, withAccess: [] },
    compatibility: { status: 'documented' }, risk: { requested: 'read', writeToolsExposed: false, note: '' }, runtimeNeeds: [],
    ...over,
  };
}

function ask(body: Record<string, unknown>) {
  const r = parseCapabilityRequest(body);
  if (!r.ok) throw new Error(r.error);
  return r.request;
}

beforeEach(() => {
  T.grants = []; T.policies = []; audit.length = 0; seq = 0;
  T.tasks = [{ id: TASK, status: 'in_progress', roleSlug: 'builder' }];
  T.workers = [{ id: WORKER, status: 'running' }];
  candidate = axiom();
});

async function pending() {
  const out = await requestCapability(PRINCIPAL, ask({ capability: 'observability:query' }));
  if (!out.ok || !out.grant) throw new Error('expected a pending request');
  expect(out.resolution.kind).toBe('pending_approval');
  return (await loadGrant(out.grant.id))!;
}

// ── tests ────────────────────────────────────────────────────────────────────

describe('requestCapability', () => {
  it('no role mounts it: a pending request, deduped on repeat and on concurrent asks', async () => {
    const [a, b] = await Promise.all([
      requestCapability(PRINCIPAL, ask({ capability: 'observability:query' })),
      requestCapability(PRINCIPAL, ask({ capability: 'observability:query' })),
    ]);
    const c = await requestCapability(PRINCIPAL, ask({ capability: 'observability:query' }));
    const ids = [a, b, c].map(o => (o.ok ? o.grant?.id : null));
    expect(new Set(ids).size).toBe(1);
    expect(T.grants).toHaveLength(1);
    expect(T.grants[0]).toMatchObject({ status: 'pending', workerId: WORKER, taskId: TASK, provider: 'axiom', connectorId: AXIOM, roleSlug: 'builder' });
  });

  it('auto-grants a read another role mounts, with a TTL', async () => {
    candidate = axiom({ access: 'auto_grant', roles: { evaluated: { slug: 'builder', mounts: false }, withAccess: ['researcher'] } });
    const out = await requestCapability(PRINCIPAL, ask({ capability: 'observability:query', ttlSeconds: 600 }));
    expect(out.ok && out.resolution.kind).toBe('auto_granted');
    expect(T.grants[0]).toMatchObject({ status: 'granted', decidedBy: 'policy', ttlSeconds: 600 });
    expect(T.grants[0].expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect((await authorizeCapabilityUse(PRINCIPAL, USE)).allowed).toBe(true);
  });

  it('blocked but installed: forbidden, nothing stored, audited', async () => {
    candidate = axiom({ access: 'forbidden', reasons: ['catalog_blocked'] });
    const out = await requestCapability(PRINCIPAL, ask({ capability: 'observability:query' }));
    expect(out.ok && out.resolution.kind).toBe('forbidden');
    expect(T.grants).toHaveLength(0);
    expect(audit.at(-1)).toMatchObject({ capability: 'capability.request', decision: 'refused', reasonCode: 'forbidden:catalog_blocked' });
  });

  it('refuses a request from an ended task', async () => {
    T.tasks[0].status = 'completed';
    const out = await requestCapability(PRINCIPAL, ask({ capability: 'observability:query' }));
    expect(out).toMatchObject({ ok: false, code: 'task_not_live' });
  });

  it('a denied ask is not re-opened by asking again', async () => {
    const g = await pending();
    await decideCapabilityRequest(g, 'deny', ADMIN);
    const out = await requestCapability(PRINCIPAL, ask({ capability: 'observability:query' }));
    expect(out.ok && out.resolution.kind).toBe('denied');
    expect(T.grants).toHaveLength(1);
  });
});

describe('decideCapabilityRequest', () => {
  it('admin approval makes it usable; a double click is idempotent', async () => {
    const g = await pending();
    const [x, y] = await Promise.all([
      decideCapabilityRequest(g, 'approve', ADMIN, { ttlSeconds: 900 }),
      decideCapabilityRequest(g, 'approve', ADMIN, { ttlSeconds: 900 }),
    ]);
    expect(x.ok && y.ok).toBe(true);
    expect([x, y].filter(o => o.ok && o.alreadyDecided)).toHaveLength(1);
    expect(T.grants[0]).toMatchObject({ status: 'granted', decidedBy: 'human', decidedByUserId: 'user-admin', ttlSeconds: 900 });
    expect((await authorizeCapabilityUse(PRINCIPAL, USE)).allowed).toBe(true);
  });

  it('approve racing deny: exactly one wins, the other gets 409 with the row', async () => {
    const g = await pending();
    const [a, d] = await Promise.all([decideCapabilityRequest(g, 'approve', ADMIN), decideCapabilityRequest(g, 'deny', ADMIN)]);
    const wins = [a, d].filter(o => o.ok);
    expect(wins).toHaveLength(1);
    const loser = [a, d].find(o => !o.ok)!;
    expect(loser).toMatchObject({ ok: false, status: 409 });
  });

  it('deny twice is idempotent; deny is final for that row', async () => {
    const g = await pending();
    expect(await decideCapabilityRequest(g, 'deny', ADMIN)).toMatchObject({ ok: true, alreadyDecided: false });
    expect(await decideCapabilityRequest(g, 'deny', ADMIN)).toMatchObject({ ok: true, alreadyDecided: true });
    expect(await decideCapabilityRequest((await loadGrant(g.id))!, 'approve', ADMIN)).toMatchObject({ ok: false, code: 'already_denied' });
  });

  it('an elevated (write) request can be approved by a person, not past a forbid', async () => {
    candidate = axiom({ access: 'permitted', roles: { evaluated: { slug: 'builder', mounts: true }, withAccess: ['builder'] } });
    const out = await requestCapability(PRINCIPAL, ask({ capability: 'observability:write' }));
    expect(out.ok && out.resolution.kind).toBe('pending_approval');
    const g = (await loadGrant(out.ok ? out.grant!.id : ''))!;
    T.policies = [{ id: 'r1', teamId: TEAM, provider: 'axiom', risk: 'write', workspaceId: null, roleSlug: null, environment: null, resource: null, effect: 'forbidden', maxTtlSeconds: null }];
    expect(await decideCapabilityRequest(g, 'approve', ADMIN)).toMatchObject({ ok: false, code: 'policy_forbidden' });
    T.policies = [];
    expect(await decideCapabilityRequest(g, 'approve', ADMIN)).toMatchObject({ ok: true });
  });

  it('approval after the run ended closes the request instead', async () => {
    const g = await pending();
    T.workers[0].status = 'completed';
    expect(await decideCapabilityRequest(g, 'approve', ADMIN)).toMatchObject({ ok: false, code: 'worker_not_live' });
    expect(T.grants[0].status).toBe('expired');
  });

  it('revocation stops the very next call', async () => {
    const g = await pending();
    await decideCapabilityRequest(g, 'approve', ADMIN);
    expect((await authorizeCapabilityUse(PRINCIPAL, USE)).allowed).toBe(true);
    expect(await decideCapabilityRequest((await loadGrant(g.id))!, 'revoke', ADMIN)).toMatchObject({ ok: true });
    expect(await authorizeCapabilityUse(PRINCIPAL, USE)).toEqual({ allowed: false, reasonCode: 'no_grant' });
    expect(audit.at(-1)).toMatchObject({ capability: 'capability.use', decision: 'refused' });
  });
});

describe('authorizeCapabilityUse', () => {
  async function granted() {
    const g = await pending();
    await decideCapabilityRequest(g, 'approve', ADMIN);
  }

  it('a role change while the worker runs ends the grant', async () => {
    await granted();
    T.tasks[0].roleSlug = 'researcher';
    expect(await authorizeCapabilityUse(PRINCIPAL, USE)).toEqual({ allowed: false, reasonCode: 'role_changed' });
  });

  it('a terminal task ends the grant (no reuse after the task)', async () => {
    await granted();
    T.tasks[0].status = 'failed';
    expect(await authorizeCapabilityUse(PRINCIPAL, USE)).toEqual({ allowed: false, reasonCode: 'task_terminal' });
  });

  it('expired auth on the connector stops granted calls', async () => {
    await granted();
    candidate = axiom({ access: 'reconnect', health: 'needs_reconnect' });
    expect(await authorizeCapabilityUse(PRINCIPAL, USE)).toEqual({ allowed: false, reasonCode: 'credential_dead' });
  });

  it('a team ban (catalog block) after approval stops granted calls', async () => {
    await granted();
    candidate = axiom({ access: 'forbidden' });
    expect(await authorizeCapabilityUse(PRINCIPAL, USE)).toEqual({ allowed: false, reasonCode: 'catalog_blocked' });
  });

  it('replay: another worker on the same task has nothing', async () => {
    await granted();
    T.workers.push({ id: 'w-other', status: 'running' });
    expect(await authorizeCapabilityUse({ ...PRINCIPAL, workerId: 'w-other' }, USE)).toEqual({ allowed: false, reasonCode: 'no_grant' });
  });

  it('provider write guard: a query grant cannot call a write tool', async () => {
    await granted();
    expect(await authorizeCapabilityUse(PRINCIPAL, { ...USE, tool: 'createMonitor' })).toEqual({ allowed: false, reasonCode: 'tool_risk_exceeds_grant' });
  });
});

describe('capabilityGrantSource (model.inference)', () => {
  const budget = { maxCalls: 10, maxTokensPerCall: 1000, maxTotalTokens: 10000, maxUsdPerCall: 0.1, maxUsd: 1, timeoutMs: 10000, maxConcurrent: 2 };
  it('null until a person approves; then the adapter shape; null again after the task ends', async () => {
    const out = await requestCapability(PRINCIPAL, ask({ capability: 'model.inference', provider: 'openrouter', models: ['typesafe/jev-1.13'], budget }));
    expect(out.ok && out.resolution.kind).toBe('pending_approval');
    expect(await capabilityGrantSource.findLiveGrant({ principal: PRINCIPAL, capability: 'model.inference' })).toBeNull();
    await decideCapabilityRequest((await loadGrant(out.ok ? out.grant!.id : ''))!, 'approve', ADMIN);
    expect(await capabilityGrantSource.findLiveGrant({ principal: PRINCIPAL, capability: 'model.inference' })).toMatchObject({
      provider: 'openrouter', models: ['typesafe/jev-1.13'], workerId: WORKER, taskId: TASK, teamId: TEAM, budget,
    });
    T.tasks[0].status = 'cancelled';
    expect(await capabilityGrantSource.findLiveGrant({ principal: PRINCIPAL, capability: 'model.inference' })).toBeNull();
  });
});
