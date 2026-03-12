import { describe, it, expect, beforeEach, mock } from 'bun:test';

// --- Mocks ---
const mockArtifactsFindMany = mock(() => Promise.resolve([] as any[]));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      artifacts: { findMany: mockArtifactsFindMany },
    },
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
}));

mock.module('@buildd/core/db/schema', () => ({
  artifacts: 'artifacts',
}));

import { checkWorkerDeliverables } from './worker-deliverables';

describe('checkWorkerDeliverables', () => {
  beforeEach(() => {
    mockArtifactsFindMany.mockReset();
    mockArtifactsFindMany.mockResolvedValue([]);
  });

  it('returns all false when worker has no deliverables', async () => {
    const result = await checkWorkerDeliverables('worker-1', {});
    expect(result.hasPR).toBe(false);
    expect(result.hasArtifacts).toBe(false);
    expect(result.hasStructuredOutput).toBe(false);
    expect(result.hasCommits).toBe(false);
    expect(result.hasAny).toBe(false);
    expect(result.details).toBe('none');
  });

  it('detects PR via prUrl', async () => {
    const result = await checkWorkerDeliverables('worker-1', {
      prUrl: 'https://github.com/org/repo/pull/42',
      prNumber: 42,
    });
    expect(result.hasPR).toBe(true);
    expect(result.hasAny).toBe(true);
    expect(result.details).toContain('PR #42');
  });

  it('detects PR via prUrl even without prNumber', async () => {
    const result = await checkWorkerDeliverables('worker-1', {
      prUrl: 'https://github.com/org/repo/pull/42',
    });
    expect(result.hasPR).toBe(true);
    expect(result.hasAny).toBe(true);
  });

  it('detects artifacts from database', async () => {
    mockArtifactsFindMany.mockResolvedValue([
      { id: 'art-1', type: 'report', title: 'Analysis Report' },
    ]);

    const result = await checkWorkerDeliverables('worker-1', {});
    expect(result.hasArtifacts).toBe(true);
    expect(result.hasAny).toBe(true);
    expect(result.details).toContain('1 artifact');
  });

  it('detects multiple artifacts', async () => {
    mockArtifactsFindMany.mockResolvedValue([
      { id: 'art-1', type: 'report', title: 'Report 1' },
      { id: 'art-2', type: 'data', title: 'Data Export' },
    ]);

    const result = await checkWorkerDeliverables('worker-1', {});
    expect(result.hasArtifacts).toBe(true);
    expect(result.details).toContain('2 artifacts');
  });

  it('detects structured output from task result', async () => {
    const result = await checkWorkerDeliverables('worker-1', {}, {
      structuredOutput: { status: 'ok', data: [1, 2, 3] },
    });
    expect(result.hasStructuredOutput).toBe(true);
    expect(result.hasAny).toBe(true);
    expect(result.details).toContain('structured output');
  });

  it('ignores empty object as structured output', async () => {
    const result = await checkWorkerDeliverables('worker-1', {}, {
      structuredOutput: {},
    });
    expect(result.hasStructuredOutput).toBe(false);
    expect(result.hasAny).toBe(false);
  });

  it('detects commits via commitCount', async () => {
    const result = await checkWorkerDeliverables('worker-1', {
      commitCount: 3,
    });
    expect(result.hasCommits).toBe(true);
    expect(result.hasAny).toBe(true);
    expect(result.details).toContain('3 commits');
  });

  it('ignores zero commitCount', async () => {
    const result = await checkWorkerDeliverables('worker-1', {
      commitCount: 0,
    });
    expect(result.hasCommits).toBe(false);
    expect(result.hasAny).toBe(false);
  });

  it('combines multiple deliverable types in details', async () => {
    mockArtifactsFindMany.mockResolvedValue([
      { id: 'art-1', type: 'report', title: 'Report' },
    ]);

    const result = await checkWorkerDeliverables('worker-1', {
      prUrl: 'https://github.com/org/repo/pull/10',
      prNumber: 10,
      commitCount: 5,
    }, {
      structuredOutput: { result: true },
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

  it('handles null/undefined worker fields gracefully', async () => {
    const result = await checkWorkerDeliverables('worker-1', {
      prUrl: null,
      prNumber: null,
      commitCount: null,
    });
    expect(result.hasPR).toBe(false);
    expect(result.hasCommits).toBe(false);
    expect(result.hasAny).toBe(false);
  });

  it('handles null task result gracefully', async () => {
    const result = await checkWorkerDeliverables('worker-1', {}, null);
    expect(result.hasStructuredOutput).toBe(false);
    expect(result.hasAny).toBe(false);
  });

  it('handles undefined task result gracefully', async () => {
    const result = await checkWorkerDeliverables('worker-1', {});
    expect(result.hasStructuredOutput).toBe(false);
    expect(result.hasAny).toBe(false);
  });

  it('handles artifacts query failure gracefully', async () => {
    mockArtifactsFindMany.mockRejectedValue(new Error('DB error'));

    const result = await checkWorkerDeliverables('worker-1', {
      prUrl: 'https://github.com/org/repo/pull/1',
    });
    // Should still detect PR even if artifacts query fails
    expect(result.hasPR).toBe(true);
    expect(result.hasArtifacts).toBe(false);
    expect(result.hasAny).toBe(true);
  });
});
