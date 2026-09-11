import { describe, it, expect, mock, beforeEach } from 'bun:test';

const mockFindBlock = mock(async (_params: { workspaceId: string; pathManifest?: string[] | null }) => null as string | null);

mock.module('@buildd/core/spec-discrepancy-dispatch', () => ({
  findDispatchDiscrepancyBlock: mockFindBlock,
}));

import { attachDiscrepancyContext } from './context-injection';

function claim(task: Record<string, unknown>) {
  const full = { id: 'task-1', title: 'Rename the mount allowlist', workspaceId: 'ws-1', ...task };
  const worker = { id: 'worker-1', taskId: full.id, branch: 'b', task: { ...full } } as any;
  return { workers: [worker] as any, tasks: [full as any] };
}

beforeEach(() => {
  mockFindBlock.mockClear();
  mockFindBlock.mockImplementation(async () => null);
});

describe('attachDiscrepancyContext', () => {
  it('passes the task workspaceId and pathManifest through to the finder', async () => {
    const { workers, tasks } = claim({ pathManifest: ['apps/runner/src/workers.ts'] });
    await attachDiscrepancyContext(workers, tasks);

    expect(mockFindBlock).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      pathManifest: ['apps/runner/src/workers.ts'],
    });
  });

  it('appends the returned block to resolvedContextProviders on both rails', async () => {
    mockFindBlock.mockImplementation(async () => '## Spec Discrepancies You May Be Closing\n- docs/design/x.md — assertion `a` (spec_ahead): ...');
    const { workers, tasks } = claim({ pathManifest: ['apps/runner/src/workers.ts'] });
    await attachDiscrepancyContext(workers, tasks);

    expect(workers[0].resolvedContextProviders).toHaveLength(1);
    expect(workers[0].resolvedContextProviders[0]).toContain('Spec Discrepancies You May Be Closing');
    expect(workers[0].task.context.resolvedContextProviders[0]).toContain('Spec Discrepancies You May Be Closing');
  });

  it('attaches nothing when the finder returns null', async () => {
    const { workers, tasks } = claim({ pathManifest: ['apps/runner/src/workers.ts'] });
    await attachDiscrepancyContext(workers, tasks);
    expect(workers[0].resolvedContextProviders).toBeUndefined();
  });

  it('a missing pathManifest is passed through as null, not undefined-cast', async () => {
    const { workers, tasks } = claim({});
    await attachDiscrepancyContext(workers, tasks);
    expect(mockFindBlock).toHaveBeenCalledWith({ workspaceId: 'ws-1', pathManifest: null });
  });

  it('is best-effort: a rejected finder attaches nothing and does not throw', async () => {
    mockFindBlock.mockImplementation(async () => {
      throw new Error('db unavailable');
    });
    const { workers, tasks } = claim({ pathManifest: ['apps/runner/src/workers.ts'] });
    await expect(attachDiscrepancyContext(workers, tasks)).resolves.toBeUndefined();
    expect(workers[0].resolvedContextProviders).toBeUndefined();
  });

  it('skips a worker whose task cannot be found', async () => {
    const { workers } = claim({ pathManifest: ['apps/runner/src/workers.ts'] });
    await attachDiscrepancyContext(workers, []);
    expect(mockFindBlock).not.toHaveBeenCalled();
  });
});
