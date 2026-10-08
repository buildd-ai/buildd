import { describe, it, expect, mock, beforeEach } from 'bun:test';

const calls: any[] = [];
mock.module('@/lib/notify', () => ({
  notifyTeam: mock(async (...a: any[]) => { calls.push(['notifyTeam', ...a]); }),
  notifyTeamOf: mock(async () => {}),
}));
// Builders stood in by tagged objects; the real ones are tested in subscriptions.test.ts.
mock.module('@/lib/subscriptions', () => ({
  recordEvent: mock(async (e: any) => { calls.push(['recordEvent', e]); return { recorded: 1 }; }),
  taskCompletedEvent: (a: any) => ({ kind: 'task.completed', ...a }),
  taskFailedEvent: (a: any) => ({ kind: 'task.failed', ...a }),
  taskNeedsInputEvent: (a: any) => ({ kind: 'task.needs_input', ...a }),
  prMergedEvent: (a: any) => ({ kind: 'pr.merged', ...a }),
  prCiFailedEvent: (a: any) => ({ kind: 'pr.ci_failed', ...a }),
}));
mock.module('@buildd/core/report-ops', () => ({ reportOps: mock(async () => {}) }));
mock.module('@/modules', () => ({ SUBSCRIBERS: [] }));

const { emit } = await import('./core-emit');
const { notificationSubscribers } = await import('./notification-subscribers');
const { chatSubscribers } = await import('./chat/subscribers');
const subscribers = [...chatSubscribers, ...notificationSubscribers];

const worker = {
  via: 'worker' as const, taskId: 't-1', workerId: 'w-1', workspaceId: 'ws-1', title: 'Fix the cursor',
  sensitive: false, teamId: 'team-1', workspaceName: 'W', error: null,
};

beforeEach(() => { calls.length = 0; });

describe('notification subscribers', () => {
  it('a merge-completed task writes the ledger row (awaited) and pushes nothing', async () => {
    await emit({ type: 'task.completed', via: 'merge', taskId: 't-1', workerId: 'w-1', workspaceId: 'ws-1' }, { subscribers });
    expect(calls).toEqual([['recordEvent', { kind: 'task.completed', taskId: 't-1', workerId: 'w-1', workspaceId: 'ws-1' }]]);
  });

  it('a sensitive workspace: no title in the ledger, a redacted push', async () => {
    await emit({ type: 'task.failed', ...worker, sensitive: true }, { subscribers });
    expect(calls[0]).toEqual(['recordEvent', { kind: 'task.failed', taskId: 't-1', workerId: 'w-1', title: null, workspaceId: 'ws-1' }]);
    expect(calls[1][3].message).toBe('Task failed (content redacted)');
  });

  it('a sensitive workspace: a retry push carries no title or workspace name', async () => {
    await emit({ type: 'task.retrying', ...worker, sensitive: true }, { subscribers });
    expect(calls).toEqual([['notifyTeam', 'team-1', 'taskFailed', {
      title: 'Task retrying', message: 'Task auto-retrying (content redacted)', url: 'https://buildd.dev/app/tasks/t-1', urlTitle: 'View task', priority: 0,
    }]]);
  });

  it('a sensitive workspace: the dead-credential alert carries no title', async () => {
    await emit({ type: 'task.failed', ...worker, sensitive: true, error: '401 Invalid authentication credentials' }, { subscribers });
    const alert = calls.find(c => c[0] === 'notifyTeam' && c[2] === 'credentialExpired');
    expect(alert[3].message).not.toContain('Fix the cursor');
  });

  it('a dead credential adds its own alert after the failure push', async () => {
    await emit({ type: 'task.failed', ...worker, error: '401 Invalid authentication credentials' }, { subscribers });
    expect(calls.filter(c => c[0] === 'notifyTeam').map(c => c[2])).toEqual(['taskFailed', 'credentialExpired']);
  });

  it('an unknown workspace name reads as unknown', async () => {
    await emit({ type: 'task.retrying', ...worker, workspaceName: null }, { subscribers });
    expect(calls).toEqual([['notifyTeam', 'team-1', 'taskFailed', {
      title: 'Task retrying', message: 'Auto-retrying: Fix the cursor\nunknown', url: 'https://buildd.dev/app/tasks/t-1', urlTitle: 'View task', priority: 0,
    }]]);
  });

  // A task a completion-policy slot failed after its worker reported it done.
  const releaseRed = { slot: 'release' as const, label: 'Release failed' as const, reason: 'CI red on main' };

  it('a slot failure: the ledger row and the failure push carry the slot\'s reason', async () => {
    await emit({ type: 'task.failed', ...worker, failure: releaseRed }, { subscribers });
    expect(calls).toEqual([
      ['recordEvent', { kind: 'task.failed', taskId: 't-1', workerId: 'w-1', title: 'Fix the cursor', workspaceId: 'ws-1', reason: 'Release failed: CI red on main' }],
      ['notifyTeam', 'team-1', 'taskFailed', {
        title: 'Task failed', message: 'Fix the cursor\nW\nRelease failed: CI red on main', url: 'https://buildd.dev/app/tasks/t-1', urlTitle: 'View task', priority: 0,
      }],
    ]);
  });

  it('a slot failure in a sensitive workspace: the fixed label only, never the slot\'s detail', async () => {
    await emit({ type: 'task.failed', ...worker, sensitive: true, failure: releaseRed }, { subscribers });
    expect(calls[0]).toEqual(['recordEvent', { kind: 'task.failed', taskId: 't-1', workerId: 'w-1', title: null, workspaceId: 'ws-1', reason: 'Release failed' }]);
    expect(calls[1][3].message).toBe('Task failed (content redacted)\nRelease failed');
  });

  it('a worker\'s own failure carries no reason line', async () => {
    await emit({ type: 'task.failed', ...worker, error: 'Tests failed' }, { subscribers });
    expect(calls[0][1].reason).toBeUndefined();
    expect(calls[1][3].message).toBe('Fix the cursor\nW');
  });

  it('a held release that resolves green: the ledger row is awaited, the done push and the chat post follow', async () => {
    const chat = mock(async () => {});
    mock.module('@/lib/chat/mission-events', () => ({ postTaskCompletedEvent: chat }));
    await emit({ type: 'task.completed', ...worker, via: 'release' }, { subscribers });
    expect(calls).toEqual([
      ['recordEvent', { kind: 'task.completed', taskId: 't-1', workerId: 'w-1', title: 'Fix the cursor', workspaceId: 'ws-1' }],
      ['notifyTeam', 'team-1', 'taskCompleted', {
        title: 'Task done', message: 'Fix the cursor\nW', url: 'https://buildd.dev/app/tasks/t-1', urlTitle: 'View task', priority: -1,
      }],
    ]);
    await new Promise(r => setTimeout(r, 0));
    expect(chat).toHaveBeenCalledWith({ taskId: 't-1' });
  });

  it('a held release that resolves red: the failure push names the release CI', async () => {
    await emit({
      type: 'task.failed', ...worker, via: 'release',
      failure: { slot: 'release', label: 'Release CI failed', reason: 'CI failed on PR #42' },
    }, { subscribers });
    expect(calls.map(c => c[0])).toEqual(['recordEvent', 'notifyTeam']);
    expect(calls[0][1].reason).toBe('Release CI failed: CI failed on PR #42');
    expect(calls[1][3]).toMatchObject({ title: 'Task failed', message: 'Fix the cursor\nW\nRelease CI failed: CI failed on PR #42' });
  });

  it('PR facts map to their ledger events', async () => {
    await emit({ type: 'pr.merged', repoFullName: 'o/r', prNumber: 7, url: 'https://example.test/pr/7' }, { subscribers });
    await emit({ type: 'pr.ci_failed', repoFullName: 'o/r', prNumber: 7, headSha: 'abc' }, { subscribers });
    expect(calls).toEqual([
      ['recordEvent', { kind: 'pr.merged', repoFullName: 'o/r', prNumber: 7, url: 'https://example.test/pr/7' }],
      ['recordEvent', { kind: 'pr.ci_failed', repoFullName: 'o/r', prNumber: 7, headSha: 'abc' }],
    ]);
  });
});
