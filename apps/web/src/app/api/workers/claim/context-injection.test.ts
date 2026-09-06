import { describe, it, expect, mock, beforeEach } from 'bun:test';

// Mock the retrieval path before importing the module under test. The point of
// these tests is the SELECTION decision — which retrieval shape a claim gets —
// so the retrieval itself is stubbed and only the calls are asserted.
const mockClustered = mock(async () => ({
  parts: ['## clustered block'],
  assembly: {
    assemblyId: 'assembly-1',
    recipe: 'tool-infra-error-v1',
    source: 'live' as const,
    trigger: { layer: 'exec' as const },
    derivedKeys: {},
    items: [],
    weakEscalationFired: false,
    fallbackFired: false,
    chain: {},
  },
}));
const mockFanOut = mock(async () => ['## fan-out block']);
const mockLog = mock(() => {});

mock.module('@/lib/knowledge-context', () => ({
  buildClusteredKnowledgeContext: mockClustered,
  buildKnowledgeContext: mockFanOut,
  buildEntityCatalogContext: mock(async () => ''),
  logContextAssembly: mockLog,
}));

import { attachKnowledgeContext } from './context-injection';

const WORKSPACE = { teamId: 'team-1', dataClass: 'normal' };

function claim(task: Record<string, unknown>) {
  const full = { id: 'task-1', title: 'Fix the sandbox', workspaceId: 'ws-1', workspace: WORKSPACE, ...task };
  const worker = { id: 'worker-1', taskId: full.id, branch: 'b', task: { ...full } } as any;
  return { workers: [worker] as any, tasks: [full as any] };
}

beforeEach(() => {
  mockClustered.mockClear();
  mockFanOut.mockClear();
  mockLog.mockClear();
});

describe('attachKnowledgeContext — cluster selection', () => {
  it('uses the tool-infra recipe for an in-scope error subject', async () => {
    const { workers, tasks } = claim({
      subjectKind: 'error',
      subjectErrorSignature: 'bwrap_namespace_denied',
      pathManifest: ['apps/runner/src/env-scan.ts'],
    });
    await attachKnowledgeContext(workers, tasks);

    expect(mockClustered).toHaveBeenCalledTimes(1);
    expect(mockFanOut).not.toHaveBeenCalled();
    expect(workers[0].resolvedContextProviders[0]).toContain('clustered block');
  });

  it('leaves every other task on the default fan-out, unchanged', async () => {
    for (const task of [
      {},
      { subjectKind: 'pull_request', subjectPrNumber: 7 },
      { subjectKind: 'mission' },
      // An error subject whose signature is out of the recipe's scope.
      { subjectKind: 'error', subjectErrorSignature: 'compiler:ts2345' },
      // An error subject with no signature at all.
      { subjectKind: 'error', subjectErrorSignature: null },
    ]) {
      mockClustered.mockClear();
      mockFanOut.mockClear();
      const { workers, tasks } = claim(task);
      await attachKnowledgeContext(workers, tasks);
      expect(mockClustered).not.toHaveBeenCalled();
      expect(mockFanOut).toHaveBeenCalledTimes(1);
    }
  });

  it('records the chain identifiers and the trigger on the assembly call', async () => {
    const { workers, tasks } = claim({
      subjectKind: 'error',
      subjectErrorSignature: 'oom_killed',
      missionId: 'mission-9',
      pathManifest: ['apps/runner/src/workers.ts'],
    });
    await attachKnowledgeContext(workers, tasks);

    const arg = mockClustered.mock.calls[0]![0] as any;
    expect(arg.chain).toEqual({ taskId: 'task-1', workerId: 'worker-1', missionId: 'mission-9' });
    expect(arg.trigger).toEqual({ layer: 'exec', subjectKind: 'error', signature: 'oom_killed' });
    expect(mockLog).toHaveBeenCalledTimes(1);
  });
});

describe('attachKnowledgeContext — key derivation', () => {
  it('prefers a concrete path manifest and reports it as such', async () => {
    const { workers, tasks } = claim({
      subjectKind: 'error',
      subjectErrorSignature: 'oom_killed',
      pathManifest: ['apps/runner/src/workers.ts'],
      context: { frictionExcerpt: 'killed process at /repo/apps/web/src/other.ts:3' },
    });
    await attachKnowledgeContext(workers, tasks);

    const { keys } = mockClustered.mock.calls[0]![0] as any;
    expect(keys.paths).toEqual(['apps/runner/src/workers.ts']);
    expect(keys.pathsDerivedBy).toBe('path_manifest');
  });

  it('extracts paths from the error excerpt when the manifest is the scope sentinel', async () => {
    const { workers, tasks } = claim({
      subjectKind: 'error',
      subjectErrorSignature: 'enoent',
      pathManifest: ['**'],
      context: { frictionExcerpt: "ENOENT: no such file or directory, open '/repo/apps/runner/src/env-scan.ts'" },
    });
    await attachKnowledgeContext(workers, tasks);

    const { keys } = mockClustered.mock.calls[0]![0] as any;
    expect(keys.paths).toEqual(['apps/runner/src/env-scan.ts']);
    expect(keys.pathsDerivedBy).toBe('regex_path_extract');
  });

  it('falls back to the pattern component table when the excerpt names no file', async () => {
    const { workers, tasks } = claim({
      subjectKind: 'error',
      subjectErrorSignature: 'bwrap_namespace_denied',
      context: { frictionExcerpt: 'bwrap: No permissions to creating new namespace' },
    });
    await attachKnowledgeContext(workers, tasks);

    const { keys } = mockClustered.mock.calls[0]![0] as any;
    expect(keys.paths.length).toBeGreaterThan(0);
    expect(keys.pathsDerivedBy).toBe('regex_path_extract');
  });

  it('reports no path provenance when no paths could be derived at all', async () => {
    const { workers, tasks } = claim({
      subjectKind: 'error',
      subjectErrorSignature: 'rate_limit',
      context: { frictionExcerpt: '429 Too Many Requests' },
    });
    await attachKnowledgeContext(workers, tasks);

    const { keys } = mockClustered.mock.calls[0]![0] as any;
    expect(keys.paths).toEqual([]);
    expect(keys.pathsDerivedBy).toBeUndefined();
    expect(keys.signature).toBe('rate_limit');
  });
});

describe('attachKnowledgeContext — the recipe is a priority, not an exclusion', () => {
  it('falls through to the fan-out when the recipe yields nothing, and records it', async () => {
    mockClustered.mockImplementationOnce(async () => ({
      parts: [],
      assembly: {
        assemblyId: 'assembly-2',
        recipe: 'tool-infra-error-v1',
        source: 'live' as const,
        trigger: { layer: 'exec' as const },
        derivedKeys: {},
        items: [],
        weakEscalationFired: false,
        fallbackFired: false,
        chain: {},
      },
    }));

    const { workers, tasks } = claim({ subjectKind: 'error', subjectErrorSignature: 'timeout' });
    await attachKnowledgeContext(workers, tasks);

    expect(mockFanOut).toHaveBeenCalledTimes(1);
    expect(workers[0].resolvedContextProviders[0]).toContain('fan-out block');
    expect((mockLog.mock.calls[0]![0] as any).fallbackFired).toBe(true);
  });

  it('does not mark fallbackFired when the recipe served the request', async () => {
    const { workers, tasks } = claim({ subjectKind: 'error', subjectErrorSignature: 'timeout' });
    await attachKnowledgeContext(workers, tasks);
    expect((mockLog.mock.calls[0]![0] as any).fallbackFired).toBe(false);
  });
});
