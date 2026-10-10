import { describe, it, expect, beforeEach, mock } from 'bun:test';

const mockGetGrants = mock(() => Promise.resolve([] as any[]));

import { agentRunMayActOnPr, authorizeWorkerPrCapability } from './worker-pr';

// ── fixtures (illustrative) ───────────────────────────────────────────────────

const WORKER = {
  id: 'worker-1', accountId: 'runner-1', taskId: 'task-1', workspaceId: 'ws-1',
  workspace: { id: 'ws-1', teamId: 'team-1' },
};
const RUNNER = { id: 'runner-1', teamId: 'team-1' };
const TEAMMATE = { id: 'person-1', teamId: 'team-1' };
const SHARED_RUNNER = { id: 'runner-1', teamId: 'team-shared' };
const taskToken = (taskId: string, accountId = 'runner-1') => ({
  id: accountId, teamId: 'team-1', taskScope: { taskId, workspaceId: 'ws-1', expiresAt: Date.now() + 60_000 },
});

const authorize = (caller: any, worker: any = WORKER, cap: 'pr.create' | 'pr.adopt' = 'pr.create') =>
  authorizeWorkerPrCapability(caller, worker, cap, mockGetGrants as any);

beforeEach(() => {
  mockGetGrants.mockReset();
  mockGetGrants.mockResolvedValue([]);
});

describe('authorizeWorkerPrCapability', () => {
  it('lets the worker’s own run act, as an agent_run principal', async () => {
    const d = await authorize(RUNNER);
    expect(d.allowed && d.actor).toEqual({
      kind: 'agent_run',
      principal: {
        kind: 'agent_run', via: 'worker_account', workerId: 'worker-1', taskId: 'task-1',
        workspaceId: 'ws-1', teamId: 'team-1', accountId: 'runner-1',
      },
    });
  });

  it('lets a teammate act, classified as team_member, not as the run', async () => {
    const d = await authorize(TEAMMATE);
    expect(d.allowed && d.actor).toEqual({ kind: 'team_member', accountId: 'person-1' });
  });

  it('refuses another team', async () => {
    const d = await authorize({ id: 'other-1', teamId: 'team-2' });
    expect(!d.allowed && d.reasonCode).toBe('not_team_or_runner');
  });

  it('lets a shared runner act through a live canClaim grant, and not without one', async () => {
    expect((await authorize(SHARED_RUNNER)).allowed).toBe(false);
    mockGetGrants.mockResolvedValue([{ workspaceId: 'ws-1', canClaim: true }]);
    const d = await authorize(SHARED_RUNNER);
    expect(d.allowed && d.actor.kind).toBe('agent_run');
  });

  describe('per-task token', () => {
    it('acts for its own task’s worker, via task_token', async () => {
      const d = await authorize(taskToken('task-1'));
      expect(d.allowed && d.actor.kind === 'agent_run' && d.actor.principal.via).toBe('task_token');
    });

    it('refuses another task’s worker even on the same team and account', async () => {
      const d = await authorize(taskToken('task-2'));
      expect(!d.allowed && d.reasonCode).toBe('outside_task_scope');
    });

    it('refuses a worker its minting account did not claim, even though team membership passes', async () => {
      const d = await authorize(taskToken('task-1', 'person-1'));
      expect(!d.allowed && d.reasonCode).toBe('outside_task_scope');
    });
  });

  it('answers both refusals with the route’s one 403 text', async () => {
    const a = await authorize({ id: 'other-1', teamId: 'team-2' });
    const b = await authorize(taskToken('task-2'));
    expect(!a.allowed && [a.status, a.error]).toEqual([403, 'Worker belongs to different account']);
    expect(!b.allowed && [b.status, b.error]).toEqual([403, 'Worker belongs to different account']);
  });

  it('carries the requested capability on the decision', async () => {
    const d = await authorize(RUNNER, WORKER, 'pr.adopt');
    expect(d.allowed && d.capability).toBe('pr.adopt');
  });
});

describe('agentRunMayActOnPr', () => {
  const RUN = { id: 'runner-1', teamId: 'team-1' };
  const worker = (o: Record<string, unknown> = {}, task: Record<string, unknown> = {}) => ({
    accountId: 'runner-1', workspaceId: 'ws-1', taskId: 'task-1', prNumber: 42,
    task: { id: 'task-1', title: 'feat: own thing', description: '', context: {}, roleSlug: 'builder', mode: 'execution', missionId: null, ...task },
    ...o,
  });
  const noLookup = { missionOfPr: mock(async () => 'never') };

  it('lets a run act on its own worker’s PR', async () => {
    expect(await agentRunMayActOnPr(RUN, worker(), 42, noLookup)).toBe(true);
  });
  it('refuses another PR through its own worker', async () => {
    expect(await agentRunMayActOnPr(RUN, worker(), 7, noLookup)).toBe(false);
  });
  const reach = (prNumbers: number[], grantedBy = 'human:user-1') => ({ context: { prReach: { prNumbers, grantedBy, grantedAt: 'x' } } });
  it.each([
    ['retry subject', { ciRetryPrNumber: 7 }],
    ['PR link a person stamped when filing it', reach([7])],
    ['PR link the filing task stamped', reach([7], 'task:task-0')],
  ])('lets a run act on a PR its task records link: %s', async (_l, task) => {
    expect(await agentRunMayActOnPr(RUN, worker({}, task), 7, noLookup)).toBe(true);
  });
  it.each([
    ['title', { title: 'Resolve conflicts and land PR #7' }],
    ['description', { description: 'merge https://github.com/acme/widget/pull/7 once green' }],
    ['context', { context: { prNumber: 7 } }],
    ['unstamped prReach', { context: { prReach: { prNumbers: [7] } } }],
  ])('refuses a PR merely named in its task %s', async (_l, task) => {
    expect(await agentRunMayActOnPr(RUN, worker({}, task), 7, noLookup)).toBe(false);
  });
  it('leaves teammates and people alone', async () => {
    expect(await agentRunMayActOnPr({ id: 'person-1', teamId: 'team-1' }, worker(), 7, noLookup)).toBe(true);
    expect(await agentRunMayActOnPr({ ...RUN, sessionUserId: 'user-1' } as any, worker(), 7, noLookup)).toBe(true);
  });

  describe('orchestration task', () => {
    const orch = (task: Record<string, unknown>) => worker({}, { missionId: 'mission-1', ...task });
    const same = { missionOfPr: async () => 'mission-1' };
    const other = { missionOfPr: async () => 'mission-2' };
    it.each([
      ['organizer role', { roleSlug: 'organizer' }],
      ['planning mode', { mode: 'planning' }],
      ['heartbeat', { context: { heartbeat: true } }],
    ])('acts on a PR of another task on its own mission (%s)', async (_l, task) => {
      expect(await agentRunMayActOnPr(RUN, orch(task), 7, same)).toBe(true);
    });
    it('refuses a PR of another mission', async () => {
      expect(await agentRunMayActOnPr(RUN, orch({ roleSlug: 'organizer' }), 7, other)).toBe(false);
    });
    it('refuses when the PR belongs to no buildd task', async () => {
      expect(await agentRunMayActOnPr(RUN, orch({ roleSlug: 'organizer' }), 7, { missionOfPr: async () => null })).toBe(false);
    });
    it('refuses an orchestration task with no mission unless its records link the PR', async () => {
      const lookup = mock(async () => 'mission-1');
      expect(await agentRunMayActOnPr(RUN, worker({}, { roleSlug: 'organizer' }), 7, { missionOfPr: lookup })).toBe(false);
      expect(lookup).not.toHaveBeenCalled();
      expect(await agentRunMayActOnPr(RUN, worker({}, { roleSlug: 'organizer', title: 'land #7' }), 7, noLookup)).toBe(false);
      expect(await agentRunMayActOnPr(RUN, worker({}, { roleSlug: 'organizer', ...reach([7]) }), 7, noLookup)).toBe(true);
    });
    it('does not let a builder use the mission rule', async () => {
      expect(await agentRunMayActOnPr(RUN, orch({ roleSlug: 'builder' }), 7, same)).toBe(false);
    });
  });

  describe('per-task token', () => {
    const token = (taskId = 'task-1') => ({ ...RUN, taskScope: { taskId, workspaceId: 'ws-1', expiresAt: Date.now() + 60_000 } });
    it('acts on a PR its own task records link', async () => {
      expect(await agentRunMayActOnPr(token(), worker({}, reach([7])), 7, noLookup)).toBe(true);
    });
    it('refuses a PR its own task only names in text', async () => {
      expect(await agentRunMayActOnPr(token(), worker({}, { title: 'land #7' }), 7, noLookup)).toBe(false);
    });
    it('refuses through another task’s worker, even one its account claimed', async () => {
      expect(await agentRunMayActOnPr(token('task-2'), worker({}, reach([7])), 7, noLookup)).toBe(false);
    });
    it('refuses through a worker another account claimed', async () => {
      expect(await agentRunMayActOnPr(token(), worker({ accountId: 'runner-2' }), 42, noLookup)).toBe(false);
    });
  });
});
