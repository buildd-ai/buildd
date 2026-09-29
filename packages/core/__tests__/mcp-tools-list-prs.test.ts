import { describe, it, expect, mock } from 'bun:test';
import { handleBuilddAction, type ApiFn, type ActionContext } from '../mcp-tools';

const ctx: ActionContext = { authType: 'oauth', getWorkspaceId: async () => null, getLevel: async () => 'worker' };

const pr = (over: Record<string, unknown>) => ({
  workerId: 'w', prNumber: 12, prUrl: 'https://github.com/o/r/pull/12', status: 'pr_open', mergedAt: null,
  lastCheckedAt: null, conflictDetectedAt: null, startedAt: '2026-09-27T10:00:00.000Z',
  workspaceId: 'ws-a', workspaceName: 'alpha', taskId: 'aaaaaaaa-1111-4111-8111-111111111111', taskTitle: 'fix(x): thing',
  missionId: null, missionTitle: null, ...over,
});

async function run(params: Record<string, unknown>, body: unknown) {
  const calls: string[] = [];
  const api = mock(async (endpoint: string) => { calls.push(endpoint); return body; });
  const res = await handleBuilddAction(api as unknown as ApiFn, 'list_prs', params, ctx);
  return { text: res.content[0].text as string, isError: res.isError, calls };
}

describe('list_prs', () => {
  it('asks the route for open PRs by default, across workspaces', async () => {
    const { calls } = await run({}, { state: 'open', prs: [] });
    expect(calls[0]).toBe('/api/prs?state=open');
  });

  it('passes state, workspace, window and limit through', async () => {
    const { calls } = await run({ state: 'merged', workspaceId: 'aaaaaaaa-2222-4222-8222-222222222222', sinceDays: 3, limit: 5 }, { state: 'merged', prs: [] });
    expect(calls[0]).toContain('state=merged');
    expect(calls[0]).toContain('sinceDays=3');
    expect(calls[0]).toContain('limit=5');
    expect(calls[0]).toContain('workspaceId=aaaaaaaa-2222-4222-8222-222222222222');
  });

  it('an empty list is one "No …" line, so chat folds it across workspaces', async () => {
    const { text } = await run({}, { state: 'open', prs: [] });
    expect(text).toMatch(/^No open PRs[^\n]*\.$/);
  });

  // Without this the model re-asked workspace by workspace after an empty answer.
  it('says it covered every workspace, so the model does not repeat it per workspace', async () => {
    expect((await run({ state: 'ci_failed' }, { state: 'ci_failed', workspaceCount: 5, prs: [] })).text)
      .toBe('No open PRs in state ci_failed across your 5 workspaces.');
    expect((await run({}, { state: 'open', workspaceCount: 3, prs: [pr({})] })).text.split('\n')[0])
      .toBe('1 open PR across your 3 workspaces:');
    expect((await run({ state: 'merged', sinceDays: 1 }, { state: 'merged', sinceDays: 1, workspaceCount: 1, prs: [] })).text)
      .toBe('No PRs merged in the last day in this workspace.');
  });

  it('one line per PR: number, state, title, workspace, mission, task short id, url', async () => {
    const { text } = await run({}, { state: 'open', prs: [
      pr({ prNumber: 7, status: 'conflict', missionTitle: 'Ship it', conflictDetectedAt: '2026-09-26T10:00:00.000Z' }),
      pr({ prNumber: 8, status: 'ci_running' }),
    ] });
    expect(text.split('\n')[0]).toBe('2 open PRs (1 conflicting):');
    expect(text).toContain('#7 CONFLICT · fix(x): thing · alpha · mission "Ship it" · task aaaaaaaa');
    expect(text).toContain('https://github.com/o/r/pull/12');
    expect(text).toContain('#8 CI running');
  });

  it('merged: names the window', async () => {
    const { text } = await run({ state: 'merged' }, { state: 'merged', sinceDays: 7, prs: [pr({ status: 'merged', mergedAt: '2026-09-27T12:00:00.000Z' })] });
    expect(text.split('\n')[0]).toBe('1 PR merged in the last 7 days:');
    expect(text).toContain('merged 2026-09-27');
  });

  it('closed is refused before any call', async () => {
    const { isError, text, calls } = await run({ state: 'closed' }, {});
    expect(isError).toBe(true);
    expect(text).toContain('get_pr');
    expect(calls).toEqual([]);
  });

  describe('signals, only when they matter', () => {
    it('a quiet PR line has none', async () => {
      const { text } = await run({}, { state: 'open', prs: [pr({})] });
      expect(text).not.toMatch(/NEEDS YOU|fixing|reviewing|→|checked|attempt/);
    });

    it('waiting on you leads the line and counts in the header', async () => {
      const { text } = await run({}, { state: 'open', prs: [pr({ status: 'ci_green', waitingOnYou: 'reviewer escalated' })] });
      expect(text.split('\n')[0]).toBe('1 open PR (1 needs you):');
      expect(text).toContain('#12 NEEDS YOU (reviewer escalated) · CI green ·');
    });

    it('red CI with its fix attempts, and an agent already fixing it', async () => {
      const { text } = await run({}, { state: 'open', prs: [pr({ status: 'ci_failed', ciFixAttempts: 2, resolving: 'ci' })] });
      expect(text).toContain('#12 CI FAILED (2 fix attempts) · agent fixing CI ·');
      const one = await run({}, { state: 'open', prs: [pr({ status: 'ci_failed', ciFixAttempts: 1 })] });
      expect(one.text).toContain('#12 CI FAILED (1 fix attempt) ·');
    });

    it('a conflict being resolved, a review in flight', async () => {
      const { text } = await run({}, { state: 'open', prs: [
        pr({ prNumber: 1, status: 'conflict', resolving: 'conflict' }),
        pr({ prNumber: 2, status: 'ci_green', resolving: 'review' }),
      ] });
      expect(text).toContain('#1 CONFLICT · agent resolving the conflict ·');
      expect(text).toContain('#2 CI green · agent reviewing ·');
    });

    it('a mission-branch base and a stale state', async () => {
      const { text } = await run({}, { state: 'open', prs: [pr({ intoMissionBranch: 'mission/x', checkedHoursAgo: 5 })] });
      expect(text).toContain('→ mission/x');
      expect(text).toContain('state checked 5h ago');
    });
  });
});
