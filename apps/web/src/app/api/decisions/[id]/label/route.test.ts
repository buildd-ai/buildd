import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';

/**
 * POST /api/decisions/[id]/label (MCP label_decision) and GET /api/decisions/[id]
 * (MCP get_decision): who may grade a decision. Synthetic ids only.
 */

const DECISION_ID = '11111111-1111-4111-8111-111111111111';
const TEAM_A = 'team-a';
const TEAM_B = 'team-b';

let user: { id: string; email?: string } | null;
let account: { id: string; teamId: string; level: string; scopes: null } | null;
let teamRole: string | null;
let platformAdmins: Set<string>;
let operators: Set<string>;
let record: Record<string, unknown> | null;
let auditCalls: unknown[];

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: async () => user }));
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: async () => account }));
mock.module('@/lib/team-access', () => ({ getUserTeamRole: async () => teamRole }));
// The real rule for run_experiments: owner or admin, or an admin-level key of the team.
mock.module('@/lib/permissions', () => ({
  can: async (caller: { kind: string; level?: string; teamId?: string }, permission: string, teamId: string) =>
    permission === 'run_experiments' && (caller.kind === 'account' ? caller.level === 'admin' && caller.teamId === teamId : teamRole === 'owner' || teamRole === 'admin'),
}));
mock.module('@/lib/platform-admin', () => ({ isPlatformAdminAccount: (id: string) => platformAdmins.has(id) }));
mock.module('@/lib/platform-operator', () => ({ isPlatformOperator: (u: { email?: string } | null) => !!u?.email && operators.has(u.email) }));
mock.module('@buildd/core/db/schema', () => ({ decisionRecords: { id: 'decision_records.id' } }));
mock.module('drizzle-orm', () => ({ eq: (f: unknown, v: unknown) => ({ f, v }) }));
mock.module('@buildd/core/db', () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit: async () => (record ? [record] : []) }) }) }) },
}));
mock.module('@/lib/decision-audit-bundle', () => ({ loadDecisionAuditBundle: async (r: { id: string }) => ({ decision: { id: r.id } }) }));

const real = await import('@buildd/core/decision-feature-health');
mock.module('@buildd/core/decision-feature-health', () => ({
  ...real,
  labelDecisionAudit: async (input: unknown) => { auditCalls.push(input); return { ok: true, label: 'recorded' }; },
}));

const { POST } = await import('./route');
const { GET } = await import('../route');

const post = (body: unknown, key: string | null = 'bld_key') =>
  new NextRequest(`http://localhost/api/decisions/${DECISION_ID}/label`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify(body),
  });
const get = (key: string | null = 'bld_key') =>
  new NextRequest(`http://localhost/api/decisions/${DECISION_ID}`, { headers: key ? { authorization: `Bearer ${key}` } : {} });
const params = (id = DECISION_ID) => ({ params: Promise.resolve({ id }) });
const good = { label: 'right', rationale: 'The task shipped a code PR, so builder was right.', ruleLabel: 'wrong' };

beforeEach(() => {
  user = null;
  account = { id: 'acct-a', teamId: TEAM_A, level: 'admin', scopes: null };
  teamRole = null;
  platformAdmins = new Set();
  operators = new Set();
  record = { id: DECISION_ID, teamId: TEAM_A, capability: 'task_role_shadow', status: 'applied', verdict: 'builder', ruleAnswer: null, appliedAnswer: 'builder' };
  auditCalls = [];
});

describe('POST /api/decisions/[id]/label', () => {
  it('a team admin key labels its own team\'s decision', async () => {
    const res = await POST(post(good), params());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, decisionId: DECISION_ID, label: 'recorded' });
    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0]).toMatchObject({ label: 'right', ruleLabel: 'wrong', record: { id: DECISION_ID, teamId: TEAM_A } });
  });

  it("a team admin key cannot label another team's decision, and is told nothing about it", async () => {
    record = { ...record!, teamId: TEAM_B };
    const res = await POST(post(good), params());
    expect(res.status).toBe(404);
    expect(auditCalls).toHaveLength(0);
  });

  it('the platform owner labels any team\'s decision', async () => {
    record = { ...record!, teamId: TEAM_B };
    platformAdmins.add('acct-a');
    expect((await POST(post(good), params())).status).toBe(200);
  });

  it('a platform-listed account below admin level is not the platform owner', async () => {
    record = { ...record!, teamId: TEAM_B };
    platformAdmins.add('acct-a');
    account = { ...account!, level: 'worker' };
    expect((await POST(post(good), params())).status).toBe(404);
  });

  it('a worker key on the decision\'s own team is forbidden', async () => {
    account = { ...account!, level: 'worker' };
    expect((await POST(post(good), params())).status).toBe(403);
    expect(auditCalls).toHaveLength(0);
  });

  it('a signed-in team admin labels; a member is forbidden; a stranger gets not found', async () => {
    account = null;
    user = { id: 'u1' };
    teamRole = 'admin';
    expect((await POST(post(good, null), params())).status).toBe(200);
    teamRole = 'member';
    expect((await POST(post(good, null), params())).status).toBe(403);
    teamRole = null;
    expect((await POST(post(good, null), params())).status).toBe(404);
  });

  it('a signed-in platform operator labels any team\'s decision', async () => {
    account = null;
    user = { id: 'u1', email: 'op@example.com' };
    operators.add('op@example.com');
    record = { ...record!, teamId: TEAM_B };
    expect((await POST(post(good, null), params())).status).toBe(200);
  });

  it('401 with no credential, 404 for a malformed or unknown id', async () => {
    account = null;
    expect((await POST(post(good, null), params())).status).toBe(401);
    account = { id: 'acct-a', teamId: TEAM_A, level: 'admin', scopes: null };
    expect((await POST(post(good), params('nope'))).status).toBe(404);
    record = null;
    expect((await POST(post(good), params())).status).toBe(404);
  });

  it('400 for a label outside right / wrong / unsure, or a missing or long rationale', async () => {
    expect((await POST(post({ ...good, label: 'maybe' }), params())).status).toBe(400);
    expect((await POST(post({ ...good, rationale: '' }), params())).status).toBe(400);
    expect((await POST(post({ ...good, rationale: 'x'.repeat(281) }), params())).status).toBe(400);
    expect((await POST(post({ ...good, ruleLabel: 'nah' }), params())).status).toBe(400);
    expect(auditCalls).toHaveLength(0);
  });
});

describe('GET /api/decisions/[id]', () => {
  it('returns the judging bundle to a team admin of the decision\'s team', async () => {
    const res = await GET(get(), params());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ decision: { id: DECISION_ID } });
  });

  it("is not found for another team's admin", async () => {
    record = { ...record!, teamId: TEAM_B };
    expect((await GET(get(), params())).status).toBe(404);
  });
});
