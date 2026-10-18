import { describe, it, expect } from 'bun:test';
import {
  agentPrCandidates,
  orphanNeedsYouNote,
  sweepOrphanAgentPrs,
  taskPrefixFromHead,
  type OpenGithubPr,
  type OrphanSweepDeps,
  type OrphanTask,
  type SweptWorkspace,
} from './orphan-pr-sweep';

const NOW = new Date('2026-10-18T16:00:00Z');
const OLD = '2026-10-18T13:00:00Z';
const WS: SweptWorkspace = { id: 'ws-1', teamId: 'team-1', fullName: 'owner/repo', installationId: 1 };
const TASK: OrphanTask = { id: 'aaaabbbb-0000-0000-0000-000000000000', title: 'Slice 8', missionId: 'm-1', accountId: 'acct-1' };

function pr(number: number, ref: string, over: Partial<OpenGithubPr> = {}): OpenGithubPr {
  return {
    number,
    html_url: `https://github.com/owner/repo/pull/${number}`,
    created_at: OLD,
    head: { ref, repo: { full_name: 'owner/repo' } },
    base: { ref: 'dev' },
    ...over,
  };
}

function fakeDeps(open: OpenGithubPr[], owned: number[], tasksByPrefix: Record<string, OrphanTask | null> = { aaaabbbb: TASK }) {
  const ownedSet = new Set(owned);
  const adopted: number[] = [];
  const filed: Array<{ prNumber: number; taskId: string; ownerWorkerId: string }> = [];
  const deps: OrphanSweepDeps = {
    listWorkspaces: async () => [WS],
    listOpenPrs: async () => open,
    ownedPrNumbers: async (_ws, numbers) => new Set(numbers.filter(n => ownedSet.has(n))),
    findTaskByPrefix: async (_ws, prefix) => tasksByPrefix[prefix] ?? null,
    adopt: async (_ws, _task, p) => {
      adopted.push(p.number);
      ownedSet.add(p.number);
      return `owner-${p.number}`;
    },
    fileNeedsYou: async (_ws, task, p, ownerWorkerId) => { filed.push({ prNumber: p.number, taskId: task.id, ownerWorkerId }); },
  };
  return { deps, adopted, filed };
}

describe('taskPrefixFromHead', () => {
  it('reads the task prefix of a buildd/<task8>- head', () => {
    expect(taskPrefixFromHead('buildd/2894ff22-perf-api-change-version')).toBe('2894ff22');
  });
  it('ignores other heads', () => {
    expect(taskPrefixFromHead('feature/x')).toBeNull();
    expect(taskPrefixFromHead('buildd/mission-abc')).toBeNull();
    expect(taskPrefixFromHead(null)).toBeNull();
  });
});

describe('agentPrCandidates', () => {
  it('keeps agent PRs of this repo old enough to judge', () => {
    const got = agentPrCandidates([
      pr(1, 'buildd/aaaabbbb-x'),
      pr(2, 'feature/y'),
      pr(3, 'buildd/aaaabbbb-z', { head: { ref: 'buildd/aaaabbbb-z', repo: { full_name: 'fork/repo' } } }),
      pr(4, 'buildd/aaaabbbb-new', { created_at: '2026-10-18T15:50:00Z' }),
    ], 'Owner/Repo', NOW);
    expect(got.map(p => p.number)).toEqual([1]);
  });
});

describe('sweepOrphanAgentPrs', () => {
  it('adopts an open buildd/* PR no worker or delivery holds and files one needs-you item', async () => {
    const { deps, adopted, filed } = fakeDeps(
      [pr(5157, 'buildd/aaaabbbb-change-version'), pr(5195, 'buildd/aaaabbbb-rest-of-slice')],
      [5195],
    );
    const res = await sweepOrphanAgentPrs(NOW, deps);
    expect(adopted).toEqual([5157]);
    expect(filed).toEqual([{ prNumber: 5157, taskId: TASK.id, ownerWorkerId: 'owner-5157' }]);
    expect(res).toMatchObject({ openAgentPrs: 2, orphans: 1, adopted: 1, unattributed: 0, errors: 0 });
  });

  it('files the item once: the adopted PR is owned on the next sweep', async () => {
    const { deps, filed } = fakeDeps([pr(5157, 'buildd/aaaabbbb-change-version')], []);
    await sweepOrphanAgentPrs(NOW, deps);
    const second = await sweepOrphanAgentPrs(NOW, deps);
    expect(filed).toHaveLength(1);
    expect(second.orphans).toBe(0);
  });

  it('leaves a PR whose prefix names no single task alone, and counts it', async () => {
    const { deps, adopted, filed } = fakeDeps([pr(9, 'buildd/ccccdddd-x')], [], {});
    const res = await sweepOrphanAgentPrs(NOW, deps);
    expect(adopted).toEqual([]);
    expect(filed).toEqual([]);
    expect(res.unattributed).toBe(1);
  });

  it('files no item when adoption wrote no row', async () => {
    const { deps, filed } = fakeDeps([pr(9, 'buildd/aaaabbbb-x')], []);
    deps.adopt = async () => null;
    const res = await sweepOrphanAgentPrs(NOW, deps);
    expect(filed).toEqual([]);
    expect(res.errors).toBe(1);
  });

  it('a workspace GitHub will not list is an error, not a crash', async () => {
    const { deps } = fakeDeps([], []);
    deps.listOpenPrs = async () => { throw new Error('GitHub 502'); };
    const res = await sweepOrphanAgentPrs(NOW, deps);
    expect(res.errors).toBe(1);
  });
});

describe('orphanNeedsYouNote', () => {
  it('names the PR, the task\'s other open PRs and the three choices', () => {
    const note = orphanNeedsYouNote({ number: 5170, url: 'https://github.com/owner/repo/pull/5170', head: 'buildd/aaaabbbb-mcp' }, [{ number: 5195 }]);
    expect(note.title).toContain('PR #5170');
    expect(note.body).toContain('#5195');
    expect(note.body).toContain('request_pr_review');
    expect(note.body).toContain('record_pr_supersession');
    expect(note.body).toContain('Abandon PR');
  });
});
