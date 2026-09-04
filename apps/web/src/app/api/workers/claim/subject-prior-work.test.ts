import { describe, it, expect, mock, beforeEach } from 'bun:test';

// ── DB mock setup ─────────────────────────────────────────────────────────────

const mockFindMany = mock(async () => []);

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      tasks: { findMany: mockFindMany },
    },
  },
}));

mock.module('@buildd/core/db/schema', () => ({
  tasks: {
    workspaceId: 'workspaceId',
    subjectPrNumber: 'subjectPrNumber',
    subjectErrorSignature: 'subjectErrorSignature',
    subjectMissionId: 'subjectMissionId',
    id: 'id',
  },
}));

mock.module('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ op: 'and', args }),
  eq: (a: unknown, b: unknown) => ({ op: 'eq', a, b }),
  ne: (a: unknown, b: unknown) => ({ op: 'ne', a, b }),
}));

import { buildSubjectPriorWork } from './subject-prior-work';

const ENABLED = { priorWorkInjection: true };
const DISABLED = { priorWorkInjection: false };

const BASE_TASK = {
  id: 'task-1',
  workspaceId: 'ws-1',
};

beforeEach(() => {
  mockFindMany.mockReset();
  mockFindMany.mockResolvedValue([]);
});

// ── Disabled / no anchor ──────────────────────────────────────────────────────

describe('buildSubjectPriorWork', () => {
  it('returns null when priorWorkInjection is disabled', async () => {
    const result = await buildSubjectPriorWork(
      { ...BASE_TASK, subjectKind: 'pull_request', subjectPrNumber: 42 },
      DISABLED,
    );
    expect(result).toBeNull();
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it('returns null when task has no subject kind', async () => {
    const result = await buildSubjectPriorWork(
      { ...BASE_TASK, subjectKind: null },
      ENABLED,
    );
    expect(result).toBeNull();
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it('returns null when subjectKind is pull_request but prNumber is null', async () => {
    const result = await buildSubjectPriorWork(
      { ...BASE_TASK, subjectKind: 'pull_request', subjectPrNumber: null },
      ENABLED,
    );
    expect(result).toBeNull();
  });

  it('returns null when no sibling tasks found', async () => {
    mockFindMany.mockResolvedValue([]);
    const result = await buildSubjectPriorWork(
      { ...BASE_TASK, subjectKind: 'pull_request', subjectPrNumber: 42 },
      ENABLED,
    );
    expect(result).toBeNull();
  });

  // ── PR anchor ───────────────────────────────────────────────────────────────

  it('builds a block for PR anchor siblings', async () => {
    mockFindMany.mockResolvedValue([
      {
        id: 'sibling-1',
        title: 'Fix the flaky test',
        status: 'completed',
        workers: [
          {
            branch: 'buildd/abc-fix-flaky',
            prNumber: 99,
            prLifecycleStatus: 'merged',
            mergedAt: new Date('2024-01-15T12:00:00Z'),
          },
        ],
      },
    ]);

    const result = await buildSubjectPriorWork(
      { ...BASE_TASK, subjectKind: 'pull_request', subjectPrNumber: 42 },
      ENABLED,
    );

    expect(result).not.toBeNull();
    expect(result).toContain('PR #42');
    expect(result).toContain('[completed] Fix the flaky test');
    expect(result).toContain('PR #99 (merged)');
    expect(result).toContain('Branch: buildd/abc-fix-flaky');
    expect(result).toContain('Merged:');
  });

  it('omits worker lines when task has no worker', async () => {
    mockFindMany.mockResolvedValue([
      { id: 'sibling-2', title: 'Pending task', status: 'pending', workers: [] },
    ]);

    const result = await buildSubjectPriorWork(
      { ...BASE_TASK, subjectKind: 'pull_request', subjectPrNumber: 7 },
      ENABLED,
    );

    expect(result).toContain('[pending] Pending task');
    // Worker PR detail lines are indented — only the header contains bare "PR #N"
    expect(result).not.toContain('  PR #');
    expect(result).not.toContain('Branch:');
  });

  // ── Error anchor ─────────────────────────────────────────────────────────────

  it('builds a block for error anchor siblings', async () => {
    mockFindMany.mockResolvedValue([
      { id: 'sibling-3', title: 'Fix bwrap namespace', status: 'in_progress' },
    ]);

    const result = await buildSubjectPriorWork(
      { ...BASE_TASK, subjectKind: 'error', subjectErrorSignature: 'bwrap_namespace_denied' },
      ENABLED,
    );

    expect(result).toContain('error bwrap_namespace_denied');
    expect(result).toContain('[in_progress] Fix bwrap namespace');
  });

  it('returns null when error subject has no errorSignature', async () => {
    const result = await buildSubjectPriorWork(
      { ...BASE_TASK, subjectKind: 'error', subjectErrorSignature: null },
      ENABLED,
    );
    expect(result).toBeNull();
  });

  // ── Mission anchor ────────────────────────────────────────────────────────────

  it('builds a block for mission anchor siblings', async () => {
    mockFindMany.mockResolvedValue([
      { id: 'sibling-4', title: 'Tax prep task', status: 'pending' },
    ]);

    const result = await buildSubjectPriorWork(
      {
        ...BASE_TASK,
        subjectKind: 'mission',
        subjectMissionId: 'aabbccdd-1234-5678-9abc-def012345678',
      },
      ENABLED,
    );

    expect(result).toContain('mission aabbccdd');
    expect(result).toContain('[pending] Tax prep task');
  });

  // ── Character cap ─────────────────────────────────────────────────────────────

  it('truncates output at MAX_CHARS (2000)', async () => {
    const longTitle = 'A'.repeat(500);
    mockFindMany.mockResolvedValue(
      Array.from({ length: 5 }, (_, i) => ({
        id: `sib-${i}`,
        title: longTitle,
        status: 'pending',
        workers: [],
      })),
    );

    const result = await buildSubjectPriorWork(
      { ...BASE_TASK, subjectKind: 'pull_request', subjectPrNumber: 1 },
      ENABLED,
    );

    expect(result).not.toBeNull();
    expect(result!.length).toBeLessThanOrEqual(2000 + '[truncated]'.length + 1);
    expect(result).toContain('[truncated]');
  });

  // ── Error resilience ─────────────────────────────────────────────────────────

  it('returns null (not throws) when DB call fails', async () => {
    mockFindMany.mockRejectedValue(new Error('DB down'));

    const result = await buildSubjectPriorWork(
      { ...BASE_TASK, subjectKind: 'pull_request', subjectPrNumber: 5 },
      ENABLED,
    );

    expect(result).toBeNull();
  });
});

// ── The sibling query ─────────────────────────────────────────────────────────
//
// Every test above hands the sibling rows straight to the formatter, so the
// query that selects them was never inspected — and drizzle is mocked here into
// plain objects, so inspecting it is free. These mutations were all silent:
//
//   - dropping `eq(tasks.workspaceId, ...)`: siblings are matched by PR number
//     alone, so another team's task titles get pasted into this worker's prompt.
//     Two workspaces on the same repo share PR numbers by construction.
//   - dropping `ne(tasks.id, task.id)`: the task cites itself as prior work and
//     tells the agent to "verify before re-implementing" its own job.
//   - the error branch matching `subject_pr_number` instead of
//     `subject_error_signature`: wrong siblings, or none.
//   - `MAX_SIBLING_TASKS` raised: the block stops being bounded, which is the
//     one property a prompt injection must keep.
//   - `orderBy desc(createdAt)` → `asc`: with a cap of 5 you get the five
//     OLDEST siblings, i.e. the least relevant prior work, and never the PR
//     that just landed.

/** Invoke a drizzle relational `orderBy` callback and report what it asked for. */
function probeOrderBy(orderBy: any): unknown {
  return orderBy(
    { createdAt: 'createdAt', updatedAt: 'updatedAt' },
    {
      desc: (col: unknown) => ({ dir: 'desc', col }),
      asc: (col: unknown) => ({ dir: 'asc', col }),
    },
  );
}

describe('buildSubjectPriorWork — sibling query', () => {
  it('scopes PR siblings to the workspace and excludes the task itself', async () => {
    mockFindMany.mockResolvedValue([]);
    await buildSubjectPriorWork(
      { ...BASE_TASK, subjectKind: 'pull_request', subjectPrNumber: 42 },
      ENABLED,
    );

    const args = mockFindMany.mock.calls.at(-1)![0] as any;
    expect(args.where).toEqual({
      op: 'and',
      args: [
        { op: 'eq', a: 'workspaceId', b: 'ws-1' },
        { op: 'eq', a: 'subjectPrNumber', b: 42 },
        { op: 'ne', a: 'id', b: 'task-1' },
      ],
    });
    expect(args.limit).toBe(5);
    expect(probeOrderBy(args.orderBy)).toEqual([{ dir: 'desc', col: 'createdAt' }]);
    // Only the newest worker per sibling is rendered, so only one is fetched.
    expect(args.with.workers.limit).toBe(1);
    expect(probeOrderBy(args.with.workers.orderBy)).toEqual([
      { dir: 'desc', col: 'createdAt' },
    ]);
  });

  it('matches error siblings on the error signature, workspace-scoped', async () => {
    mockFindMany.mockResolvedValue([]);
    await buildSubjectPriorWork(
      { ...BASE_TASK, subjectKind: 'error', subjectErrorSignature: 'bwrap_namespace_denied' },
      ENABLED,
    );

    const args = mockFindMany.mock.calls.at(-1)![0] as any;
    expect(args.where).toEqual({
      op: 'and',
      args: [
        { op: 'eq', a: 'workspaceId', b: 'ws-1' },
        { op: 'eq', a: 'subjectErrorSignature', b: 'bwrap_namespace_denied' },
        { op: 'ne', a: 'id', b: 'task-1' },
      ],
    });
    expect(args.limit).toBe(5);
    expect(probeOrderBy(args.orderBy)).toEqual([{ dir: 'desc', col: 'createdAt' }]);
  });

  it('matches mission siblings on the mission id, workspace-scoped', async () => {
    mockFindMany.mockResolvedValue([]);
    await buildSubjectPriorWork(
      { ...BASE_TASK, subjectKind: 'mission', subjectMissionId: 'mission-xyz' },
      ENABLED,
    );

    const args = mockFindMany.mock.calls.at(-1)![0] as any;
    expect(args.where).toEqual({
      op: 'and',
      args: [
        { op: 'eq', a: 'workspaceId', b: 'ws-1' },
        { op: 'eq', a: 'subjectMissionId', b: 'mission-xyz' },
        { op: 'ne', a: 'id', b: 'task-1' },
      ],
    });
    expect(args.limit).toBe(5);
  });

  it('never queries for an unrecognised subject kind', async () => {
    // The three branches are exhaustive by construction; a fourth kind (or a
    // typo'd one) must fall through to null rather than issue an unfiltered
    // findMany, which would return arbitrary tasks as "prior work".
    const result = await buildSubjectPriorWork(
      { ...BASE_TASK, subjectKind: 'branch' },
      ENABLED,
    );
    expect(result).toBeNull();
    expect(mockFindMany).not.toHaveBeenCalled();
  });
});
