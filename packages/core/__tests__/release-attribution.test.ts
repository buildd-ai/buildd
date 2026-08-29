import { describe, it, expect } from 'bun:test';
import { attributeRelease } from '../release-attribution';
import type { DrizzleDb } from '../release-attribution';

// ── fixtures ──────────────────────────────────────────────────────────────────

const WORKSPACE_ID = 'ws-uuid-1111-2222-3333';
const RELEASE_ID = 'rel-uuid-1111-2222-3333';
const PREV_SHA = 'abc0000000000000000000000000000000000000';
const HEAD_SHA = 'def0000000000000000000000000000000000000';
const REPO = 'owner/my-repo';

function makeWorker(overrides: Record<string, any> = {}) {
  return {
    id: 'worker-id-1',
    taskId: 'task-uuid-aaaa',
    workspaceId: WORKSPACE_ID,
    prNumber: null,
    lastCommitSha: null,
    mergedAt: null,
    ...overrides,
  };
}

function makeCommit(sha: string, message = 'feat: add thing') {
  return { sha, commit: { message }, parents: [{ sha: 'parent-sha' }] };
}

function makeMergeCommit(sha: string, prNumber: number) {
  return {
    sha,
    commit: { message: `Merge pull request #${prNumber} from owner/branch` },
    parents: [{ sha: 'parent-sha' }, { sha: 'second-parent-sha' }],
  };
}

function makeCompare(commits: any[]) {
  return { commits };
}

// ── mock DB builder ───────────────────────────────────────────────────────────

interface InsertCapture {
  rows: any[][];
  onConflictCalled: boolean;
}

function makeMockDb(workersResult: any[] = [], capture: InsertCapture = { rows: [], onConflictCalled: false }): DrizzleDb {
  const selectChain: any = {
    from: () => selectChain,
    where: () => Promise.resolve(workersResult),
  };

  const insertChain: any = {
    values: (rows: any[]) => {
      capture.rows.push(rows);
      return insertChain;
    },
    onConflictDoNothing: () => {
      capture.onConflictCalled = true;
      return Promise.resolve();
    },
  };

  return {
    select: () => selectChain,
    insert: (_table: any) => insertChain,
    query: {
      githubInstallations: {
        findFirst: () => Promise.resolve(null),
      },
    },
  };
}

// ── continuous archetype ──────────────────────────────────────────────────────

describe('attributeRelease — continuous archetype', () => {
  it('attributes commits matched by lastCommitSha', async () => {
    const sha1 = 'sha1aaa';
    const sha2 = 'sha2bbb';
    const w1 = makeWorker({ id: 'w1', lastCommitSha: sha1, taskId: 'task-1' });
    const w2 = makeWorker({ id: 'w2', lastCommitSha: sha2, taskId: 'task-2' });
    const capture: InsertCapture = { rows: [], onConflictCalled: false };
    const db = makeMockDb([w1, w2], capture);

    const result = await attributeRelease({
      releaseId: RELEASE_ID,
      workspaceId: WORKSPACE_ID,
      previousSha: PREV_SHA,
      headSha: HEAD_SHA,
      archetype: 'continuous',
      repoFullName: REPO,
      githubInstallationId: 1,
      db,
      githubFetch: async () => makeCompare([makeCommit(sha1), makeCommit(sha2)]),
    });

    expect(result.attributed).toBe(2);
    expect(result.skipped).toBe(0);
    expect(capture.rows[0]).toHaveLength(2);
    expect(capture.rows[0][0]).toMatchObject({ releaseId: RELEASE_ID, taskId: 'task-1', prNumber: null, commitSha: sha1 });
    expect(capture.rows[0][1]).toMatchObject({ releaseId: RELEASE_ID, taskId: 'task-2', prNumber: null, commitSha: sha2 });
    expect(capture.onConflictCalled).toBe(true);
  });

  it('skips commits with no matching worker', async () => {
    const db = makeMockDb([]);

    const result = await attributeRelease({
      releaseId: RELEASE_ID,
      workspaceId: WORKSPACE_ID,
      previousSha: PREV_SHA,
      headSha: HEAD_SHA,
      archetype: 'continuous',
      repoFullName: REPO,
      githubInstallationId: 1,
      db,
      githubFetch: async () => makeCompare([makeCommit('sha-unmatched')]),
    });

    expect(result.attributed).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it('partial match — attributes some, skips others', async () => {
    const matchedSha = 'sha-matched';
    const db = makeMockDb([makeWorker({ lastCommitSha: matchedSha, taskId: 'task-xyz' })]);

    const result = await attributeRelease({
      releaseId: RELEASE_ID,
      workspaceId: WORKSPACE_ID,
      previousSha: PREV_SHA,
      headSha: HEAD_SHA,
      archetype: 'continuous',
      repoFullName: REPO,
      githubInstallationId: 1,
      db,
      githubFetch: async () => makeCompare([makeCommit(matchedSha), makeCommit('sha-no-worker')]),
    });

    expect(result.attributed).toBe(1);
    expect(result.skipped).toBe(1);
  });

  it('returns zeros when commit range is empty', async () => {
    const db = makeMockDb();

    const result = await attributeRelease({
      releaseId: RELEASE_ID,
      workspaceId: WORKSPACE_ID,
      previousSha: PREV_SHA,
      headSha: HEAD_SHA,
      archetype: 'continuous',
      repoFullName: REPO,
      githubInstallationId: 1,
      db,
      githubFetch: async () => makeCompare([]),
    });

    expect(result.attributed).toBe(0);
    expect(result.skipped).toBe(0);
  });

  it('skips workers without a taskId', async () => {
    const sha = 'sha-no-task';
    const db = makeMockDb([makeWorker({ lastCommitSha: sha, taskId: null })]);

    const result = await attributeRelease({
      releaseId: RELEASE_ID,
      workspaceId: WORKSPACE_ID,
      previousSha: PREV_SHA,
      headSha: HEAD_SHA,
      archetype: 'continuous',
      repoFullName: REPO,
      githubInstallationId: 1,
      db,
      githubFetch: async () => makeCompare([makeCommit(sha)]),
    });

    expect(result.attributed).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it('constructs the correct GitHub compare URL', async () => {
    let capturedPath = '';
    const db = makeMockDb([]);

    await attributeRelease({
      releaseId: RELEASE_ID,
      workspaceId: WORKSPACE_ID,
      previousSha: PREV_SHA,
      headSha: HEAD_SHA,
      archetype: 'continuous',
      repoFullName: REPO,
      githubInstallationId: 1,
      db,
      githubFetch: async (path) => {
        capturedPath = path;
        return makeCompare([]);
      },
    });

    expect(capturedPath).toBe(`/repos/${REPO}/compare/${PREV_SHA}...${HEAD_SHA}`);
  });
});

// ── gated archetype ───────────────────────────────────────────────────────────

describe('attributeRelease — gated archetype', () => {
  it('attributes merged PRs found via merge commit message', async () => {
    const prNumber = 42;
    const mergeSha = 'merge-sha-for-pr-42';
    const worker = makeWorker({ prNumber, taskId: 'task-42', mergedAt: new Date().toISOString() });
    const capture: InsertCapture = { rows: [], onConflictCalled: false };
    const db = makeMockDb([worker], capture);

    const result = await attributeRelease({
      releaseId: RELEASE_ID,
      workspaceId: WORKSPACE_ID,
      previousSha: PREV_SHA,
      headSha: HEAD_SHA,
      archetype: 'gated',
      repoFullName: REPO,
      githubInstallationId: 1,
      db,
      githubFetch: async () => makeCompare([makeMergeCommit(mergeSha, prNumber)]),
    });

    expect(result.attributed).toBe(1);
    expect(result.skipped).toBe(0);
    expect(capture.rows[0][0]).toMatchObject({
      releaseId: RELEASE_ID,
      taskId: 'task-42',
      prNumber,
      commitSha: mergeSha,
    });
    expect(capture.onConflictCalled).toBe(true);
  });

  it('skips PRs with no matching worker', async () => {
    const db = makeMockDb([]);

    const result = await attributeRelease({
      releaseId: RELEASE_ID,
      workspaceId: WORKSPACE_ID,
      previousSha: PREV_SHA,
      headSha: HEAD_SHA,
      archetype: 'gated',
      repoFullName: REPO,
      githubInstallationId: 1,
      db,
      githubFetch: async () => makeCompare([makeMergeCommit('sha-99', 99)]),
    });

    expect(result.attributed).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it('attributes multiple PRs from a single release', async () => {
    const workers = [
      makeWorker({ id: 'w1', prNumber: 10, taskId: 'task-10', mergedAt: new Date().toISOString() }),
      makeWorker({ id: 'w2', prNumber: 20, taskId: 'task-20', mergedAt: new Date().toISOString() }),
    ];
    const capture: InsertCapture = { rows: [], onConflictCalled: false };
    const db = makeMockDb(workers, capture);

    const result = await attributeRelease({
      releaseId: RELEASE_ID,
      workspaceId: WORKSPACE_ID,
      previousSha: PREV_SHA,
      headSha: HEAD_SHA,
      archetype: 'gated',
      repoFullName: REPO,
      githubInstallationId: 1,
      db,
      githubFetch: async () => makeCompare([
        makeCommit('sha-regular'),
        makeMergeCommit('merge-10', 10),
        makeMergeCommit('merge-20', 20),
      ]),
    });

    expect(result.attributed).toBe(2);
    expect(result.skipped).toBe(0);
    const inserted = capture.rows[0];
    expect(inserted).toHaveLength(2);
    const insertedPrs = inserted.map((r: any) => r.prNumber).sort();
    expect(insertedPrs).toEqual([10, 20]);
  });

  it('ignores non-merge commits in gated archetype', async () => {
    const db = makeMockDb([]);

    const result = await attributeRelease({
      releaseId: RELEASE_ID,
      workspaceId: WORKSPACE_ID,
      previousSha: PREV_SHA,
      headSha: HEAD_SHA,
      archetype: 'gated',
      repoFullName: REPO,
      githubInstallationId: 1,
      db,
      githubFetch: async () => makeCompare([
        makeCommit('sha-a', 'feat: some direct commit'),
        makeCommit('sha-b', 'chore: cleanup'),
      ]),
    });

    // No merge commits → no PRs → nothing to attribute or skip
    expect(result.attributed).toBe(0);
    expect(result.skipped).toBe(0);
  });

  it('deduplicates workers for the same PR number', async () => {
    // Two workers with the same prNumber (e.g. retries)
    const prNumber = 55;
    const workers = [
      makeWorker({ id: 'w1', prNumber, taskId: 'task-55-v1', mergedAt: new Date().toISOString() }),
      makeWorker({ id: 'w2', prNumber, taskId: 'task-55-v2', mergedAt: new Date().toISOString() }),
    ];
    const capture: InsertCapture = { rows: [], onConflictCalled: false };
    const db = makeMockDb(workers, capture);

    const result = await attributeRelease({
      releaseId: RELEASE_ID,
      workspaceId: WORKSPACE_ID,
      previousSha: PREV_SHA,
      headSha: HEAD_SHA,
      archetype: 'gated',
      repoFullName: REPO,
      githubInstallationId: 1,
      db,
      githubFetch: async () => makeCompare([makeMergeCommit('merge-55', prNumber)]),
    });

    // Only one row inserted (first worker wins), one PR attributed
    expect(result.attributed).toBe(1);
    expect(capture.rows[0]).toHaveLength(1);
  });

  it('is idempotent — uses ON CONFLICT DO NOTHING', async () => {
    const capture: InsertCapture = { rows: [], onConflictCalled: false };
    const db = makeMockDb(
      [makeWorker({ prNumber: 11, taskId: 'task-11', mergedAt: new Date().toISOString() })],
      capture,
    );

    await attributeRelease({
      releaseId: RELEASE_ID,
      workspaceId: WORKSPACE_ID,
      previousSha: PREV_SHA,
      headSha: HEAD_SHA,
      archetype: 'gated',
      repoFullName: REPO,
      githubInstallationId: 1,
      db,
      githubFetch: async () => makeCompare([makeMergeCommit('sha-11', 11)]),
    });

    expect(capture.onConflictCalled).toBe(true);
  });

  it('mixes attributed and skipped PRs in the same release', async () => {
    // PR 100 has a matching worker, PR 101 does not
    const db = makeMockDb([
      makeWorker({ prNumber: 100, taskId: 'task-100', mergedAt: new Date().toISOString() }),
    ]);

    const result = await attributeRelease({
      releaseId: RELEASE_ID,
      workspaceId: WORKSPACE_ID,
      previousSha: PREV_SHA,
      headSha: HEAD_SHA,
      archetype: 'gated',
      repoFullName: REPO,
      githubInstallationId: 1,
      db,
      githubFetch: async () =>
        makeCompare([makeMergeCommit('sha-100', 100), makeMergeCommit('sha-101', 101)]),
    });

    expect(result.attributed).toBe(1);
    expect(result.skipped).toBe(1);
  });
});
