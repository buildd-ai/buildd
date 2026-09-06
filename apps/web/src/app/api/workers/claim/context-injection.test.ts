import { describe, it, expect, mock, beforeEach } from 'bun:test';

// Mock the retrieval path before importing the module under test. These tests
// are about the SELECTION decision — which retrieval shape a claim gets, and
// what gets recorded about it — so retrieval itself is stubbed and only the
// calls are asserted. The executor's own behaviour is covered in
// apps/web/src/lib/knowledge-context.test.ts against a real fixture store.
function stubAssembly(over: Record<string, unknown> = {}) {
  return {
    assemblyId: 'assembly-1',
    at: '2026-09-05T00:00:00.000Z',
    recipe: 'tool-infra-error-v1',
    source: 'live' as const,
    workspaceId: 'ws-1',
    teamId: 'team-1',
    trigger: { layer: 'exec' as const },
    derivedKeys: {},
    items: [],
    weakEscalationFired: false,
    fallbackFired: false,
    chain: {},
    ...over,
  };
}

const mockClustered = mock(async () => ({ parts: ['## clustered block'], assembly: stubAssembly() }));
const mockFanOut = mock(async () => ['## fan-out block']);
const mockLog = mock(() => {});
const realModule = await import('@/lib/knowledge-context');

mock.module('@/lib/knowledge-context', () => ({
  buildClusteredKnowledgeContext: mockClustered,
  buildKnowledgeContext: mockFanOut,
  buildEntityCatalogContext: mock(async () => ''),
  logContextAssembly: mockLog,
  // Not stubbed: the denominator record is the thing under test here, so the
  // real builder runs.
  buildFanOutAssembly: realModule.buildFanOutAssembly,
}));

import { attachKnowledgeContext } from './context-injection';

const WORKSPACE = { teamId: 'team-1', dataClass: 'normal' };

function claim(task: Record<string, unknown>) {
  const full = { id: 'task-1', title: 'Fix the sandbox', workspaceId: 'ws-1', workspace: WORKSPACE, ...task };
  const worker = { id: 'worker-1', taskId: full.id, branch: 'b', task: { ...full } } as any;
  return { workers: [worker] as any, tasks: [full as any] };
}

const logged = () => mockLog.mock.calls.map(c => c[0] as any);

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
      { subjectKind: 'error', subjectErrorSignature: 'compiler:ts2345' },
      { subjectKind: 'error', subjectErrorSignature: null },
      // worker-failure is an unbounded prose-derived namespace, so it is out of
      // scope: toFrictionSignature renders any error into it.
      { subjectKind: 'error', subjectErrorSignature: 'worker-failure:stale_worker_expired_1a2b3c' },
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
  });
});

describe('attachKnowledgeContext — every claim gets a record', () => {
  it('logs the recipe record when the recipe served the request', async () => {
    const { workers, tasks } = claim({ subjectKind: 'error', subjectErrorSignature: 'oom_killed' });
    await attachKnowledgeContext(workers, tasks);
    expect(logged()).toHaveLength(1);
    expect(logged()[0].recipe).toBe('tool-infra-error-v1');
  });

  it('logs a fan-out record for a task with no recipe — the denominator', async () => {
    // Without this, "no tool-infra-error-v1 lines today" is indistinguishable
    // from "no eligible tasks" and from "the selector regressed".
    const { workers, tasks } = claim({ subjectKind: 'pull_request' });
    await attachKnowledgeContext(workers, tasks);

    expect(logged()).toHaveLength(1);
    const rec = logged()[0];
    expect(rec.recipe).toBe('default-fan-out-v0');
    expect(rec.trigger).toEqual({ layer: 'exec', subjectKind: 'pull_request', signature: null });
    expect(rec.chain.taskId).toBe('task-1');
    expect(rec.workspaceId).toBe('ws-1');
    expect(rec.items[0].reason).toBe('fallback_semantic_search');
  });

  it('records when the fan-out itself returned nothing', async () => {
    mockFanOut.mockImplementationOnce(async () => []);
    const { workers, tasks } = claim({});
    await attachKnowledgeContext(workers, tasks);
    expect(logged()[0].items[0].reason).toBe('step_query_empty');
  });

  it('logs exactly one record per claimed worker', async () => {
    const a = claim({ subjectKind: 'error', subjectErrorSignature: 'oom_killed' });
    const b = claim({ subjectKind: 'mission' });
    b.tasks[0].id = 'task-2';
    b.workers[0].taskId = 'task-2';
    b.workers[0].id = 'worker-2';
    await attachKnowledgeContext([...a.workers, ...b.workers] as any, [...a.tasks, ...b.tasks]);
    expect(logged()).toHaveLength(2);
    expect(logged().map(r => r.recipe).sort()).toEqual(['default-fan-out-v0', 'tool-infra-error-v1']);
  });

  it('does not log twice when the recipe fell through to the fan-out', async () => {
    // The recipe record already carries fallbackFired; a second fan-out record
    // for the same assembly would double-count the denominator.
    mockClustered.mockImplementationOnce(async () => ({
      parts: [], assembly: stubAssembly({ fallbackFired: true }),
    }));
    const { workers, tasks } = claim({ subjectKind: 'error', subjectErrorSignature: 'timeout' });
    await attachKnowledgeContext(workers, tasks);

    expect(mockFanOut).toHaveBeenCalledTimes(1);
    expect(workers[0].resolvedContextProviders[0]).toContain('fan-out block');
    expect(logged()).toHaveLength(1);
    expect(logged()[0].recipe).toBe('tool-infra-error-v1');
    expect(logged()[0].fallbackFired).toBe(true);
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

  it('labels a static component guess as a guess, not as an extraction', async () => {
    // Otherwise the obvious cohort question — did a path the error actually
    // named beat a hardcoded per-slug guess — is unanswerable from the log.
    const { workers, tasks } = claim({
      subjectKind: 'error',
      subjectErrorSignature: 'bwrap_namespace_denied',
      context: { frictionExcerpt: 'bwrap: No permissions to creating new namespace' },
    });
    await attachKnowledgeContext(workers, tasks);

    const { keys } = mockClustered.mock.calls[0]![0] as any;
    expect(keys.paths.length).toBeGreaterThan(0);
    expect(keys.pathsDerivedBy).toBe('pattern_component_table');
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

  it('survives a path_manifest that is not an array', async () => {
    // jsonb carries only a compile-time $type assertion, and this runs after
    // the claim has committed worker rows — a throw here is a 500 with tasks
    // stranded in `assigned`.
    for (const bad of ['apps/x.ts', 42, {}, [1, 2], [null]]) {
      mockClustered.mockClear();
      const { workers, tasks } = claim({
        subjectKind: 'error',
        subjectErrorSignature: 'oom_killed',
        pathManifest: bad as any,
      });
      await attachKnowledgeContext(workers, tasks);
      expect(mockClustered).toHaveBeenCalledTimes(1);
      expect((mockClustered.mock.calls[0]![0] as any).keys.paths).toEqual([]);
    }
  });
});
