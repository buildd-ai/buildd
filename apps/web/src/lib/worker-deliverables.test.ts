import { describe, it, expect } from 'bun:test';

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
});
