import { describe, it, expect, beforeEach, mock } from 'bun:test';

// ── DB mocks ────────────────────────────────────────────────────────────────
//
// The loader issues several shapes of `findMany` per table. Sequencing by call
// order is brittle, so the mocks dispatch on the shape of the mocked `where`
// clause — the same approach `api/cron/queue-stall/route.test.ts` uses.

let missionRows: any[] = [];
let missionTaskRows: any[] = [];
let backfillTaskRows: any[] = [];
let planningRows: any[] = [];
let reviewRows: any[] = [];
let openPrRows: any[] = [];
let strandedRows: any[] = [];
let baseMergeRows: any[] = [];
/** Args of the base-drift merge query, so its window and cap are assertable. */
let baseMergeArgs: any = null;
let missionWorkerRows: any[] = [];
let releaseRows: any[] = [];
let noteRows: any[] = [];
let workspaceRows: any[] = [];
let installationRows: any[] = [];
let childCountRows: any[] = [];
let attributionRows: any[] = [];

const mockTasksFindMany = mock(async (args: any) => {
  const w = args?.where;
  if (w?.type === 'inArray') return w.f === 'missionId' ? missionTaskRows : backfillTaskRows;
  const fields = (w?.c ?? []).map((c: any) => c?.f);
  if (fields.includes('mode')) return planningRows;
  if (fields.includes('category')) return reviewRows;
  return [];
});

const mockWorkersFindMany = mock(async (args: any) => {
  const w = args?.where;
  if (w?.type === 'inArray') return missionWorkerRows;
  const fields = (w?.c ?? []).map((c: any) => c?.f);
  if (fields.includes('commitCount')) return strandedRows;
  // The base-drift query is the only one that filters on prBaseRef, and unlike
  // every other worker read it wants MERGED rows — dispatching it to
  // `openPrRows` would make it look populated while testing nothing.
  if (fields.includes('prBaseRef')) {
    baseMergeArgs = args;
    return baseMergeRows;
  }
  return openPrRows;
});

function selectChain(table: any) {
  const name = table?.__t;
  const rows = name === 'releaseTasks' ? attributionRows : childCountRows;
  return {
    where: () => ({
      groupBy: async () => rows,
      limit: async () => (name === 'githubInstallations' ? installationRows : []),
    }),
  };
}

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      missions: { findMany: mock(async () => missionRows) },
      tasks: { findMany: mockTasksFindMany },
      workers: { findMany: mockWorkersFindMany },
      releases: { findMany: mock(async () => releaseRows) },
      missionNotes: { findMany: mock(async () => noteRows) },
      workspaces: { findMany: mock(async () => workspaceRows) },
    },
    select: mock(() => ({ from: (table: any) => selectChain(table) })),
  },
}));

mock.module('drizzle-orm', () => ({
  sql: (strings: any, ...values: any[]) => ({ strings, values, type: 'sql' }),
  eq: (f: any, v: any) => ({ f, v, type: 'eq' }),
  and: (...c: any[]) => ({ c, type: 'and' }),
  gt: (f: any, v: any) => ({ f, v, type: 'gt' }),
  inArray: (f: any, v: any) => ({ f, v, type: 'inArray' }),
  isNull: (f: any) => ({ f, type: 'isNull' }),
  isNotNull: (f: any) => ({ f, type: 'isNotNull' }),
  desc: (f: any) => ({ f, type: 'desc' }),
}));

mock.module('@buildd/core/db/schema', () => ({
  missions: { __t: 'missions', updatedAt: 'updatedAt' },
  missionNotes: { __t: 'missionNotes', missionId: 'missionId', type: 'type', status: 'status' },
  releases: { __t: 'releases', createdAt: 'createdAt' },
  releaseTasks: { __t: 'releaseTasks', releaseId: 'releaseId' },
  tasks: {
    __t: 'tasks', id: 'id', missionId: 'missionId', parentTaskId: 'parentTaskId',
    mode: 'mode', status: 'status', category: 'category', updatedAt: 'updatedAt',
  },
  workers: {
    __t: 'workers', taskId: 'taskId', status: 'status', prNumber: 'prNumber',
    mergedAt: 'mergedAt', commitCount: 'commitCount', completedAt: 'completedAt',
    createdAt: 'createdAt', prBaseRef: 'prBaseRef',
  },
  workspaces: { __t: 'workspaces', id: 'id' },
  githubInstallations: { __t: 'githubInstallations', accountLogin: 'accountLogin', installationId: 'installationId' },
}));

const mockGithubApi = mock(async (_id: number, _path: string) => ({ ok: true }));
mock.module('@/lib/github', () => ({ githubApi: mockGithubApi }));

const {
  checkRemoteRef,
  loadInvariantSnapshot,
  MAX_REMOTE_REF_CHECKS,
  MAX_BASE_MERGES,
  BASE_MERGE_WINDOW_DAYS,
} = await import('./mission-invariant-scan');
const { remoteRefKey } = await import('./mission-invariants');

// ── Helpers ─────────────────────────────────────────────────────────────────

const NOW = new Date('2026-09-10T12:00:00.000Z');
const HOUR = 3_600_000;

function openPr(over: Record<string, any> = {}) {
  return {
    id: 'w-1',
    taskId: 't-1',
    workspaceId: 'ws-1',
    status: 'completed',
    branch: 'buildd/t-1',
    prNumber: 10,
    prUrl: null,
    prBaseRef: 'mission/example-1234',
    prLifecycleStatus: 'ci_green',
    mergedAt: null,
    commitCount: 1,
    createdAt: new Date(NOW.getTime() - 6 * HOUR),
    startedAt: null,
    completedAt: null,
    ...over,
  };
}

beforeEach(() => {
  missionRows = [];
  missionTaskRows = [];
  backfillTaskRows = [];
  planningRows = [];
  reviewRows = [];
  openPrRows = [];
  strandedRows = [];
  baseMergeRows = [];
  baseMergeArgs = null;
  missionWorkerRows = [];
  releaseRows = [];
  noteRows = [];
  workspaceRows = [{ id: 'ws-1', repo: 'acme/widgets', gitConfig: { defaultBranch: 'dev' } }];
  installationRows = [{ installationId: 4242 }];
  childCountRows = [];
  attributionRows = [];
  mockGithubApi.mockClear();
});

// ── The safety property behind the one filing invariant ─────────────────────

describe('checkRemoteRef', () => {
  it('reports a 404 as gone', async () => {
    const api = mock(async () => {
      throw new Error('GitHub API error: 404 {"message":"Not Found"}');
    });
    expect(await checkRemoteRef(1, 'o', 'r', 'mission/x', { api: api as any })).toBe(false);
  });

  it('reports a reachable ref as present', async () => {
    const api = mock(async () => ({ ref: 'refs/heads/mission/x' }));
    expect(await checkRemoteRef(1, 'o', 'r', 'mission/x', { api: api as any })).toBe(true);
  });

  it('reports anything else as unknown — an outage must not read as a deleted branch', async () => {
    for (const message of ['GitHub API error: 500 boom', 'fetch failed', 'GitHub API error: 401 bad creds']) {
      const api = mock(async () => {
        throw new Error(message);
      });
      expect(await checkRemoteRef(1, 'o', 'r', 'mission/x', { api: api as any })).toBeNull();
    }
  });
});

// ── Cost shape ──────────────────────────────────────────────────────────────

describe('loadInvariantSnapshot cost', () => {
  it('makes zero GitHub calls when nothing is based on a mission branch', async () => {
    openPrRows = [openPr({ prBaseRef: 'dev' })];
    const checkRef = mock(async () => true as boolean | null);

    const { snapshot, coverage } = await loadInvariantSnapshot(NOW, { checkRef: checkRef as any });

    expect(checkRef).not.toHaveBeenCalled();
    expect(coverage.remoteRefs).toBe(0);
    expect(snapshot.remoteBranchExists.size).toBe(0);
  });

  it('checks each distinct mission base exactly once', async () => {
    openPrRows = [
      openPr({ id: 'w-1', prNumber: 10 }),
      openPr({ id: 'w-2', prNumber: 11 }),
      openPr({ id: 'w-3', prNumber: 12, prBaseRef: 'mission/other-9999' }),
    ];
    const checkRef = mock(async () => false as boolean | null);

    const { snapshot, coverage } = await loadInvariantSnapshot(NOW, { checkRef: checkRef as any });

    expect(checkRef).toHaveBeenCalledTimes(2);
    expect(coverage.remoteRefs).toBe(2);
    expect(snapshot.remoteBranchExists.get(remoteRefKey('ws-1', 'mission/example-1234'))).toBe(false);
    expect(snapshot.remoteBranchExists.get(remoteRefKey('ws-1', 'mission/other-9999'))).toBe(false);
  });

  it('caps the ref checks so the sweep cannot grow with fleet size', async () => {
    openPrRows = Array.from({ length: MAX_REMOTE_REF_CHECKS + 7 }, (_, i) =>
      openPr({ id: `w-${i}`, prNumber: 100 + i, prBaseRef: `mission/m-${i}` }),
    );
    const checkRef = mock(async () => true as boolean | null);

    const { coverage } = await loadInvariantSnapshot(NOW, { checkRef: checkRef as any });

    expect(checkRef).toHaveBeenCalledTimes(MAX_REMOTE_REF_CHECKS);
    expect(coverage.remoteRefs).toBe(MAX_REMOTE_REF_CHECKS);
  });

  it('records an inconclusive check as unknown rather than gone', async () => {
    openPrRows = [openPr()];
    const checkRef = mock(async () => null as boolean | null);

    const { snapshot } = await loadInvariantSnapshot(NOW, { checkRef: checkRef as any });

    expect(snapshot.remoteBranchExists.get(remoteRefKey('ws-1', 'mission/example-1234'))).toBeNull();
  });

  it('skips the check when the workspace has no resolvable repo', async () => {
    openPrRows = [openPr()];
    workspaceRows = [{ id: 'ws-1', repo: null, gitConfig: {} }];
    const checkRef = mock(async () => false as boolean | null);

    const { coverage } = await loadInvariantSnapshot(NOW, { checkRef: checkRef as any });

    expect(checkRef).not.toHaveBeenCalled();
    expect(coverage.remoteRefs).toBe(0);
  });
});

// ── Row mapping ─────────────────────────────────────────────────────────────

describe('loadInvariantSnapshot mapping', () => {
  const checkRef = async () => null;

  it('takes trunk names from the workspace git config', async () => {
    openPrRows = [openPr({ prBaseRef: 'dev' })];
    workspaceRows = [{ id: 'ws-1', repo: 'acme/widgets', gitConfig: { defaultBranch: 'dev', targetBranch: 'main' } }];

    const { snapshot } = await loadInvariantSnapshot(NOW, { checkRef: checkRef as any });

    expect([...(snapshot.trunkBranches.get('ws-1') ?? [])].sort()).toEqual(['dev', 'main']);
  });

  it('falls back to main/master when a workspace declares no branches', async () => {
    openPrRows = [openPr({ prBaseRef: 'main' })];
    workspaceRows = [{ id: 'ws-1', repo: 'acme/widgets', gitConfig: null }];

    const { snapshot } = await loadInvariantSnapshot(NOW, { checkRef: checkRef as any });

    expect([...(snapshot.trunkBranches.get('ws-1') ?? [])].sort()).toEqual(['main', 'master']);
  });

  it('drops archived missions and reads the criteria verdict off the state blob', async () => {
    missionRows = [
      {
        id: 'm-1', workspaceId: 'ws-1', title: 'Live', status: 'active',
        integrationBranchEnabled: true, workingBranch: null, criteriaEscalatedAt: null,
        goalCriteria: [{ type: 'all_prs_merged' }],
        goalCriteriaState: { overall: 'PENDING' },
        updatedAt: NOW,
      },
      {
        id: 'm-2', workspaceId: 'ws-1', title: 'Gone', status: 'archived',
        integrationBranchEnabled: false, workingBranch: null, criteriaEscalatedAt: null,
        goalCriteria: null, goalCriteriaState: null, updatedAt: NOW,
      },
    ];

    const { snapshot } = await loadInvariantSnapshot(NOW, { checkRef: checkRef as any });

    expect(snapshot.missions.map(m => m.id)).toEqual(['m-1']);
    expect(snapshot.missions[0].hasGoalCriteria).toBe(true);
    expect(snapshot.missions[0].criteriaOverallVerdict).toBe('PENDING');
  });

  it('keeps an archived mission when it still carries a stale criteria escalation', async () => {
    // Every other invariant has no use for an archived mission — but
    // `stale_criteria_escalation` exists specifically to catch one that
    // outlived the mission, so the general archived-drop above must not
    // swallow it.
    missionRows = [
      {
        id: 'm-3', workspaceId: 'ws-1', title: 'Archived but still escalated', status: 'archived',
        integrationBranchEnabled: false, workingBranch: null, criteriaEscalatedAt: NOW,
        goalCriteria: [{ type: 'all_prs_merged' }], goalCriteriaState: { overall: 'fail' },
        updatedAt: NOW,
      },
    ];

    const { snapshot } = await loadInvariantSnapshot(NOW, { checkRef: checkRef as any });

    expect(snapshot.missions.map(m => m.id)).toEqual(['m-3']);
  });

  it('lifts context.baseBranch and structuredOutput.plan onto the snapshot task', async () => {
    backfillTaskRows = [
      {
        id: 't-1', workspaceId: 'ws-1', missionId: null, parentTaskId: null, title: 'X',
        status: 'completed', mode: 'planning', taskClass: 'work', outputRequirement: 'auto',
        context: { baseBranch: 'mission/example-1234' },
        result: { structuredOutput: { plan: [{ ref: 'a' }] } },
        createdAt: NOW, updatedAt: NOW,
      },
    ];
    openPrRows = [openPr({ prBaseRef: 'dev' })];

    const { snapshot } = await loadInvariantSnapshot(NOW, { checkRef: checkRef as any });
    const t = snapshot.tasks.find(x => x.id === 't-1');

    expect(t?.contextBaseBranch).toBe('mission/example-1234');
    expect(t?.planRaw).toEqual([{ ref: 'a' }]);
  });

  it('keeps only the newest reviewer verdict per PR', async () => {
    reviewRows = [
      { workspaceId: 'ws-1', context: { prNumber: 77 }, result: { structuredOutput: { verdict: 'approve' } }, updatedAt: new Date(NOW.getTime() - HOUR) },
      { workspaceId: 'ws-1', context: { prNumber: 77 }, result: { structuredOutput: { verdict: 'request-changes' } }, updatedAt: new Date(NOW.getTime() - 5 * HOUR) },
    ];

    const { snapshot } = await loadInvariantSnapshot(NOW, { checkRef: checkRef as any });

    expect(snapshot.reviews).toHaveLength(1);
    expect(snapshot.reviews[0]).toMatchObject({ prNumber: 77, verdict: 'approve' });
  });

  it('accepts a stringified prNumber in the reviewer task context', async () => {
    reviewRows = [
      { workspaceId: 'ws-1', context: { prNumber: '88' }, result: { structuredOutput: { verdict: 'approve' } }, updatedAt: NOW },
    ];

    const { snapshot } = await loadInvariantSnapshot(NOW, { checkRef: checkRef as any });

    expect(snapshot.reviews[0]).toMatchObject({ prNumber: 88, verdict: 'approve' });
  });

  it('attaches attribution counts to releases', async () => {
    releaseRows = [
      { id: 'r-1', workspaceId: 'ws-1', state: 'healthy', headSha: 'abc', dispatchedAt: NOW, createdAt: NOW },
      { id: 'r-2', workspaceId: 'ws-1', state: 'healthy', headSha: 'def', dispatchedAt: NOW, createdAt: NOW },
    ];
    attributionRows = [{ releaseId: 'r-1', n: 3 }];

    const { snapshot } = await loadInvariantSnapshot(NOW, { checkRef: checkRef as any });

    expect(snapshot.releases.find(r => r.id === 'r-1')?.attributedTaskCount).toBe(3);
    expect(snapshot.releases.find(r => r.id === 'r-2')?.attributedTaskCount).toBe(0);
  });

  it('attaches child counts to planning tasks', async () => {
    planningRows = [
      {
        id: 'p-1', workspaceId: 'ws-1', missionId: null, parentTaskId: null, title: 'Plan',
        status: 'completed', mode: 'planning', taskClass: 'work', outputRequirement: 'auto',
        context: {}, result: { structuredOutput: { plan: [{ ref: 'a' }] } },
        createdAt: NOW, updatedAt: NOW,
      },
    ];
    childCountRows = [{ parentTaskId: 'p-1', n: 4 }];

    const { snapshot } = await loadInvariantSnapshot(NOW, { checkRef: checkRef as any });

    expect(snapshot.tasks.find(t => t.id === 'p-1')?.childCount).toBe(4);
  });
});

// ── Base drift ──────────────────────────────────────────────────────────────
//
// The one input `open_pr_outpaced_by_base` cannot derive from anything else.
// Every other worker read in this loader deliberately excludes merged rows, so
// if this query stops returning any, the invariant is clean by arithmetic and
// nothing else in the sweep notices.

describe('loadInvariantSnapshot base drift', () => {
  const checkRef = async () => null;

  function merge(over: Record<string, any> = {}) {
    return {
      workspaceId: 'ws-1',
      prBaseRef: 'dev',
      mergedAt: new Date(NOW.getTime() - HOUR),
      ...over,
    };
  }

  it('loads recent merges per base branch, which nothing else in the snapshot carries', async () => {
    baseMergeRows = [merge(), merge({ prBaseRef: 'main' })];

    const { snapshot, coverage } = await loadInvariantSnapshot(NOW, { checkRef: checkRef as any });

    expect(snapshot.baseMerges).toEqual([
      { workspaceId: 'ws-1', baseRef: 'dev', mergedAt: new Date(NOW.getTime() - HOUR) },
      { workspaceId: 'ws-1', baseRef: 'main', mergedAt: new Date(NOW.getTime() - HOUR) },
    ]);
    expect(coverage.baseMerges).toBe(2);
  });

  it('reports zero base merges as zero, so a starved invariant is visible', async () => {
    const { coverage } = await loadInvariantSnapshot(NOW, { checkRef: checkRef as any });
    expect(coverage.baseMerges).toBe(0);
  });

  it('drops rows with no base ref or no merge timestamp', async () => {
    // Both are nullable columns, and either one makes the row uncountable —
    // a null baseRef would otherwise become drift against every other null.
    baseMergeRows = [merge(), merge({ prBaseRef: null }), merge({ mergedAt: null })];

    const { snapshot, coverage } = await loadInvariantSnapshot(NOW, { checkRef: checkRef as any });

    expect(snapshot.baseMerges).toHaveLength(1);
    expect(coverage.baseMerges).toBe(1);
  });

  it('bounds the query by window and row cap, keeping the newest merges', async () => {
    // Truncation direction matters: drift only counts merges AFTER a PR opened,
    // so keeping the newest rows is what preserves the signal. The window makes
    // the count an undercount for older PRs, which fails towards silence.
    baseMergeRows = [merge()];

    await loadInvariantSnapshot(NOW, { checkRef: checkRef as any });

    expect(baseMergeArgs?.limit).toBe(MAX_BASE_MERGES);
    expect(baseMergeArgs?.orderBy).toMatchObject({ type: 'desc', f: 'mergedAt' });
    const windowClause = (baseMergeArgs?.where?.c ?? []).find(
      (c: any) => c?.type === 'gt' && c?.f === 'mergedAt',
    );
    expect(windowClause?.v).toEqual(new Date(NOW.getTime() - BASE_MERGE_WINDOW_DAYS * 86_400_000));
  });
});
