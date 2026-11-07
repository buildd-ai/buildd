/**
 * The request → grant state machine against an in-memory table that applies
 * conditional UPDATEs and the open-row dedupe index atomically, as Postgres
 * does. Covers dedupe, double-click / approve-vs-deny races, revocation
 * stopping the next call, role change and terminal tasks mid-run.
 */
import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { capturedWhere } from '@buildd/core/db/relational-sql';

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
  tasks: tableOf('tasks', ['id', 'updatedAt', 'delegation']),
  workers: tableOf('workers', ['id']),
  workspaces: tableOf('workspaces', ['id']),
};
mock.module('@buildd/core/db/schema', () => schema);

const T: Record<string, Row[]> = { grants: [], policies: [], tasks: [], workers: [], workspaces: [] };
let seq = 0;
const tick = () => new Promise(r => setTimeout(r, 0));

const finder = (name: string) => ({
  findFirst: async (q: { where?: unknown } = {}) => { await tick(); const w = capturedWhere(q.where) as Pred | undefined; return T[name].find(r => !w || w(r)) ?? undefined; },
  findMany: async (q: { where?: unknown } = {}) => { await tick(); const w = capturedWhere(q.where) as Pred | undefined; return T[name].filter(r => !w || w(r)).map(r => ({ ...r })); },
});

const db = {
  query: { capabilityGrants: finder('grants'), capabilityPolicies: finder('policies'), tasks: finder('tasks'), workers: finder('workers'), workspaces: finder('workspaces') },
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

// The approver's own reach, for tasks:create approvals.
let approverReaches = true;
mock.module('./team-access', () => ({
  verifyWorkspaceAccess: async () => (approverReaches ? { role: 'admin' } : null),
  verifyAccountWorkspaceAccess: async () => true,
}));

const audit: any[] = [];
mock.module('./agent-capabilities/audit', () => ({ recordCapabilityDecision: (r: any) => { audit.push(r); return Promise.resolve(); } }));

// Discovery: one Axiom candidate whose shape each test can change.
const AXIOM = '44444444-4444-4444-8444-444444444444';
let candidate: any;
mock.module('./connector-capabilities-store', () => ({ loadDiscoveryInput: async () => ({ stub: true }) }));
const realCaps = await import('./connector-capabilities');
mock.module('./connector-capabilities', () => ({
  ...realCaps,
  resolveProviderAccess: (_i: any, provider: string, access: string) => ({ capability: `${provider}:${access}`, role: null, candidates: candidate ? [candidate] : [], operator: null, unclassifiedConnectors: [], runtime: '', summary: '' }),
}));

const { requestCapability, decideCapabilityRequest, authorizeCapabilityUse, capabilityGrantSource, loadGrant, expireLapsedTeamGrants, listTeamRequests, findDatabaseQueryGrant, revokeFiledGrants } = await import('./capability-grants-store');
const { inheritTaskDelegation, stampTaskAccess, withTaskAccess } = await import('@buildd/core/token-delegation');
const { parseCapabilityRequest } = await import('./capability-grants');

// ── fixtures (illustrative) ──────────────────────────────────────────────────

const TEAM = 'team-a';
const WS = '33333333-3333-4333-8333-333333333333';
const TASK = '22222222-2222-4222-8222-222222222222';
const WORKER = '11111111-1111-4111-8111-111111111111';
const OTHER_WS = '55555555-5555-4555-8555-555555555555';
const FOREIGN_WS = '66666666-6666-4666-8666-666666666666';
const PRINCIPAL = { kind: 'agent_run' as const, via: 'task_token' as const, workerId: WORKER, taskId: TASK, workspaceId: WS, teamId: TEAM, accountId: 'acct-1' };
const ADMIN = { userId: 'user-admin' };
const USE = { capability: 'axiom:read', provider: 'axiom', connectorId: AXIOM, tool: 'queryApl', resource: null, environment: null };

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
  T.tasks = [{ id: TASK, workspaceId: WS, status: 'in_progress', roleSlug: 'builder', delegation: null, updatedAt: new Date(0) }];
  T.workspaces = [{ id: WS, teamId: TEAM }, { id: OTHER_WS, teamId: TEAM }, { id: FOREIGN_WS, teamId: 'team-b' }];
  approverReaches = true;
  T.workers = [{ id: WORKER, status: 'running' }];
  candidate = axiom();
});

async function pending() {
  const out = await requestCapability(PRINCIPAL, ask({ provider: 'axiom', access: 'read' }));
  if (!out.ok || !out.grant) throw new Error('expected a pending request');
  expect(out.resolution.kind).toBe('pending_approval');
  return (await loadGrant(out.grant.id))!;
}

// ── tests ────────────────────────────────────────────────────────────────────

describe('requestCapability', () => {
  it('no role mounts it: a pending request, deduped on repeat and on concurrent asks', async () => {
    const [a, b] = await Promise.all([
      requestCapability(PRINCIPAL, ask({ provider: 'axiom', access: 'read' })),
      requestCapability(PRINCIPAL, ask({ provider: 'axiom', access: 'read' })),
    ]);
    const c = await requestCapability(PRINCIPAL, ask({ provider: 'axiom', access: 'read' }));
    const ids = [a, b, c].map(o => (o.ok ? o.grant?.id : null));
    expect(new Set(ids).size).toBe(1);
    expect(T.grants).toHaveLength(1);
    expect(T.grants[0]).toMatchObject({ status: 'pending', workerId: WORKER, taskId: TASK, provider: 'axiom', connectorId: AXIOM, roleSlug: 'builder' });
  });

  it('auto-grants a read another role mounts, with a TTL', async () => {
    candidate = axiom({ access: 'auto_grant', roles: { evaluated: { slug: 'builder', mounts: false }, withAccess: ['researcher'] } });
    const out = await requestCapability(PRINCIPAL, ask({ provider: 'axiom', access: 'read', ttlSeconds: 600 }));
    expect(out.ok && out.resolution.kind).toBe('auto_granted');
    expect(T.grants[0]).toMatchObject({ status: 'granted', decidedBy: 'policy', ttlSeconds: 600 });
    expect(T.grants[0].expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect((await authorizeCapabilityUse(PRINCIPAL, USE)).allowed).toBe(true);
  });

  it('blocked but installed: forbidden, nothing stored, audited', async () => {
    candidate = axiom({ access: 'forbidden', reasons: ['catalog_blocked'] });
    const out = await requestCapability(PRINCIPAL, ask({ provider: 'axiom', access: 'read' }));
    expect(out.ok && out.resolution.kind).toBe('forbidden');
    expect(T.grants).toHaveLength(0);
    expect(audit.at(-1)).toMatchObject({ capability: 'capability.request', decision: 'refused', reasonCode: 'forbidden:catalog_blocked' });
  });

  it('refuses a request from an ended task', async () => {
    T.tasks[0].status = 'completed';
    const out = await requestCapability(PRINCIPAL, ask({ provider: 'axiom', access: 'read' }));
    expect(out).toMatchObject({ ok: false, code: 'task_not_live' });
  });

  it('a denied ask is not re-opened by asking again', async () => {
    const g = await pending();
    await decideCapabilityRequest(g, 'deny', ADMIN);
    const out = await requestCapability(PRINCIPAL, ask({ provider: 'axiom', access: 'read' }));
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
    const out = await requestCapability(PRINCIPAL, ask({ provider: 'axiom', access: 'write' }));
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

// ── tasks:create: filing in another workspace of the team ────────────────────

describe('tasks:create requests', () => {
  const fileThere = (resource = OTHER_WS) => requestCapability(PRINCIPAL, ask({ provider: 'buildd', access: 'write', resource, reason: 'file the follow-ups the owner asked for' }));
  const delegation = () => T.tasks[0].delegation;

  it('asks a person, keeps the run alive, and a repeat ask is the same request', async () => {
    const first = await fileThere();
    expect(first.ok && first.resolution.kind).toBe('pending_approval');
    expect(first.ok && first.resolution.nextSteps.join(' ')).toMatch(/Do not end the run/);
    const again = await fileThere();
    expect(again.ok && again.deduped).toBe(true);
    expect(T.grants).toHaveLength(1);
    expect(T.grants[0]).toMatchObject({ capability: 'tasks:create', provider: 'buildd', resource: OTHER_WS, risk: 'write', status: 'pending' });
    expect(delegation()).toBeNull();
  });

  it('an approval lands as a delegation grant bound to that task; a revoke takes it back', async () => {
    const out = await fileThere();
    const row = (await loadGrant(out.ok ? out.grant!.id : ''))!;
    const approved = await decideCapabilityRequest(row, 'approve', ADMIN);
    expect(approved.ok).toBe(true);
    expect(delegation()).toMatchObject({
      grants: [{ workspaceId: OTHER_WS, capabilities: ['tasks:create'] }],
      grantedByUserId: 'user-admin',
      capabilityGrantIds: [row.id],
    });
    // Covered now: asking again is `existing`, not a new request.
    const covered = await fileThere();
    expect(covered.ok && covered.resolution.kind).toBe('existing');

    await decideCapabilityRequest((await loadGrant(row.id))!, 'revoke', ADMIN);
    expect(delegation()).toBeNull();
  });

  it('an approver who does not reach the target cannot grant it', async () => {
    approverReaches = false;
    const out = await fileThere();
    const res = await decideCapabilityRequest((await loadGrant(out.ok ? out.grant!.id : ''))!, 'approve', ADMIN);
    expect(res.ok).toBe(false);
    expect(!res.ok && res.code).toBe('approver_lacks_reach');
    expect(delegation()).toBeNull();
  });

  it('another team\'s workspace is forbidden outright, and nothing is queued', async () => {
    const out = await fileThere(FOREIGN_WS);
    expect(out.ok && out.resolution.kind).toBe('forbidden');
    expect(T.grants).toHaveLength(0);
  });

  it('its own workspace needs nothing', async () => {
    const out = await fileThere(WS);
    expect(out.ok && out.resolution.kind).toBe('existing');
  });

  it('needs a workspace UUID, and never a connector', () => {
    expect(parseCapabilityRequest({ provider: 'buildd', access: 'write' }).ok).toBe(false);
    expect(parseCapabilityRequest({ provider: 'buildd', access: 'write', resource: 'buildd' }).ok).toBe(false);
    expect(parseCapabilityRequest({ resource: OTHER_WS, provider: 'axiom', access: 'write', capability: 'tasks:create' }).ok).toBe(false);
    expect(parseCapabilityRequest({ provider: 'buildd', access: 'write', resource: OTHER_WS, tool: 'createTask' }).ok).toBe(false);
  });
});

// ── analytics:read: reading another workspace's analytics ─────────────────────

describe('analytics:read requests (provider buildd, access read)', () => {
  const readThere = (resource = OTHER_WS) => requestCapability(PRINCIPAL, ask({ provider: 'buildd', access: 'read', resource, reason: 'compare failure rates' }));

  it('is a person-decided request, never auto-granted, even though it is a read', async () => {
    const out = await readThere();
    expect(out.ok && out.resolution.kind).toBe('pending_approval');
    expect(T.grants[0]).toMatchObject({ capability: 'analytics:read', provider: 'buildd', resource: OTHER_WS, risk: 'read', status: 'pending' });
  });

  it('an approval writes the task delegation, so "grant read and retry" is one action; a repeat ask is existing', async () => {
    const out = await readThere();
    const row = (await loadGrant(out.ok ? out.grant!.id : ''))!;
    expect((await decideCapabilityRequest(row, 'approve', ADMIN)).ok).toBe(true);
    expect(T.tasks[0].delegation).toMatchObject({ grants: [{ workspaceId: OTHER_WS, capabilities: ['analytics:read'] }], capabilityGrantIds: [row.id] });
    const again = await readThere();
    expect(again.ok && again.resolution.kind).toBe('existing');
    await decideCapabilityRequest((await loadGrant(row.id))!, 'revoke', ADMIN);
    expect(T.tasks[0].delegation).toBeNull();
  });

  it('another team is forbidden; the legacy capability name still maps to provider buildd', async () => {
    const out = await readThere(FOREIGN_WS);
    expect(out.ok && out.resolution.kind).toBe('forbidden');
    expect(parseCapabilityRequest({ capability: 'analytics:read', resource: OTHER_WS })).toMatchObject({ ok: true, request: { provider: 'buildd', access: 'read', capability: 'analytics:read' } });
    expect(parseCapabilityRequest({ capability: 'analytics:read', access: 'write', resource: OTHER_WS }).ok).toBe(false);
  });
});

describe('a pending request whose run ended is closed on read', () => {
  it('task ended: the row closes with the reason an approval would give, before anyone clicks', async () => {
    const g = await pending();
    T.tasks[0].status = 'completed';
    await expireLapsedTeamGrants(TEAM);
    expect(await loadGrant(g.id)).toMatchObject({ status: 'expired', decidedBy: 'system', decisionReason: 'task_terminal' });
  });

  it('agent run stopped: closed as worker_not_live; Settings reads it closed', async () => {
    const g = await pending();
    T.workers[0].status = 'failed';
    const rows = await listTeamRequests(TEAM);
    expect(rows.find(r => r.id === g.id)).toMatchObject({ status: 'expired', decisionReason: 'worker_not_live' });
  });

  it('a live run keeps its request pending', async () => {
    const g = await pending();
    await expireLapsedTeamGrants(TEAM);
    expect((await loadGrant(g.id))!.status).toBe('pending');
  });

  it('a decision made first wins: a closed-run sweep never overwrites it', async () => {
    const g = await pending();
    await decideCapabilityRequest(g, 'deny', ADMIN);
    T.tasks[0].status = 'completed';
    await expireLapsedTeamGrants(TEAM);
    expect((await loadGrant(g.id))!.status).toBe('denied');
  });
});

// ── Access granted when the task was filed, and standing grants per role ─────

describe('access filed with the task', () => {
  const NEON_READ = { provider: 'neon', access: 'read' as const, reason: 'count failed runs' };
  const filedDelegation = () => withTaskAccess(null, stampTaskAccess([NEON_READ], 'user-filer'), { userId: 'user-filer' });
  const policy = (over: Record<string, unknown>) => ({ teamId: TEAM, provider: 'neon', risk: 'read', workspaceId: null, roleSlug: null, environment: null, resource: null, maxTtlSeconds: null, ...over });

  it('a person filed Neon read: the first query finds a grant with no request made by the agent', async () => {
    T.tasks[0].delegation = filedDelegation();
    const out = await findDatabaseQueryGrant(PRINCIPAL);
    expect(out.ok).toBe(true);
    expect(T.grants).toHaveLength(1);
    expect(T.grants[0]).toMatchObject({ status: 'granted', decidedBy: 'human', decidedByUserId: 'user-filer', decisionReason: 'filed_with_task', capability: 'database.query', workerId: WORKER });
    expect(audit.find(a => a.capability === 'capability.request')).toMatchObject({ decision: 'allowed', reasonCode: 'auto_granted:filed_with_task' });
    // A second query reuses it.
    expect((await findDatabaseQueryGrant(PRINCIPAL)).ok).toBe(true);
    expect(T.grants).toHaveLength(1);
  });

  it('nothing filed: the query is refused no_grant and nothing is written', async () => {
    expect(await findDatabaseQueryGrant(PRINCIPAL)).toEqual({ ok: false, reasonCode: 'no_grant' });
    expect(T.grants).toHaveLength(0);
  });

  it('a filed grant answers an ask that team policy would leave to a person, but never a write', async () => {
    T.policies = [policy({ id: 'p-team', effect: 'ask_human' })];
    T.tasks[0].delegation = filedDelegation();
    const read = await requestCapability(PRINCIPAL, ask({ provider: 'neon', access: 'read' }));
    expect(read.ok && read.resolution).toMatchObject({ kind: 'auto_granted', reasonCode: 'filed_with_task' });
    // A write goes to the Neon connector (none here) and is never answered by the filed read.
    const write = await requestCapability(PRINCIPAL, ask({ provider: 'neon', access: 'write' }));
    expect(write.ok && write.resolution.kind).not.toBe('auto_granted');
    expect(T.grants.filter(g => g.status === 'granted')).toHaveLength(1);
  });

  it('never past a forbid', async () => {
    T.policies = [policy({ id: 'p-forbid', effect: 'forbidden' })];
    T.tasks[0].delegation = filedDelegation();
    const out = await requestCapability(PRINCIPAL, ask({ provider: 'neon', access: 'read' }));
    expect(out.ok && out.resolution.kind).toBe('forbidden');
    expect((await findDatabaseQueryGrant(PRINCIPAL)).ok).toBe(false);
  });

  it('granted from the task page while an ask waited: the next ask decides that same row', async () => {
    const first = await requestCapability(PRINCIPAL, ask({ provider: 'neon', access: 'read' }));
    expect(first.ok && first.resolution.kind).toBe('pending_approval');
    T.tasks[0].delegation = filedDelegation();
    const again = await requestCapability(PRINCIPAL, ask({ provider: 'neon', access: 'read' }));
    expect(again.ok && again.resolution.kind).toBe('auto_granted');
    expect(T.grants).toHaveLength(1);
    expect(T.grants[0]).toMatchObject({ status: 'granted', decisionReason: 'filed_with_task' });
  });

  it('a retry inherits the grant; another task of the same workspace does not', async () => {
    const RETRY = '77777777-7777-4777-8777-777777777777';
    const OTHER_TASK = '88888888-8888-4888-8888-888888888888';
    T.tasks[0].delegation = filedDelegation();
    T.tasks.push(
      { id: RETRY, workspaceId: WS, status: 'in_progress', roleSlug: 'builder', delegation: inheritTaskDelegation({ id: TASK, delegation: T.tasks[0].delegation }), updatedAt: new Date(0) },
      { id: OTHER_TASK, workspaceId: WS, status: 'in_progress', roleSlug: 'builder', delegation: null, updatedAt: new Date(0) },
    );
    T.workers.push({ id: 'w-retry', status: 'running' }, { id: 'w-other', status: 'running' });
    expect((await findDatabaseQueryGrant({ ...PRINCIPAL, taskId: RETRY, workerId: 'w-retry' })).ok).toBe(true);
    expect((await findDatabaseQueryGrant({ ...PRINCIPAL, taskId: OTHER_TASK, workerId: 'w-other' })).ok).toBe(false);
  });

  it('taking the filed access back revokes what runs hold from it', async () => {
    T.tasks[0].delegation = filedDelegation();
    expect((await findDatabaseQueryGrant(PRINCIPAL)).ok).toBe(true);
    T.tasks[0].delegation = null;
    await revokeFiledGrants(TASK, []);
    expect(T.grants[0].status).toBe('revoked');
    expect((await findDatabaseQueryGrant(PRINCIPAL)).ok).toBe(false);
  });
});

describe('standing grants per role (role policy > team policy)', () => {
  const policy = (over: Record<string, unknown>) => ({ teamId: TEAM, provider: 'neon', risk: 'read', workspaceId: null, environment: null, resource: null, maxTtlSeconds: null, ...over });

  it('researcher: auto-grant by role policy, recorded as such; builder: the team policy asks a person', async () => {
    T.policies = [policy({ id: 'p-role', roleSlug: 'researcher', effect: 'auto_grant' }), policy({ id: 'p-team', roleSlug: null, effect: 'ask_human' })];
    T.tasks[0].roleSlug = 'researcher';
    const r = await requestCapability(PRINCIPAL, ask({ provider: 'neon', access: 'read' }));
    expect(r.ok && r.resolution).toMatchObject({ kind: 'auto_granted', reasonCode: 'role_policy_auto_grant' });
    expect(T.grants[0]).toMatchObject({ status: 'granted', decidedBy: 'policy', decisionReason: 'role_policy_auto_grant' });
    expect(audit.at(-1)).toMatchObject({ capability: 'capability.request', decision: 'allowed', reasonCode: 'auto_granted:role_policy_auto_grant' });

    T.grants = [];
    T.tasks[0].roleSlug = 'builder';
    const b = await requestCapability(PRINCIPAL, ask({ provider: 'neon', access: 'read' }));
    expect(b.ok && b.resolution.kind).toBe('pending_approval');
  });

  it('a team-wide auto-grant keeps its own reason', async () => {
    T.policies = [policy({ id: 'p-team', roleSlug: null, effect: 'auto_grant' })];
    const r = await requestCapability(PRINCIPAL, ask({ provider: 'neon', access: 'read' }));
    expect(r.ok && r.resolution.reasonCode).toBe('policy_auto_grant');
  });
});
