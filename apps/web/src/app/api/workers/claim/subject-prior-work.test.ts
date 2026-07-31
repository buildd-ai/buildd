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
