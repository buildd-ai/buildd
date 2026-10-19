/**
 * Regression: a task in one workspace was authorized by its owner to write a
 * spec and then file follow-up tasks in another workspace of the same team.
 * Its per-task token reached only its own workspace, so it found out when the
 * filing was refused, parked on a question and ended; its continuation asked
 * the same question again.
 *
 * Real tokens, real authentication (lib/task-token-auth.ts), the real claim
 * pre-flight (lib/task-delegation-checks.ts) and the real continuation builder
 * (lib/answer-resume.ts); only the database and team access are stubbed.
 */
import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';

const TEAM = 'team-1';
const HOME_WS = '00000000-0000-4000-8000-0000000000a1';    // where the task lives
const TARGET_WS = '00000000-0000-4000-8000-0000000000b2';  // where it must file
const SIBLING_WS = '00000000-0000-4000-8000-0000000000c3'; // same team, not granted
const FOREIGN_WS = '00000000-0000-4000-8000-0000000000d4'; // another team
const TASK = '00000000-0000-4000-8000-0000000000f6';

const WORKSPACES = [
  { id: HOME_WS, teamId: TEAM }, { id: TARGET_WS, teamId: TEAM }, { id: SIBLING_WS, teamId: TEAM }, { id: FOREIGN_WS, teamId: 'team-2' },
];
const GRANT = {
  grants: [{ workspaceId: TARGET_WS, capabilities: ['tasks:create'] }],
  grantedByUserId: 'user-owner', grantedByAccountId: null, grantedAt: '2026-01-01T00:00:00Z',
};

let account: Record<string, unknown>;
let taskRow: Record<string, unknown>;
let accountReaches: (ws: string, permission?: string) => boolean;

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      accounts: { findFirst: async () => account },
      tasks: { findFirst: async () => taskRow },
      taskSchedules: { findFirst: async () => null },
      workspaces: {
        findMany: async (args: { where: unknown }) => {
          if (typeof args.where === 'function') {
            const ids = (args.where as any)({ id: 'id' }, { inArray: (_c: unknown, v: string[]) => v }) as string[];
            return WORKSPACES.filter(w => ids.includes(w.id));
          }
          return WORKSPACES;
        },
      },
    },
  },
}));
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: async () => null }));
mock.module('@/lib/team-access', () => ({
  verifyAccountWorkspaceAccess: async (_a: unknown, ws: string, permission?: string) => accountReaches(ws, permission),
  verifyWorkspaceAccess: async () => ({ role: 'member' }),
}));

const { mintTaskToken } = await import('./task-token');
const { authenticateTaskScopedCaller, taskScopeAllowsDelegated } = await import('./task-token-auth');
const { preflightTaskDelegation, delegationGrantOffer, resolveTaskDelegationWrite } = await import('./task-delegation-checks');
const { buildContinuationTaskValues } = await import('./answer-resume');
const { checkDelegationGate } = await import('@/app/api/workers/claim/delegation-gate');

const savedSecret = process.env.AUTH_SECRET;
afterAll(() => {
  if (savedSecret === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = savedSecret;
});

const token = () => mintTaskToken({ accountId: 'acct-runner', taskId: TASK, workspaceId: HOME_WS, keyHash: 'hash-runner' })!.token;

beforeEach(() => {
  process.env.AUTH_SECRET = 'scenario-secret';
  account = { id: 'acct-runner', teamId: TEAM, level: 'worker', apiKey: 'hash-runner', scopes: null, workspaceIds: null, expiresAt: null };
  taskRow = { id: TASK, workspaceId: HOME_WS, scheduleId: null, delegation: GRANT, context: { filingTargets: [TARGET_WS] } };
  accountReaches = () => true;
});

describe('a task with its own delegation', () => {
  it('its token files in the granted workspace and nowhere else', async () => {
    const caller = await authenticateTaskScopedCaller(token());
    expect(taskScopeAllowsDelegated(caller!, TARGET_WS, 'tasks:create')).toBe(true);
    expect(taskScopeAllowsDelegated(caller!, TARGET_WS, 'analytics:read')).toBe(false);
    expect(taskScopeAllowsDelegated(caller!, SIBLING_WS, 'tasks:create')).toBe(false);
    expect(caller?.level).toBe('worker');
  });

  it('passes the claim pre-flight', async () => {
    expect(await preflightTaskDelegation(taskRow as any, account as any)).toEqual([]);
  });

  it('a grant naming another team is never carried, and holds the claim', async () => {
    taskRow = { ...taskRow, delegation: { ...GRANT, grants: [{ workspaceId: FOREIGN_WS, capabilities: ['tasks:create'] }] }, context: {} };
    const caller = await authenticateTaskScopedCaller(token());
    expect(taskScopeAllowsDelegated(caller!, FOREIGN_WS, 'tasks:create')).toBe(false);
    expect((await preflightTaskDelegation(taskRow as any, account as any))[0]?.reason).toBe('cross_team');
  });

  it("the minting key's workspace list bounds it: a narrowed key carries no grant past it, and the claim says so first", async () => {
    account = { ...account, workspaceIds: [HOME_WS] };
    const caller = await authenticateTaskScopedCaller(token());
    expect(taskScopeAllowsDelegated(caller!, TARGET_WS, 'tasks:create')).toBe(false);
    const gaps = await preflightTaskDelegation(taskRow as any, account as any);
    expect(gaps).toEqual([{ workspaceId: TARGET_WS, capability: 'tasks:create', reason: 'out_of_token_reach' }]);
  });

  it('a claiming account that cannot create in the target is refused before the run', async () => {
    accountReaches = (_ws, permission) => permission !== 'canCreate';
    const gaps = await preflightTaskDelegation(taskRow as any, account as any);
    expect(gaps[0]).toMatchObject({ workspaceId: TARGET_WS, reason: 'out_of_token_reach' });
  });
});

describe('a task without the grant', () => {
  it('declaring a filing target it was not granted is held at claim with the named reason', async () => {
    taskRow = { ...taskRow, delegation: null };
    expect(await preflightTaskDelegation(taskRow as any, account as any)).toEqual([
      { workspaceId: TARGET_WS, capability: 'tasks:create', reason: 'not_granted' },
    ]);
  });

  it('a grant forged into its context is ignored by the token', async () => {
    taskRow = { ...taskRow, delegation: null, context: { delegation: GRANT, delegations: GRANT.grants } };
    const caller = await authenticateTaskScopedCaller(token());
    expect(caller?.taskScope?.delegations).toBeUndefined();
    expect(taskScopeAllowsDelegated(caller!, TARGET_WS, 'tasks:create')).toBe(false);
  });
});

describe('a task that declares it will read another workspace (readsFrom)', () => {
  const READ_GRANT = { ...GRANT, grants: [{ workspaceId: TARGET_WS, capabilities: ['analytics:read'] }] };
  const reads = { readsFrom: [{ workspaceId: TARGET_WS, capabilities: ['analytics:read'] }] };

  it('with no grant, is held at claim with delegation_unmet and a ready grant for a person (AC-9)', async () => {
    taskRow = { ...taskRow, delegation: null, context: reads };
    expect(await preflightTaskDelegation(taskRow as any, account as any)).toEqual([
      { workspaceId: TARGET_WS, capability: 'analytics:read', reason: 'not_granted' },
    ]);
    const gate = await checkDelegationGate(taskRow as any, account as any);
    expect(gate?.grant).toEqual({ grants: [{ workspaceId: TARGET_WS, capabilities: ['analytics:read'] }] });
    expect(gate?.detail).toContain(`Grant access on the task page (/app/tasks/${TASK})`);
    expect(gate?.detail).toContain(`update_task { taskId: "${TASK}", delegation: {"grants":[{"workspaceId":"${TARGET_WS}","capabilities":["analytics:read"]}]} }`);
  });

  it('I-20: a person is shown the uncovered read, one grant writes it, and a runner with access then claims it', async () => {
    taskRow = { ...taskRow, delegation: null, context: reads };
    // Shown: the task page reads this for a pending task.
    const offer = await delegationGrantOffer(taskRow as any);
    expect(offer?.gaps).toEqual([{ workspaceId: TARGET_WS, capability: 'analytics:read', reason: 'not_granted' }]);
    expect(offer?.grant).toEqual({ grants: [{ workspaceId: TARGET_WS, capabilities: ['analytics:read'] }] });
    expect(await checkDelegationGate(taskRow as any, account as any)).not.toBeNull();

    // The one action: the card PATCHes { delegation: offer.grant }; the route
    // validates it as a person's write and stores what this returns.
    expect((await resolveTaskDelegationWrite(offer!.grant, HOME_WS, null)).ok).toBe(false);
    const write = await resolveTaskDelegationWrite(offer!.grant, HOME_WS, 'user-owner');
    expect(write.ok).toBe(true);
    taskRow = { ...taskRow, delegation: (write as { value: unknown }).value };

    expect(await delegationGrantOffer(taskRow as any)).toBeNull();
    expect(await checkDelegationGate(taskRow as any, account as any)).toBeNull();
    const caller = await authenticateTaskScopedCaller(token());
    expect(taskScopeAllowsDelegated(caller!, TARGET_WS, 'analytics:read')).toBe(true);
  });

  it('I-20: the grant keeps what the task already had', async () => {
    taskRow = { ...taskRow, delegation: GRANT, context: { ...reads, filingTargets: [TARGET_WS] } };
    const offer = await delegationGrantOffer(taskRow as any);
    expect(offer?.grant).toEqual({ grants: [{ workspaceId: TARGET_WS, capabilities: ['tasks:create', 'analytics:read'] }] });
  });

  it('a grant that covers it lets the run start, and its token reads there', async () => {
    taskRow = { ...taskRow, delegation: READ_GRANT, context: reads };
    expect(await checkDelegationGate(taskRow as any, account as any)).toBeNull();
    const caller = await authenticateTaskScopedCaller(token());
    expect(taskScopeAllowsDelegated(caller!, TARGET_WS, 'analytics:read')).toBe(true);
  });

  it('D-3: a granted read needs the claiming account\'s own access, at the claim and on the routes alike', async () => {
    taskRow = { ...taskRow, delegation: READ_GRANT, context: reads };
    accountReaches = (ws) => ws !== TARGET_WS;
    // Held at claim for this runner, with no grant to offer: the grant exists.
    const gate = await checkDelegationGate(taskRow as any, account as any);
    expect(gate?.gaps).toEqual([{ workspaceId: TARGET_WS, capability: 'analytics:read', reason: 'out_of_token_reach' }]);
    expect(gate?.grant).toBeNull();
    // And a token minted from that account would not carry the read either.
    const caller = await authenticateTaskScopedCaller(token());
    expect(taskScopeAllowsDelegated(caller!, TARGET_WS, 'analytics:read')).toBe(false);
  });

  it('D-3: a runner account that has access claims the held task and reads', async () => {
    taskRow = { ...taskRow, delegation: READ_GRANT, context: reads };
    accountReaches = () => true;
    expect(await checkDelegationGate(taskRow as any, account as any)).toBeNull();
    const caller = await authenticateTaskScopedCaller(token());
    expect(taskScopeAllowsDelegated(caller!, TARGET_WS, 'analytics:read')).toBe(true);
  });

  it('D-3: a filing grant needs canCreate on the target for the token too, as the pre-flight asks', async () => {
    accountReaches = (_ws, permission) => permission !== 'canCreate';
    const caller = await authenticateTaskScopedCaller(token());
    expect(taskScopeAllowsDelegated(caller!, TARGET_WS, 'tasks:create')).toBe(false);
  });
});

describe('its continuation', () => {
  const continuationOf = (parent: Record<string, unknown>) => buildContinuationTaskValues({
    task: parent as any,
    workspaceId: HOME_WS,
    workerId: 'worker-1',
    branch: 'buildd/spec',
    milestones: [],
    question: 'May I file the follow-ups in the other workspace?',
    answer: 'Yes, file them there.',
    delivery: { path: 'cold_continuation' } as any,
  });

  it('inherits the grant, so its token reaches the same workspace', async () => {
    const values = continuationOf(taskRow);
    expect(values.delegation).toMatchObject({ grants: GRANT.grants, grantedByUserId: 'user-owner', inheritedFromTaskId: TASK });
    expect(values.context.filingTargets).toEqual([TARGET_WS]);

    taskRow = { id: TASK, workspaceId: HOME_WS, scheduleId: null, delegation: values.delegation, context: values.context };
    const caller = await authenticateTaskScopedCaller(token());
    expect(taskScopeAllowsDelegated(caller!, TARGET_WS, 'tasks:create')).toBe(true);
    expect(await preflightTaskDelegation(taskRow as any, account as any)).toEqual([]);
  });

  it('carries the answered question and its answer, and says not to ask it again', () => {
    const { description } = continuationOf(taskRow);
    expect(description).toContain('May I file the follow-ups in the other workspace?');
    expect(description).toContain('Yes, file them there.');
    expect(description).toContain('do not ask it again');
  });

  it('keeps the declared reads, so the pre-flight still checks them', () => {
    const readsFrom = [{ workspaceId: TARGET_WS, capabilities: ['analytics:read'] }];
    expect(continuationOf({ ...taskRow, context: { readsFrom } }).context.readsFrom).toEqual(readsFrom);
  });

  it('a parent without a grant passes none on', () => {
    expect(continuationOf({ ...taskRow, delegation: null }).delegation).toBeUndefined();
  });
});
