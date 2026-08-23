import { beforeEach, describe, expect, it, mock } from 'bun:test';
import {
  checkDriftRatio,
  DEFAULT_SUPERSESSION_DRIFT_RATIO,
} from './supersession-check';
import type { DiffStats, SupersessionResult } from './supersession-check';

// ── Mocks ──────────────────────────────────────────────────────────────────────

// Mock GitHub API — configurable per test
const mockGithubApi = mock(() => Promise.resolve(null) as Promise<unknown>);
mock.module('@/lib/github', () => ({
  githubApi: mockGithubApi,
}));

// Mock DB for findSuccessorPr
const mockTasksFindFirst = mock(() => null as any);
const mockTasksFindMany = mock(() => [] as any[]);
const mockWorkersFindFirst = mock(() => null as any);

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      tasks: {
        findFirst: (...args: any[]) => mockTasksFindFirst(...args),
        findMany: (...args: any[]) => mockTasksFindMany(...args),
      },
      workers: {
        findFirst: (...args: any[]) => mockWorkersFindFirst(...args),
      },
    },
  },
}));

mock.module('@buildd/core/db/schema', () => ({
  tasks: 'tasks',
  workers: 'workers',
}));

mock.module('drizzle-orm', () => ({
  eq: (a: any, b: any) => ({ type: 'eq', a, b }),
  ne: (a: any, b: any) => ({ type: 'ne', a, b }),
  and: (...args: any[]) => ({ type: 'and', args }),
  inArray: (col: any, vals: any[]) => ({ type: 'inArray', col, vals }),
  desc: (col: any) => ({ type: 'desc', col }),
}));

import {
  fetchLivePrStats,
  checkContentAlreadyUpstream,
  findSuccessorPr,
  runSupersessionPrecheck,
} from './supersession-check';

// ── checkDriftRatio ───────────────────────────────────────────────────────────

const ZERO: DiffStats = { filesChanged: 0, linesAdded: 0, linesRemoved: 0 };
const small: DiffStats = { filesChanged: 2, linesAdded: 100, linesRemoved: 11 };
const large: DiffStats = { filesChanged: 64, linesAdded: 21685, linesRemoved: 438 };

describe('checkDriftRatio', () => {
  it('returns false when recorded total is 0', () => {
    expect(checkDriftRatio(ZERO, large, 10)).toBe(false);
  });

  it('returns false below the threshold (lines)', () => {
    const recorded: DiffStats = { filesChanged: 2, linesAdded: 100, linesRemoved: 0 };
    const live: DiffStats = { filesChanged: 4, linesAdded: 900, linesRemoved: 0 };
    // ratio = 9 < 10
    expect(checkDriftRatio(recorded, live, 10)).toBe(false);
  });

  it('returns true at exactly the threshold (lines)', () => {
    const recorded: DiffStats = { filesChanged: 2, linesAdded: 100, linesRemoved: 0 };
    const live: DiffStats = { filesChanged: 4, linesAdded: 1000, linesRemoved: 0 };
    // ratio = 10 ≥ 10
    expect(checkDriftRatio(recorded, live, 10)).toBe(true);
  });

  it('returns true well above threshold — the PR #1697 example', () => {
    // +164/-11 recorded vs +21685/-438 live → lines ratio ≈ 125x
    expect(checkDriftRatio(small, large, 10)).toBe(true);
  });

  it('triggers on file ratio alone when lines ratio is below threshold', () => {
    const recorded: DiffStats = { filesChanged: 2, linesAdded: 10, linesRemoved: 10 };
    const live: DiffStats = { filesChanged: 25, linesAdded: 90, linesRemoved: 10 };
    // lines ratio = 5 < 10, files ratio = 12.5 ≥ 10
    expect(checkDriftRatio(recorded, live, 10)).toBe(true);
  });

  it('skips file ratio when live files ≤ 1', () => {
    const recorded: DiffStats = { filesChanged: 1, linesAdded: 10, linesRemoved: 0 };
    const live: DiffStats = { filesChanged: 1, linesAdded: 50, linesRemoved: 0 };
    // lines ratio = 5, file ratio would be 1 but guard skips it
    expect(checkDriftRatio(recorded, live, 10)).toBe(false);
  });

  it('uses configurable threshold', () => {
    const recorded: DiffStats = { filesChanged: 2, linesAdded: 100, linesRemoved: 0 };
    const live: DiffStats = { filesChanged: 4, linesAdded: 500, linesRemoved: 0 };
    // ratio 5x — below default 10, above custom 4
    expect(checkDriftRatio(recorded, live, 10)).toBe(false);
    expect(checkDriftRatio(recorded, live, 4)).toBe(true);
  });
});

// ── fetchLivePrStats ──────────────────────────────────────────────────────────

describe('fetchLivePrStats', () => {
  beforeEach(() => mockGithubApi.mockReset());

  it('returns stats from GitHub PR response', async () => {
    mockGithubApi.mockResolvedValueOnce({
      changed_files: 5,
      additions: 200,
      deletions: 50,
    });
    const stats = await fetchLivePrStats(1, 'org/repo', 42);
    expect(stats).toEqual({ filesChanged: 5, linesAdded: 200, linesRemoved: 50 });
  });

  it('returns null when GitHub returns null', async () => {
    mockGithubApi.mockResolvedValueOnce(null);
    expect(await fetchLivePrStats(1, 'org/repo', 42)).toBeNull();
  });

  it('returns null on GitHub API error', async () => {
    mockGithubApi.mockRejectedValueOnce(new Error('GitHub down'));
    expect(await fetchLivePrStats(1, 'org/repo', 42)).toBeNull();
  });
});

// ── checkContentAlreadyUpstream ───────────────────────────────────────────────

const PR_RESPONSE = {
  base: { ref: 'dev' },
  head: { sha: 'abc123' },
};

describe('checkContentAlreadyUpstream', () => {
  beforeEach(() => mockGithubApi.mockReset());

  it('returns true when branch commits landed via a different PR (changed_files = 0)', async () => {
    mockGithubApi
      .mockResolvedValueOnce(PR_RESPONSE)   // PR fetch
      .mockResolvedValueOnce({              // compare
        ahead_by: 3,
        files: [],                          // no net diff → content already upstream
      });
    expect(await checkContentAlreadyUpstream(1, 'org/repo', 42)).toBe(true);
  });

  it('returns true when ahead_by is 0 (no unique commits)', async () => {
    mockGithubApi
      .mockResolvedValueOnce(PR_RESPONSE)
      .mockResolvedValueOnce({ ahead_by: 0, files: [] });
    expect(await checkContentAlreadyUpstream(1, 'org/repo', 42)).toBe(true);
  });

  it('returns false when there are unique commits with real diff', async () => {
    mockGithubApi
      .mockResolvedValueOnce(PR_RESPONSE)
      .mockResolvedValueOnce({ ahead_by: 5, files: [{ filename: 'a.ts' }, { filename: 'b.ts' }] });
    expect(await checkContentAlreadyUpstream(1, 'org/repo', 42)).toBe(false);
  });

  it('returns null when PR fetch fails', async () => {
    mockGithubApi.mockRejectedValueOnce(new Error('404'));
    expect(await checkContentAlreadyUpstream(1, 'org/repo', 42)).toBeNull();
  });

  it('returns null when compare fetch fails', async () => {
    mockGithubApi
      .mockResolvedValueOnce(PR_RESPONSE)
      .mockRejectedValueOnce(new Error('compare failed'));
    expect(await checkContentAlreadyUpstream(1, 'org/repo', 42)).toBeNull();
  });

  it('returns null when PR has no base.ref or head.sha', async () => {
    mockGithubApi.mockResolvedValueOnce({ base: {}, head: {} });
    expect(await checkContentAlreadyUpstream(1, 'org/repo', 42)).toBeNull();
  });
});

// ── findSuccessorPr ───────────────────────────────────────────────────────────

describe('findSuccessorPr', () => {
  beforeEach(() => {
    mockTasksFindFirst.mockReset();
    mockTasksFindMany.mockReset();
    mockWorkersFindFirst.mockReset();
  });

  it('returns merged sibling PR when found', async () => {
    // Root task has no parentTaskId, has subjectPrNumber=10
    mockTasksFindFirst
      .mockResolvedValueOnce({ parentTaskId: null, subjectPrNumber: 10 }) // walk up
      .mockResolvedValueOnce({ subjectPrNumber: 10 });                    // root task
    mockTasksFindMany.mockResolvedValueOnce([{ id: 'sibling-task' }]);
    mockWorkersFindFirst.mockResolvedValueOnce({ prNumber: 99 });

    const result = await findSuccessorPr('ws-1', 'task-abc', 42);
    expect(result).toBe(99);
  });

  it('returns null when no subjectPrNumber on root task', async () => {
    mockTasksFindFirst
      .mockResolvedValueOnce({ parentTaskId: null, subjectPrNumber: null })
      .mockResolvedValueOnce({ subjectPrNumber: null });
    expect(await findSuccessorPr('ws-1', 'task-abc', 42)).toBeNull();
  });

  it('returns null when no sibling tasks found', async () => {
    mockTasksFindFirst
      .mockResolvedValueOnce({ parentTaskId: null, subjectPrNumber: 5 })
      .mockResolvedValueOnce({ subjectPrNumber: 5 });
    mockTasksFindMany.mockResolvedValueOnce([]);
    expect(await findSuccessorPr('ws-1', 'task-abc', 42)).toBeNull();
  });

  it('returns null when no merged sibling worker found', async () => {
    mockTasksFindFirst
      .mockResolvedValueOnce({ parentTaskId: null, subjectPrNumber: 5 })
      .mockResolvedValueOnce({ subjectPrNumber: 5 });
    mockTasksFindMany.mockResolvedValueOnce([{ id: 'sibling-task' }]);
    mockWorkersFindFirst.mockResolvedValueOnce(null);
    expect(await findSuccessorPr('ws-1', 'task-abc', 42)).toBeNull();
  });
});

// ── runSupersessionPrecheck ───────────────────────────────────────────────────

const BASE_PARAMS = {
  installationId: 1,
  repoFullName: 'org/repo',
  prNumber: 42,
  recordedStats: { filesChanged: 2, linesAdded: 164, linesRemoved: 11 } as DiffStats,
  workspaceId: 'ws-1',
  taskId: 'task-abc',
};

describe('runSupersessionPrecheck', () => {
  beforeEach(() => {
    mockGithubApi.mockReset();
    mockTasksFindFirst.mockReset();
    mockTasksFindMany.mockReset();
    mockWorkersFindFirst.mockReset();
    // Default: no parent task, no subjectPrNumber
    mockTasksFindFirst.mockResolvedValue({ parentTaskId: null, subjectPrNumber: null });
    mockTasksFindMany.mockResolvedValue([]);
    mockWorkersFindFirst.mockResolvedValue(null);
  });

  it('returns superseded=true when both detectors fire', async () => {
    // Drift check: live stats are 100x larger
    mockGithubApi
      .mockResolvedValueOnce({            // fetchLivePrStats → PR
        changed_files: 64,
        additions: 21685,
        deletions: 438,
      })
      .mockResolvedValueOnce(PR_RESPONSE) // checkContentAlreadyUpstream → PR
      .mockResolvedValueOnce({            // checkContentAlreadyUpstream → compare
        ahead_by: 3,
        files: [],
      });

    const result = await runSupersessionPrecheck(BASE_PARAMS);
    expect(result.superseded).toBe(true);
    expect(result.signals).toContain('drift_ratio');
    expect(result.signals).toContain('content_upstream');
    expect(result.driftRatioLines).toBeGreaterThan(10);
  });

  it('returns superseded=false when only drift fires (no content_upstream)', async () => {
    mockGithubApi
      .mockResolvedValueOnce({ changed_files: 64, additions: 21685, deletions: 438 })
      .mockResolvedValueOnce(PR_RESPONSE)
      .mockResolvedValueOnce({ ahead_by: 5, files: [{ filename: 'a.ts' }] }); // real diff

    const result = await runSupersessionPrecheck(BASE_PARAMS);
    expect(result.superseded).toBe(false);
    expect(result.signals).toContain('drift_ratio');
    expect(result.signals).not.toContain('content_upstream');
  });

  it('returns superseded=false when only content_upstream fires (no drift)', async () => {
    // Live stats similar to recorded — drift does not fire
    mockGithubApi
      .mockResolvedValueOnce({ changed_files: 2, additions: 180, deletions: 10 })
      .mockResolvedValueOnce(PR_RESPONSE)
      .mockResolvedValueOnce({ ahead_by: 0, files: [] }); // ahead_by=0

    const result = await runSupersessionPrecheck(BASE_PARAMS);
    expect(result.superseded).toBe(false);
    expect(result.signals).not.toContain('drift_ratio');
    expect(result.signals).toContain('content_upstream');
  });

  it('fails open when GitHub API returns null for live stats (no signal)', async () => {
    mockGithubApi
      .mockResolvedValueOnce(null)        // fetchLivePrStats → no PR
      .mockResolvedValueOnce(PR_RESPONSE)
      .mockResolvedValueOnce({ ahead_by: 5, files: [{ filename: 'a.ts' }] });

    const result = await runSupersessionPrecheck(BASE_PARAMS);
    expect(result.superseded).toBe(false);
    expect(result.signals).not.toContain('drift_ratio');
  });

  it('includes successorPrNumber when superseded and a sibling merged PR is found', async () => {
    mockGithubApi
      .mockResolvedValueOnce({ changed_files: 64, additions: 21685, deletions: 438 })
      .mockResolvedValueOnce(PR_RESPONSE)
      .mockResolvedValueOnce({ ahead_by: 0, files: [] });

    // findSuccessorPr returns PR #99
    mockTasksFindFirst
      .mockResolvedValueOnce({ parentTaskId: null, subjectPrNumber: 10 })
      .mockResolvedValueOnce({ subjectPrNumber: 10 });
    mockTasksFindMany.mockResolvedValueOnce([{ id: 'sibling-task' }]);
    mockWorkersFindFirst.mockResolvedValueOnce({ prNumber: 99 });

    const result: SupersessionResult = await runSupersessionPrecheck(BASE_PARAMS);
    expect(result.superseded).toBe(true);
    expect(result.successorPrNumber).toBe(99);
  });

  it('uses configurable threshold', async () => {
    // Same 100x drift but threshold raised to 200 → drift should NOT fire
    mockGithubApi
      .mockResolvedValueOnce({ changed_files: 64, additions: 21685, deletions: 438 })
      .mockResolvedValueOnce(PR_RESPONSE)
      .mockResolvedValueOnce({ ahead_by: 0, files: [] }); // content fires

    const result = await runSupersessionPrecheck({
      ...BASE_PARAMS,
      driftRatioThreshold: 200, // very high — drift won't fire
    });
    // content_upstream fires alone → not superseded (need both gates)
    expect(result.superseded).toBe(false);
    expect(result.signals).not.toContain('drift_ratio');
    expect(result.signals).toContain('content_upstream');
  });
});
