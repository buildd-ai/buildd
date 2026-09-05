import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

/**
 * Who gets paged about an unmerged PR.
 *
 * The stall cron nags a human whenever the resolved merge policy says the PR is
 * a human gate. Under Option A' a task PR based on the mission's integration
 * branch is NOT that gate — the single PR from that branch into trunk is — so
 * paging someone about a task PR is a page about a review they were never asked
 * to do. The escalation inbox already reads the base ref; this cron has to agree
 * with it or the two surfaces disagree about the same PR.
 *
 * `resolvePolicy` is deliberately NOT mocked: the precedence chain is the thing
 * under test here, and a hand-copied stub of it would only ever confirm itself.
 */

// ── DB mocks ─────────────────────────────────────────────────────────────────

let workerRows: any[] = [];
let workspaceRows: any[] = [];
let missionRows: any[] = [];
let escalatedNoteRows: any[] = [];
let recentStallNote: any = null;
const insertedNotes: any[] = [];

const mockWorkersFindMany = mock((_args?: any) => Promise.resolve(workerRows));
const mockWorkspacesFindMany = mock((_args?: any) => Promise.resolve(workspaceRows));
const mockMissionsFindMany = mock((_args?: any) => Promise.resolve(missionRows));
const mockNotesFindMany = mock((_args?: any) => Promise.resolve(escalatedNoteRows));
const mockNotesFindFirst = mock((_args?: any) => Promise.resolve(recentStallNote));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workers: { findMany: mockWorkersFindMany },
      workspaces: { findMany: mockWorkspacesFindMany },
      missions: { findMany: mockMissionsFindMany },
      missionNotes: { findMany: mockNotesFindMany, findFirst: mockNotesFindFirst },
    },
    insert: () => ({
      values: (v: any) => {
        insertedNotes.push(v);
        return Promise.resolve([]);
      },
    }),
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (f: any, v: any) => ({ type: 'eq', f, v }),
  and: (...c: any[]) => ({ type: 'and', c }),
  inArray: (f: any, v: any) => ({ type: 'inArray', f, v }),
  isNotNull: (f: any) => ({ type: 'isNotNull', f }),
  isNull: (f: any) => ({ type: 'isNull', f }),
  gte: (f: any, v: any) => ({ type: 'gte', f, v }),
  like: (f: any, v: any) => ({ type: 'like', f, v }),
}));

mock.module('@buildd/core/db/schema', () => ({
  workers: { id: 'id', prUrl: 'prUrl', mergedAt: 'mergedAt', taskId: 'taskId' },
  tasks: { id: 'id' },
  workspaces: { id: 'id' },
  missions: { id: 'id' },
  missionNotes: { taskId: 'taskId', type: 'type', status: 'status', title: 'title', createdAt: 'createdAt', missionId: 'missionId' },
}));

const mockNotify = mock((_args: any) => Promise.resolve(true));
mock.module('@/lib/pushover', () => ({ notify: mockNotify }));

const { POST } = await import('./route');

// ── Fixtures ─────────────────────────────────────────────────────────────────

const CRON_SECRET = 'test-cron-secret';
const INTEGRATION_BRANCH = 'mission/illustrative-goal';
const TRUNK = 'dev';
/** Comfortably past the 30-minute default stall window. */
const LONG_AGO = new Date(Date.now() - 4 * 60 * 60 * 1000);

function makeRequest(token = CRON_SECRET) {
  return new NextRequest('http://localhost/api/cron/stall-notify', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });
}

/**
 * One stalled PR in a workspace whose policy is a human gate, under a mission
 * that has opted in to an integration branch.
 */
function stalledPr(opts: { prBaseRef: string | null; integrationBranchEnabled?: boolean }) {
  workerRows = [
    {
      id: 'w-1',
      taskId: 't-1',
      workspaceId: 'ws-1',
      prUrl: 'https://github.example/pr/1',
      prNumber: 1,
      completedAt: LONG_AGO,
      prBaseRef: opts.prBaseRef,
      task: { id: 't-1', missionId: 'm-1' },
    },
  ];
  workspaceRows = [
    { id: 'ws-1', repo: 'org/repo', gitConfig: { mergePolicy: { tier: 'human' } } },
  ];
  missionRows = [
    {
      id: 'm-1',
      workingBranch: INTEGRATION_BRANCH,
      integrationBranchEnabled: opts.integrationBranchEnabled ?? true,
    },
  ];
}

beforeEach(() => {
  process.env.CRON_SECRET = CRON_SECRET;
  workerRows = [];
  workspaceRows = [];
  missionRows = [];
  escalatedNoteRows = [];
  recentStallNote = null;
  insertedNotes.length = 0;
  mockNotify.mockClear();
  mockWorkersFindMany.mockClear();
  mockMissionsFindMany.mockClear();
});

describe('POST /api/cron/stall-notify', () => {
  it('rejects a request without the cron secret', async () => {
    const res = await POST(makeRequest('wrong'));
    expect(res.status).toBe(401);
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('pages a human about a stalled PR based on trunk', async () => {
    stalledPr({ prBaseRef: TRUNK });

    const res = await POST(makeRequest());

    expect(res.status).toBe(200);
    expect(mockNotify).toHaveBeenCalledTimes(1);
  });

  it('does not page a human about a task PR based on the mission integration branch', async () => {
    stalledPr({ prBaseRef: INTEGRATION_BRANCH });

    const res = await POST(makeRequest());

    expect(res.status).toBe(200);
    expect(mockNotify).not.toHaveBeenCalled();
    expect(insertedNotes).toHaveLength(0);
  });

  it('still pages when the mission has not opted in, whatever the branch is named', async () => {
    stalledPr({ prBaseRef: INTEGRATION_BRANCH, integrationBranchEnabled: false });

    await POST(makeRequest());

    expect(mockNotify).toHaveBeenCalledTimes(1);
  });

  it('still pages when the base ref is unknown', async () => {
    // Null is "we do not know where this PR is going". It has to degrade to
    // today's gate; treating it as quarantined would drop the page silently.
    stalledPr({ prBaseRef: null });

    await POST(makeRequest());

    expect(mockNotify).toHaveBeenCalledTimes(1);
  });

  it("selects the base ref and only the mission's integration fields", async () => {
    // Asserted on the SELECTED columns, not the returned rows: the db mock hands
    // back whatever the test staged regardless of what was asked for, so a
    // behavioural assertion alone would survive dropping a column.
    stalledPr({ prBaseRef: INTEGRATION_BRANCH });

    await POST(makeRequest());

    expect(mockWorkersFindMany.mock.calls[0]?.[0]?.columns?.prBaseRef).toBe(true);

    const missionColumns = (mockMissionsFindMany.mock.calls as any[])[0]?.[0]?.columns;
    expect(missionColumns).toMatchObject({ workingBranch: true, integrationBranchEnabled: true });
    // Exactly the Option A' rule and nothing else. This cron has always resolved
    // its policy from the workspace alone; feeding it mission-level mergePolicy
    // or requiresReview would change which PRs it pages about for reasons that
    // have nothing to do with integration branches.
    expect(missionColumns.mergePolicy).toBeUndefined();
    expect(missionColumns.requiresReview).toBeUndefined();
  });
});
