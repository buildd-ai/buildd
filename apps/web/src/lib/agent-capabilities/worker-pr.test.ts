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
    accountId: 'runner-1', taskId: 'task-1', prNumber: 42,
    task: { id: 'task-1', title: 'feat: own thing', description: '', context: {}, roleSlug: 'builder', mode: 'execution', ...task },
    ...o,
  });

  it('lets a run act on its own worker’s PR', () => {
    expect(agentRunMayActOnPr(RUN, worker(), 42)).toBe(true);
  });
  it('refuses another PR through its own worker', () => {
    expect(agentRunMayActOnPr(RUN, worker(), 7)).toBe(false);
  });
  it.each([
    ['title', { title: 'Resolve conflicts and land PR #7' }],
    ['description', { description: 'merge https://github.com/acme/widget/pull/7 once green' }],
    ['context', { context: { prNumber: 7 } }],
    ['retry subject', { ciRetryPrNumber: 7 }],
  ])('lets a run act on a PR its task names in its %s', (_l, task) => {
    expect(agentRunMayActOnPr(RUN, worker({}, task), 7)).toBe(true);
  });
  it.each([
    ['organizer role', { roleSlug: 'organizer' }],
    ['planning mode', { mode: 'planning' }],
    ['heartbeat', { context: { heartbeat: true } }],
  ])('exempts an orchestration task (%s)', (_l, task) => {
    expect(agentRunMayActOnPr(RUN, worker({}, task), 7)).toBe(true);
  });
  it('leaves teammates and people alone', () => {
    expect(agentRunMayActOnPr({ id: 'person-1', teamId: 'team-1' }, worker(), 7)).toBe(true);
    expect(agentRunMayActOnPr({ ...RUN, sessionUserId: 'user-1' } as any, worker(), 7)).toBe(true);
  });

  describe('per-task token', () => {
    const token = (taskId = 'task-1') => ({ ...RUN, taskScope: { taskId, workspaceId: 'ws-1', expiresAt: Date.now() + 60_000 } });
    it('acts on a PR its own task names', () => {
      expect(agentRunMayActOnPr(token(), worker({}, { title: 'land #7' }), 7)).toBe(true);
    });
    it('refuses through another task’s worker, even one its account claimed', () => {
      expect(agentRunMayActOnPr(token('task-2'), worker({}, { title: 'land #7' }), 7)).toBe(false);
    });
    it('refuses through a worker another account claimed', () => {
      expect(agentRunMayActOnPr(token(), worker({ accountId: 'runner-2' }), 42)).toBe(false);
    });
  });
});
