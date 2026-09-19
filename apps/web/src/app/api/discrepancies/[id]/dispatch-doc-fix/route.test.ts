import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// POST /api/discrepancies/[id]/dispatch-doc-fix — the "Dispatch doc fix"
// action on a grouped code-ahead DISCREPANCY card.

let currentUser: any = { id: 'u-1', email: 'max@example.com' };
let apiAccountRow: any = null;
let discrepancyRow: any = null;
let workspaceAccessResult: any = { teamId: 'team-1', role: 'owner' };
let accountWorkspaceAccess = true;

let groupRows: any[] = [];
let claimedTaskRows: any[] = [];
let claimedWorkerRows: any[] = [];
let claimReturn: any[] = [];
let refetchedRow: any = null;

let insertedTasks: any[] = [];
let deletedTaskIds: any[] = [];
let dispatchCalls: any[] = [];
let findFirstCallCount = 0;

mock.module('drizzle-orm', () => ({
  eq: (...args: any[]) => ({ _op: 'eq', args }),
  and: (...args: any[]) => ({ _op: 'and', args }),
  or: (...args: any[]) => ({ _op: 'or', args }),
  inArray: (...args: any[]) => ({ _op: 'inArray', args }),
  isNull: (...args: any[]) => ({ _op: 'isNull', args }),
}));

mock.module('@buildd/core/db/schema', () => ({
  specDiscrepancies: {
    id: 'id', workspaceId: 'workspace_id', specPath: 'spec_path', assertionId: 'assertion_id',
    direction: 'direction', status: 'status', evidence: 'evidence',
    docFixTaskId: 'doc_fix_task_id', firstSeenAt: 'first_seen_at', lastCheckedAt: 'last_checked_at',
  },
  tasks: { id: 'id', status: 'status' },
  workers: { taskId: 'task_id', prLifecycleStatus: 'pr_lifecycle_status', mergedAt: 'merged_at', startedAt: 'started_at' },
  workspaces: { id: 'id' },
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      specDiscrepancies: {
        findFirst: () => {
          findFirstCallCount++;
          return Promise.resolve(findFirstCallCount === 1 ? discrepancyRow : refetchedRow);
        },
      },
      tasks: { findMany: () => Promise.resolve(claimedTaskRows) },
      workers: { findMany: () => Promise.resolve(claimedWorkerRows) },
      workspaces: { findFirst: () => Promise.resolve({ id: 'ws-1', name: 'buildd' }) },
    },
    select: () => ({ from: () => ({ where: () => Promise.resolve(groupRows) }) }),
    insert: () => ({
      values: (v: any) => {
        insertedTasks.push(v);
        return { returning: () => Promise.resolve([{ id: 'task-new', ...v }]) };
      },
    }),
    update: () => ({
      set: () => ({ where: () => ({ returning: () => Promise.resolve(claimReturn) }) }),
    }),
    delete: () => ({ where: (cond: any) => { deletedTaskIds.push(cond); return Promise.resolve(); } }),
  },
}));

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: () => Promise.resolve(currentUser) }));
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: () => Promise.resolve(apiAccountRow) }));
mock.module('@/lib/team-access', () => ({
  verifyWorkspaceAccess: () => Promise.resolve(workspaceAccessResult),
  verifyAccountWorkspaceAccess: () => Promise.resolve(accountWorkspaceAccess),
}));
mock.module('@/lib/task-dispatch', () => ({
  dispatchNewTask: (task: any) => { dispatchCalls.push(task); return Promise.resolve(); },
}));

import { POST } from './route';

const SPEC = 'docs/design/runner-oauth-broker.md';

function reset() {
  currentUser = { id: 'u-1', email: 'max@example.com' };
  apiAccountRow = null;
  discrepancyRow = {
    id: 'd1', workspaceId: 'ws-1', specPath: SPEC, assertionId: 'a1',
    direction: 'code_ahead', status: 'open', docFixTaskId: null,
  };
  workspaceAccessResult = { teamId: 'team-1', role: 'owner' };
  accountWorkspaceAccess = true;
  groupRows = ['a1', 'a2', 'a3', 'a4'].map((a, i) => ({
    id: `d${i + 1}`,
    assertionId: a,
    evidence: { detail: `${a} passes` },
    docFixTaskId: null,
    firstSeenAt: new Date(2026, 7, i + 1),
  }));
  claimedTaskRows = [];
  claimedWorkerRows = [];
  claimReturn = groupRows.map((r) => ({ id: r.id }));
  refetchedRow = null;
  insertedTasks = [];
  deletedTaskIds = [];
  dispatchCalls = [];
  findFirstCallCount = 0;
}

function req() {
  return new NextRequest(`http://localhost/api/discrepancies/d1/dispatch-doc-fix`, {
    method: 'POST',
    body: JSON.stringify({}),
    headers: { 'content-type': 'application/json' },
  });
}
const params = (id: string) => Promise.resolve({ id });

describe('POST /api/discrepancies/[id]/dispatch-doc-fix', () => {
  beforeEach(reset);

  it('401s with neither a session nor an API key', async () => {
    currentUser = null;
    const res = await POST(req(), { params: params('d1') });
    expect(res.status).toBe(401);
  });

  it('403s for a non-admin API key', async () => {
    currentUser = null;
    apiAccountRow = { id: 'acct-1', level: 'worker' };
    const res = await POST(req(), { params: params('d1') });
    expect(res.status).toBe(403);
  });

  it('404s when the row does not exist', async () => {
    discrepancyRow = null;
    const res = await POST(req(), { params: params('missing') });
    expect(res.status).toBe(404);
  });

  it('404s when the user lacks access to the row\'s workspace', async () => {
    workspaceAccessResult = null;
    const res = await POST(req(), { params: params('d1') });
    expect(res.status).toBe(404);
  });

  it('refuses a spec_ahead row — unbuilt work is a build, not a doc fix', async () => {
    discrepancyRow.direction = 'spec_ahead';
    const res = await POST(req(), { params: params('d1') });
    expect(res.status).toBe(400);
    expect(insertedTasks).toHaveLength(0);
  });

  it('refuses a contradicted row — it needs adjudicating before anyone knows which fix applies', async () => {
    discrepancyRow.direction = 'contradicted';
    const res = await POST(req(), { params: params('d1') });
    expect(res.status).toBe(400);
    expect(insertedTasks).toHaveLength(0);
  });

  it('refuses a row that is not open', async () => {
    discrepancyRow.status = 'accepted';
    const res = await POST(req(), { params: params('d1') });
    expect(res.status).toBe(409);
    expect(insertedTasks).toHaveLength(0);
  });

  it('files exactly ONE docs-only task for the whole spec path and claims every row on it', async () => {
    const res = await POST(req(), { params: params('d1') });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toMatchObject({ ok: true, dispatched: true, taskId: 'task-new', specPath: SPEC });
    expect(data.assertionIds).toEqual(['a1', 'a2', 'a3', 'a4']);
    expect(data.claimedDiscrepancyIds).toEqual(['d1', 'd2', 'd3', 'd4']);

    expect(insertedTasks).toHaveLength(1);
    expect(dispatchCalls).toHaveLength(1);
  });

  it('the dispatched task carries the assertion ids, the spec path as its manifest, and a PR requirement', async () => {
    await POST(req(), { params: params('d1') });
    const task = insertedTasks[0];
    expect(task.outputRequirement).toBe('pr_required');
    expect(task.pathManifest).toEqual([SPEC]);
    expect(task.title).toContain(SPEC);
    // The §11 dispatch injection reads the ledger itself; this is the copy the
    // worker sees in the task body, and it must name what it is discharging.
    for (const a of ['a1', 'a2', 'a3', 'a4']) expect(task.description).toContain(a);
    expect(task.context.specDocFix).toEqual({
      specPath: SPEC,
      assertionIds: ['a1', 'a2', 'a3', 'a4'],
      discrepancyIds: ['d1', 'd2', 'd3', 'd4'],
      workspaceId: 'ws-1',
    });
  });

  it('the dispatched task is a planning task whose plan is optional and never auto-approved', async () => {
    await POST(req(), { params: params('d1') });
    const task = insertedTasks[0];
    expect(task.mode).toBe('planning');
    expect(task.context.planOptional).toBe(true);
    // Spec before code: a proposal is never dispatched without a human.
    expect(task.context.requiresPlanApproval).toBe(true);
  });

  it('the task never touches row status — closure stays mechanical', async () => {
    await POST(req(), { params: params('d1') });
    const task = insertedTasks[0];
    expect(task.description).toMatch(/Do not close the ledger rows/);
    expect(task.status).toBe('pending'); // the TASK's status, not any row's
  });

  it('double-tap: a live claim on the path returns the existing task and files nothing', async () => {
    groupRows[0].docFixTaskId = 'task-existing';
    claimedTaskRows = [{ id: 'task-existing', status: 'in_progress' }];
    const res = await POST(req(), { params: params('d1') });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ ok: true, dispatched: false, taskId: 'task-existing' });
    expect(insertedTasks).toHaveLength(0);
    expect(dispatchCalls).toHaveLength(0);
  });

  it('a sibling row on a path already being fixed attaches to the same task', async () => {
    // The tapped row itself is unclaimed; a DIFFERENT row on the same doc holds
    // the claim. One doc, one fix.
    groupRows[2].docFixTaskId = 'task-existing';
    claimedTaskRows = [{ id: 'task-existing', status: 'pending' }];
    const res = await POST(req(), { params: params('d1') });
    const data = await res.json();
    expect(data).toEqual({ ok: true, dispatched: false, taskId: 'task-existing' });
    expect(insertedTasks).toHaveLength(0);
  });

  it('a completed doc-fix task still holds the path — the rows are waiting on the checker, not on a second fix', async () => {
    groupRows[0].docFixTaskId = 'task-done';
    claimedTaskRows = [{ id: 'task-done', status: 'completed' }];
    const res = await POST(req(), { params: params('d1') });
    const data = await res.json();
    expect(data.dispatched).toBe(false);
    expect(insertedTasks).toHaveLength(0);
  });

  it('a failed doc-fix task releases the path — the human gets a real dispatch again', async () => {
    groupRows[0].docFixTaskId = 'task-dead';
    claimedTaskRows = [{ id: 'task-dead', status: 'failed' }];
    const res = await POST(req(), { params: params('d1') });
    const data = await res.json();
    expect(data.dispatched).toBe(true);
    expect(insertedTasks).toHaveLength(1);
  });

  it('a completed task whose PR merged and was rechecked but the gap is STILL open releases the path (stranded-card regression)', async () => {
    groupRows[0].docFixTaskId = 'task-stale';
    groupRows[0].lastCheckedAt = new Date('2026-09-02T00:00:00Z'); // after the merge below
    claimedTaskRows = [{ id: 'task-stale', status: 'completed' }];
    claimedWorkerRows = [{ taskId: 'task-stale', prLifecycleStatus: 'merged', mergedAt: new Date('2026-09-01T00:00:00Z') }];
    const res = await POST(req(), { params: params('d1') });
    const data = await res.json();
    expect(data.dispatched).toBe(true);
    expect(insertedTasks).toHaveLength(1);
  });

  it('a completed task whose PR merged but has NOT been rechecked yet still holds the path', async () => {
    groupRows[0].docFixTaskId = 'task-fresh';
    groupRows[0].lastCheckedAt = new Date('2026-08-25T00:00:00Z'); // before the merge below
    claimedTaskRows = [{ id: 'task-fresh', status: 'completed' }];
    claimedWorkerRows = [{ taskId: 'task-fresh', prLifecycleStatus: 'merged', mergedAt: new Date('2026-09-01T00:00:00Z') }];
    const res = await POST(req(), { params: params('d1') });
    const data = await res.json();
    expect(data.dispatched).toBe(false);
    expect(insertedTasks).toHaveLength(0);
  });

  it('losing the claim race deletes the task it just made and reports the winner — no worker is ever started for it', async () => {
    claimReturn = [];
    refetchedRow = { docFixTaskId: 'task-winner' };
    const res = await POST(req(), { params: params('d1') });
    const data = await res.json();
    expect(data).toEqual({ ok: true, dispatched: false, taskId: 'task-winner' });
    expect(deletedTaskIds).toHaveLength(1);
    expect(dispatchCalls).toHaveLength(0);
  });
});
