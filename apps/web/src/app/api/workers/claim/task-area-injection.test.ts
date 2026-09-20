import { describe, it, expect, mock, beforeEach } from 'bun:test';

/**
 * Claim-time wiring for the task-area prediction.
 *
 * Two things are under test and neither is the predictor itself (that is
 * `packages/core/__tests__/task-area-prediction*.test.ts`):
 *
 *  1. the prediction reaches the two consumers it is for — the knowledge
 *     recall path filter, and the advisory prompt block plus the
 *     `task.context` hint the runner reads, and
 *  2. it reaches NEITHER of them for a control-arm task, and never reaches
 *     `tasks.path_manifest` at all.
 */
const mockFanOut = mock(async (..._a: unknown[]) => ['## fan-out block']);
const realModule = await import('@/lib/knowledge-context');

mock.module('@/lib/knowledge-context', () => ({
  buildClusteredKnowledgeContext: mock(async () => ({ parts: [], assembly: null })),
  buildKnowledgeContext: mockFanOut,
  buildEntityCatalogContext: mock(async () => ''),
  logContextAssembly: mock(() => {}),
  buildFanOutAssembly: realModule.buildFanOutAssembly,
}));

const { attachKnowledgeContext, attachTaskAreaScope } = await import('./context-injection');
const { TASK_AREA_FALLBACK } = await import('@buildd/core/task-area-prediction');

const PREDICTED = ['apps/web/src/lib/knowledge-context.ts', 'packages/core/path-overlap.ts'];

function claim(task: Record<string, unknown> = {}) {
  const full = {
    id: 'task-1',
    title: 'Fix the claim route',
    workspaceId: 'ws-1',
    workspace: { teamId: 'team-1', dataClass: 'normal' },
    description: 'no paths named here at all',
    ...task,
  };
  const worker = { id: 'worker-1', taskId: full.id, branch: 'b', task: { ...full } } as any;
  return { workers: [worker] as any, tasks: [full as any] };
}

function prediction(over: Record<string, unknown> = {}) {
  return new Map([['task-1', {
    taskId: 'task-1',
    workspaceId: 'ws-1',
    arm: 'neighbour_area',
    propensity: 0.5,
    fraction: 0.5,
    policyVersion: 'task-area-v1',
    predictedPaths: PREDICTED,
    regexPaths: [],
    result: { paths: PREDICTED, contributors: [], considered: 3, topScore: 0.8, truncated: false },
    config: TASK_AREA_FALLBACK,
    ...over,
  } as any]]);
}

beforeEach(() => {
  mockFanOut.mockClear();
});

describe('attachKnowledgeContext — predicted paths as the recall filter', () => {
  it('scopes the fan-out to the predicted area when nothing was declared', async () => {
    const { workers, tasks } = claim({ pathManifest: null });
    await attachKnowledgeContext(workers, tasks, prediction());

    expect((mockFanOut.mock.calls[0] as any[])[4]).toMatchObject({ paths: PREDICTED });
  });

  it('lets a declared manifest win — it is this task\'s author, not other tasks\' diffs', async () => {
    const { workers, tasks } = claim({ pathManifest: ['apps/runner/src/index.ts'] });
    await attachKnowledgeContext(workers, tasks, prediction());

    expect((mockFanOut.mock.calls[0] as any[])[4]).toMatchObject({ paths: ['apps/runner/src/index.ts'] });
  });

  it('leaves a control-arm claim byte-identical to one with no experiment', async () => {
    const { workers, tasks } = claim({ pathManifest: null });
    await attachKnowledgeContext(workers, tasks, prediction({ arm: 'regex_paths' }));

    expect((mockFanOut.mock.calls[0] as any[])[4]).toMatchObject({ paths: [] });
  });

  it('is unchanged when no prediction was computed at all', async () => {
    const { workers, tasks } = claim({ pathManifest: null });
    await attachKnowledgeContext(workers, tasks);

    expect((mockFanOut.mock.calls[0] as any[])[4]).toMatchObject({ paths: [] });
  });
});

describe('attachTaskAreaScope', () => {
  it('appends the advisory block and mirrors the hint for the runner', async () => {
    const { workers, tasks } = claim();
    await attachTaskAreaScope(workers, tasks, prediction());

    const block = workers[0].resolvedContextProviders.at(-1);
    expect(block).toContain('Likely file area');
    expect(block).toContain(PREDICTED[0]);
    expect(block).toContain('ADVISORY');
    expect(workers[0].task.context.predictedTaskArea).toMatchObject({
      arm: 'neighbour_area',
      paths: PREDICTED,
      source: 'diff',
    });
  });

  it('attaches nothing for the control arm', async () => {
    const { workers, tasks } = claim();
    await attachTaskAreaScope(workers, tasks, prediction({ arm: 'regex_paths' }));

    expect(workers[0].resolvedContextProviders).toBeUndefined();
    expect(workers[0].task.context?.predictedTaskArea).toBeUndefined();
  });

  it('attaches nothing when the prediction came back empty', async () => {
    const { workers, tasks } = claim();
    await attachTaskAreaScope(workers, tasks, prediction({ predictedPaths: [] }));

    expect(workers[0].resolvedContextProviders).toBeUndefined();
  });

  // The hard constraint. `tasks.path_manifest` drives path-overlap
  // serialisation and inferred dependsOn — a prediction landing there would
  // defer or block unrelated real work, and the failure would look like
  // ordinary contention rather than a bad guess.
  it('never writes the prediction into pathManifest', async () => {
    const { workers, tasks } = claim({ pathManifest: null });
    await attachTaskAreaScope(workers, tasks, prediction());

    expect((tasks[0] as any).pathManifest).toBeNull();
    expect(workers[0].task.pathManifest).toBeNull();
  });
});
