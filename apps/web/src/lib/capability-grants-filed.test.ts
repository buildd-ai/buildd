/**
 * Access declared at filing: the claim gate (filed grant > role policy > team
 * policy), a person's grant and take-back on the task, and the Needs You card.
 */
import { describe, it, expect, beforeEach, mock } from 'bun:test';

type Row = Record<string, any>;
const T: { tasks: Row[]; workspaces: Row[] } = { tasks: [], workspaces: [] };

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workspaces: { findFirst: async () => T.workspaces[0] },
      tasks: { findFirst: async () => (T.tasks[0] ? { ...T.tasks[0] } : undefined) },
    },
    update: () => ({ set: (v: Row) => ({ where: () => ({ returning: async () => { Object.assign(T.tasks[0], v); return [{ id: T.tasks[0].id }]; } }) }) }),
  },
}));
const revoked: Array<{ taskId: string; still: readonly string[] }> = [];
mock.module('./capability-grants-store', () => ({
  loadPolicyRules: async () => [],
  revokeFiledGrants: async (taskId: string, still: readonly string[]) => { revoked.push({ taskId, still }); return 0; },
}));
mock.module('./caller-cache', () => ({ clearCallerCache: async () => {}, callerDep: { task: (id: string) => `task:${id}` } }));

const { checkAccessGate, setTaskFiledAccess, filedAccessNeedsYouItems, policyAutoGrantsRead } = await import('./capability-grants-filed');
const { readTaskAccessGrants, stampTaskAccess, withTaskAccess } = await import('@buildd/core/token-delegation');

const WS = '33333333-3333-4333-8333-333333333333';
const NEED = { provider: 'neon', access: 'read' as const, reason: 'count failed runs' };
const rule = (over: Record<string, unknown>) => ({ provider: 'neon', risk: 'read' as const, workspaceId: null, roleSlug: null, environment: null, resource: null, maxTtlSeconds: null, effect: 'ask_human' as const, ...over });
const task = (over: Row = {}) => ({ id: 'task-1', workspaceId: WS, roleSlug: 'builder', context: { accessNeeds: [NEED] }, delegation: null, ...over });

beforeEach(() => {
  T.workspaces = [{ id: WS, teamId: 'team-a' }];
  T.tasks = [];
  revoked.length = 0;
});

describe('checkAccessGate', () => {
  it('an agent filed a need and nobody granted it: held, naming the access and the reason', async () => {
    const out = await checkAccessGate(task(), async () => [rule({})]);
    expect(out?.gaps).toEqual([NEED]);
    expect(out?.detail).toContain('neon read');
    expect(out?.detail).toContain('count failed runs');
  });

  it('a person granted it: claimable', async () => {
    const delegation = withTaskAccess(null, stampTaskAccess([NEED], 'user-1'), { userId: 'user-1' });
    expect(await checkAccessGate(task({ delegation }), async () => [rule({})])).toBeNull();
  });

  it('role policy auto-grants for researcher, team policy asks: the researcher task starts, the builder task waits', async () => {
    const rules = [rule({ id: 'r', roleSlug: 'researcher', effect: 'auto_grant' }), rule({ id: 't', effect: 'ask_human' })];
    expect(await checkAccessGate(task({ roleSlug: 'researcher' }), async () => rules)).toBeNull();
    expect((await checkAccessGate(task({ roleSlug: 'builder' }), async () => rules))?.gaps).toHaveLength(1);
    expect(policyAutoGrantsRead(rules, 'neon', WS, 'researcher')).toBe(true);
    expect(policyAutoGrantsRead(rules, 'neon', WS, 'builder')).toBe(false);
  });

  it('a role rule forbidding it beats a team auto-grant', async () => {
    const rules = [rule({ id: 'r', roleSlug: 'builder', effect: 'forbidden' }), rule({ id: 't', effect: 'auto_grant' })];
    expect((await checkAccessGate(task(), async () => rules))?.gaps).toHaveLength(1);
  });

  it('no declared need: no read at all', async () => {
    let read = false;
    expect(await checkAccessGate(task({ context: {} }), async () => { read = true; return []; })).toBeNull();
    expect(read).toBe(false);
  });
});

describe('setTaskFiledAccess', () => {
  it('writes the grant on the delegation, keeps workspace grants, and revokes what is taken back', async () => {
    const OTHER = '44444444-4444-4444-8444-444444444444';
    T.tasks = [{ id: 'task-1', updatedAt: new Date(0), delegation: { grants: [{ workspaceId: OTHER, capabilities: ['tasks:create'] }], grantedByUserId: 'u0', grantedByAccountId: null, grantedAt: '2026-01-01T00:00:00Z' } }];
    const out = await setTaskFiledAccess('task-1', [NEED], 'user-admin');
    expect(out.ok).toBe(true);
    expect(readTaskAccessGrants(T.tasks[0].delegation)).toMatchObject([{ provider: 'neon', grantedByUserId: 'user-admin' }]);
    expect(T.tasks[0].delegation.grants).toHaveLength(1);
    expect(revoked.at(-1)).toEqual({ taskId: 'task-1', still: ['neon'] });

    await setTaskFiledAccess('task-1', [], 'user-admin');
    expect(readTaskAccessGrants(T.tasks[0].delegation)).toEqual([]);
    expect(T.tasks[0].delegation.grants).toHaveLength(1);
    expect(revoked.at(-1)).toEqual({ taskId: 'task-1', still: [] });
  });
});

describe('filedAccessNeedsYouItems', () => {
  const row = (over: Row = {}) => ({ id: 'task-1', title: 'Weekly failure review', workspaceId: WS, workspaceName: 'buildd', roleSlug: 'researcher', context: { accessNeeds: [NEED] }, delegation: null, ...over });

  it('one card per held task, naming the task, the access and the reason, linking to the grant', () => {
    const [item] = filedAccessNeedsYouItems([row()]) as any[];
    expect(item).toMatchObject({ kind: 'access', taskId: 'task-1', fixLabel: 'Grant' });
    expect(item.accessAsk).toContain('Read');
    expect(item.failureMessage).toContain('Weekly failure review');
    expect(item.failureMessage).toContain('count failed runs');
    expect(item.fixHref).toBe('/app/tasks/task-1#task-filed-access');
    expect(item.accessRequestId).toBeUndefined();
  });

  it('nothing once granted', () => {
    const delegation = withTaskAccess(null, stampTaskAccess([NEED], 'u'), { userId: 'u' });
    expect(filedAccessNeedsYouItems([row({ delegation })])).toEqual([]);
  });

  it('two held tasks are two Home cards, each opening its own task to grant', async () => {
    const { buildActionQueue } = await import('./action-queue');
    const { deriveHomeAttention } = await import('./home-attention');
    const queue = buildActionQueue(filedAccessNeedsYouItems([row(), row({ id: 'task-2', title: 'Second review' })]), []);
    expect(queue.filter(q => q.chip === 'ACCESS')).toHaveLength(2);
    const home = deriveHomeAttention({ queue, missions: [], questions: [], held: [], isActionable: () => true });
    expect(home.map(h => h.primary)).toEqual(expect.arrayContaining([
      { label: 'Grant', href: '/app/tasks/task-1#task-filed-access' },
      { label: 'Grant', href: '/app/tasks/task-2#task-filed-access' },
    ]));
  });
});
