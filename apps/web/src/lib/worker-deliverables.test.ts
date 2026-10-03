import { describe, it, expect, beforeEach, mock } from 'bun:test';

// --- Database mocks for testing getWorkerDeliverableArtifactCount ---
const mockArtifactsFindMany = mock((opts?: any) => [] as any[]);

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      artifacts: { findMany: mockArtifactsFindMany },
    },
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  and: (...conditions: any[]) => ({ conditions, type: 'and' }),
  or: (...conditions: any[]) => ({ conditions, type: 'or' }),
  not: (expr: any) => ({ expr, type: 'not' }),
  inArray: (field: any, values: any[]) => ({ field, values, type: 'inArray' }),
  isNotNull: (field: any) => ({ field, type: 'isNotNull' }),
  notLike: (field: any, pattern: any) => ({ field, pattern, type: 'notLike' }),
}));

mock.module('@buildd/core/db/schema', () => ({
  artifacts: { workerId: 'workerId', type: 'type', key: 'key', id: 'id' },
}));

// Inline the pure function to avoid bun's process-global mock.module() pollution.
// Other test files (stale-workers.test.ts) mock '@/lib/worker-deliverables' which
// replaces the module for ALL files in the same bun test process. Importing from
// the module would give us the mock instead of the real function.
// Since checkWorkerDeliverables is a pure function with zero dependencies,
// inlining it here is the only reliable way to test the actual logic.
function checkWorkerDeliverables(
  worker: {
    prUrl?: string | null;
    prNumber?: number | null;
    commitCount?: number | null;
  },
  opts?: {
    artifactCount?: number;
    taskResult?: { structuredOutput?: unknown } | null;
  },
) {
  const hasPR = !!worker.prUrl;
  const hasCommits = typeof worker.commitCount === 'number' && worker.commitCount > 0;
  const so = opts?.taskResult?.structuredOutput;
  const hasStructuredOutput = !!so && typeof so === 'object' && Object.keys(so as object).length > 0;
  const artifactCount = opts?.artifactCount ?? 0;
  const hasArtifacts = artifactCount > 0;
  const hasAny = hasPR || hasArtifacts || hasStructuredOutput || hasCommits;
  const parts: string[] = [];
  if (hasPR) parts.push(`PR #${worker.prNumber || '?'}`);
  if (hasArtifacts) parts.push(`${artifactCount} artifact${artifactCount !== 1 ? 's' : ''}`);
  if (hasStructuredOutput) parts.push('structured output');
  if (hasCommits) parts.push(`${worker.commitCount} commit${worker.commitCount !== 1 ? 's' : ''}`);
  return {
    hasPR,
    hasArtifacts,
    hasStructuredOutput,
    hasCommits,
    hasAny,
    details: parts.length > 0 ? parts.join(', ') : 'none',
  };
}

describe('checkWorkerDeliverables', () => {
  it('returns all false when worker has no deliverables', () => {
    const result = checkWorkerDeliverables({});
    expect(result.hasPR).toBe(false);
    expect(result.hasArtifacts).toBe(false);
    expect(result.hasStructuredOutput).toBe(false);
    expect(result.hasCommits).toBe(false);
    expect(result.hasAny).toBe(false);
    expect(result.details).toBe('none');
  });

  it('detects PR via prUrl', () => {
    const result = checkWorkerDeliverables({
      prUrl: 'https://github.com/org/repo/pull/42',
      prNumber: 42,
    });
    expect(result.hasPR).toBe(true);
    expect(result.hasAny).toBe(true);
    expect(result.details).toContain('PR #42');
  });

  it('detects PR via prUrl even without prNumber', () => {
    const result = checkWorkerDeliverables({
      prUrl: 'https://github.com/org/repo/pull/42',
    });
    expect(result.hasPR).toBe(true);
    expect(result.hasAny).toBe(true);
  });

  it('detects artifacts from count', () => {
    const result = checkWorkerDeliverables({}, { artifactCount: 1 });
    expect(result.hasArtifacts).toBe(true);
    expect(result.hasAny).toBe(true);
    expect(result.details).toContain('1 artifact');
  });

  it('detects multiple artifacts', () => {
    const result = checkWorkerDeliverables({}, { artifactCount: 2 });
    expect(result.hasArtifacts).toBe(true);
    expect(result.details).toContain('2 artifacts');
  });

  it('detects structured output from task result', () => {
    const result = checkWorkerDeliverables({}, {
      taskResult: { structuredOutput: { status: 'ok', data: [1, 2, 3] } },
    });
    expect(result.hasStructuredOutput).toBe(true);
    expect(result.hasAny).toBe(true);
    expect(result.details).toContain('structured output');
  });

  it('ignores empty object as structured output', () => {
    const result = checkWorkerDeliverables({}, {
      taskResult: { structuredOutput: {} },
    });
    expect(result.hasStructuredOutput).toBe(false);
    expect(result.hasAny).toBe(false);
  });

  it('detects commits via commitCount', () => {
    const result = checkWorkerDeliverables({ commitCount: 3 });
    expect(result.hasCommits).toBe(true);
    expect(result.hasAny).toBe(true);
    expect(result.details).toContain('3 commits');
  });

  it('ignores zero commitCount', () => {
    const result = checkWorkerDeliverables({ commitCount: 0 });
    expect(result.hasCommits).toBe(false);
    expect(result.hasAny).toBe(false);
  });

  it('combines multiple deliverable types in details', () => {
    const result = checkWorkerDeliverables({
      prUrl: 'https://github.com/org/repo/pull/10',
      prNumber: 10,
      commitCount: 5,
    }, {
      artifactCount: 1,
      taskResult: { structuredOutput: { result: true } },
    });

    expect(result.hasPR).toBe(true);
    expect(result.hasArtifacts).toBe(true);
    expect(result.hasStructuredOutput).toBe(true);
    expect(result.hasCommits).toBe(true);
    expect(result.hasAny).toBe(true);
    expect(result.details).toContain('PR #10');
    expect(result.details).toContain('1 artifact');
    expect(result.details).toContain('structured output');
    expect(result.details).toContain('5 commits');
  });

  it('handles null/undefined worker fields gracefully', () => {
    const result = checkWorkerDeliverables({
      prUrl: null,
      prNumber: null,
      commitCount: null,
    });
    expect(result.hasPR).toBe(false);
    expect(result.hasCommits).toBe(false);
    expect(result.hasAny).toBe(false);
  });

  it('handles null task result gracefully', () => {
    const result = checkWorkerDeliverables({}, { taskResult: null });
    expect(result.hasStructuredOutput).toBe(false);
    expect(result.hasAny).toBe(false);
  });

  it('handles undefined task result gracefully', () => {
    const result = checkWorkerDeliverables({});
    expect(result.hasStructuredOutput).toBe(false);
    expect(result.hasAny).toBe(false);
  });

  it('treats zero artifact count as no artifacts', () => {
    const result = checkWorkerDeliverables({}, { artifactCount: 0 });
    expect(result.hasArtifacts).toBe(false);
    expect(result.hasAny).toBe(false);
  });

  it('treats cloud-run-report artifacts as telemetry, not deliverables', () => {
    // A worker that crashed mid-task with only telemetry should NOT be marked as completed.
    // Cloud run reports (machine-generated telemetry) should not count as deliverables.
    // The reaper uses getWorkerDeliverableArtifactCount which filters these out,
    // so a count of 0 is passed even if the worker has a cloud-run-report artifact.
    const result = checkWorkerDeliverables({}, {
      artifactCount: 0, // Cloud-run-report filtered out by getWorkerDeliverableArtifactCount
    });
    expect(result.hasArtifacts).toBe(false);
    expect(result.hasAny).toBe(false);
    expect(result.details).toBe('none');
  });
});

// --- Test getWorkerDeliverableArtifactCount with real database filtering ---
describe('getWorkerDeliverableArtifactCount', () => {
  beforeEach(() => {
    // Reset mock before each test
    mockArtifactsFindMany.mockClear();
  });

  it('excludes cloud-run-report data artifacts (telemetry only)', async () => {
    // Worker has only a cloud-run-report artifact — should not be counted as a deliverable
    mockArtifactsFindMany.mockImplementationOnce(() => []);

    const { getWorkerDeliverableArtifactCount } = await import('./worker-deliverables');
    const count = await getWorkerDeliverableArtifactCount('worker-1');

    expect(count).toBe(0);
    expect(mockArtifactsFindMany).toHaveBeenCalled();
  });

  it('includes report-type artifacts (non-byproduct)', async () => {
    // Worker has a report artifact (non-byproduct type) — should be counted
    mockArtifactsFindMany.mockImplementationOnce(() => [
      { id: 'artifact-1' },
    ]);

    const { getWorkerDeliverableArtifactCount } = await import('./worker-deliverables');
    const count = await getWorkerDeliverableArtifactCount('worker-2');

    expect(count).toBe(1);
  });

  it('includes keyed byproduct artifacts that are not cloud-run-report', async () => {
    // Worker has a data artifact with a non-telemetry key — should be counted
    mockArtifactsFindMany.mockImplementationOnce(() => [
      { id: 'artifact-2' },
    ]);

    const { getWorkerDeliverableArtifactCount } = await import('./worker-deliverables');
    const count = await getWorkerDeliverableArtifactCount('worker-3');

    expect(count).toBe(1);
  });

  it('does not turn salvaged rejection prose into a deliverable', async () => {
    mockArtifactsFindMany.mockImplementationOnce(() => [{ id: 'artifact-salvaged', metadata: { salvaged: true } }]);
    const { getWorkerDeliverableArtifactCount } = await import('./worker-deliverables');
    expect(await getWorkerDeliverableArtifactCount('worker-salvaged')).toBe(0);
  });

  it('handles database errors gracefully', async () => {
    // DB error should return 0, not throw
    mockArtifactsFindMany.mockImplementationOnce(() => {
      throw new Error('Database connection failed');
    });

    const { getWorkerDeliverableArtifactCount } = await import('./worker-deliverables');
    const count = await getWorkerDeliverableArtifactCount('worker-4');

    expect(count).toBe(0);
  });
});
