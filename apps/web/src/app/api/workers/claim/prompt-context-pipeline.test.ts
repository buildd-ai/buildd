import { describe, it, expect, mock, beforeEach } from 'bun:test';

/**
 * Deferred handle so a test can control exactly when a mocked stage
 * "finishes its DB/network work" and hands back its block.
 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

let started: string[] = [];
let finished: string[] = [];
let missionHandoffDeferred = deferred<void>();
let subjectPriorWorkDeferred = deferred<void>();
let discrepancyDeferred = deferred<void>();
let predictionsDeferred = deferred<Map<string, unknown>>();
let knowledgeDeferred = deferred<void>();

const mockAttachMissionHandoff = mock(async (claimedWorkers: any[], _tasks: any[], excluded: Set<string>, sink: any) => {
  started.push('missionHandoff');
  await missionHandoffDeferred.promise;
  excluded.add('task:dep-1');
  for (const cw of claimedWorkers) sink(cw, '## Upstream Task Handoff\nblock');
  finished.push('missionHandoff');
});

const mockAttachSubjectPriorWork = mock(async (claimedWorkers: any[], _tasks: any[], sink: any) => {
  started.push('subjectPriorWork');
  await subjectPriorWorkDeferred.promise;
  for (const cw of claimedWorkers) sink(cw, '## Subject Prior Work\nblock');
  finished.push('subjectPriorWork');
});

const mockAttachDiscrepancyContext = mock(async (claimedWorkers: any[], _tasks: any[], sink: any) => {
  started.push('discrepancy');
  await discrepancyDeferred.promise;
  for (const cw of claimedWorkers) sink(cw, '## Spec Discrepancies\nblock');
  finished.push('discrepancy');
});

const mockPredictTaskAreas = mock(async (_tasks: any[]) => {
  started.push('predictTaskAreas');
  const result = await predictionsDeferred.promise;
  finished.push('predictTaskAreas');
  return result;
});

const mockAttachKnowledgeContext = mock(async (claimedWorkers: any[], _tasks: any[], _predictions: any, excluded: Set<string>, sink: any) => {
  started.push('knowledge');
  // The real dependency this whole pipeline exists to respect: knowledge
  // context reads what mission handoff excluded.
  expect(excluded.has('task:dep-1')).toBe(true);
  await knowledgeDeferred.promise;
  for (const cw of claimedWorkers) sink(cw, '## Retrieved Knowledge\nblock');
  finished.push('knowledge');
});

const mockAppendContextBlock = mock((cw: any, block: string) => {
  cw.resolvedContextProviders = [...(cw.resolvedContextProviders ?? []), block];
});

mock.module('./context-injection', () => ({
  appendContextBlock: mockAppendContextBlock,
  attachKnowledgeContext: mockAttachKnowledgeContext,
  attachSubjectPriorWork: mockAttachSubjectPriorWork,
  attachDiscrepancyContext: mockAttachDiscrepancyContext,
  predictTaskAreas: mockPredictTaskAreas,
}));

mock.module('./mission-handoff-injection', () => ({
  attachMissionHandoff: mockAttachMissionHandoff,
}));

// Arm assignment defaults to "treatment" so every pre-existing test below
// keeps exercising the real predictions-gate-knowledge dependency; the
// dedicated "control arm" tests further down override this per-call.
const mockLoadTaskAreaConfig = mock(async () => ({ enabled: true, fraction: 1 } as any));
const mockAssignTaskAreaArm = mock((_taskId: string, config: any) => ({
  arm: 'neighbour_area',
  propensity: config.fraction,
  fraction: config.fraction,
  policyVersion: config.policyVersion ?? 'v1',
}));

mock.module('@buildd/core/task-area-prediction-source', () => ({
  loadTaskAreaConfig: mockLoadTaskAreaConfig,
}));

mock.module('@buildd/core/task-area-prediction', () => ({
  assignTaskAreaArm: mockAssignTaskAreaArm,
  TASK_AREA_TREATMENT_ARM: 'neighbour_area',
}));

const { runDependentContextInjections } = await import('./prompt-context-pipeline');

function claimedWorker(id: string) {
  return { id, taskId: id, branch: 'b', task: { id, context: {} } } as any;
}

beforeEach(() => {
  started = [];
  finished = [];
  missionHandoffDeferred = deferred<void>();
  subjectPriorWorkDeferred = deferred<void>();
  discrepancyDeferred = deferred<void>();
  predictionsDeferred = deferred<Map<string, unknown>>();
  knowledgeDeferred = deferred<void>();
  mockAttachMissionHandoff.mockClear();
  mockAttachSubjectPriorWork.mockClear();
  mockAttachDiscrepancyContext.mockClear();
  mockPredictTaskAreas.mockClear();
  mockAttachKnowledgeContext.mockClear();
  mockAppendContextBlock.mockClear();
  mockLoadTaskAreaConfig.mockClear();
  mockAssignTaskAreaArm.mockClear();
});

describe('runDependentContextInjections', () => {
  it('starts predictTaskAreas, mission handoff, subject-prior-work and discrepancy together, before any resolves', () => {
    const cw = claimedWorker('task-1');
    const claimedTasks = [{ id: 'task-1', title: 'Fix the thing', workspaceId: 'ws-1' }];

    // Intentionally not awaited: the point is that all four have already been
    // *called* synchronously, before the pipeline itself yields control back
    // to us — a fully sequential implementation would only have called the
    // first one at this point.
    void runDependentContextInjections([cw], claimedTasks as any);

    expect(started.slice().sort()).toEqual(['discrepancy', 'missionHandoff', 'predictTaskAreas', 'subjectPriorWork'].sort());
    expect(started).not.toContain('knowledge');

    // Let the leftover pending promise settle so it doesn't bleed into the
    // next test.
    predictionsDeferred.resolve(new Map());
    missionHandoffDeferred.resolve();
    subjectPriorWorkDeferred.resolve();
    discrepancyDeferred.resolve();
    knowledgeDeferred.resolve();
  });

  it('only starts knowledge context once predictions and mission handoff (its real dependencies) resolve, while the others may still be in flight', async () => {
    const cw = claimedWorker('task-1');
    const claimedTasks = [{ id: 'task-1', title: 'Fix the thing', workspaceId: 'ws-1' }];

    const resultPromise = runDependentContextInjections([cw], claimedTasks as any);

    predictionsDeferred.resolve(new Map());
    missionHandoffDeferred.resolve();
    // Let the microtask queue drain so the `await Promise.all(...)` inside the
    // pipeline settles and it proceeds to call attachKnowledgeContext.
    await new Promise((r) => setTimeout(r, 0));

    expect(started).toContain('knowledge');
    // subjectPriorWork/discrepancy were kicked off up front and have not been
    // told to resolve yet — proving they overlapped with knowledge instead of
    // waiting for it.
    expect(finished).not.toContain('subjectPriorWork');
    expect(finished).not.toContain('discrepancy');

    knowledgeDeferred.resolve();
    subjectPriorWorkDeferred.resolve();
    discrepancyDeferred.resolve();
    await resultPromise;
  });

  it('flushes blocks in the fixed contract order — mission handoff, knowledge, subject-prior-work, discrepancy — regardless of resolution order', async () => {
    const cw = claimedWorker('task-1');
    const claimedTasks = [{ id: 'task-1', title: 'Fix the thing', workspaceId: 'ws-1' }];

    const resultPromise = runDependentContextInjections([cw], claimedTasks as any);

    // Resolve everything in the OPPOSITE order from the rail's fixed order,
    // to prove the flush order is not just an accident of resolution timing.
    discrepancyDeferred.resolve();
    subjectPriorWorkDeferred.resolve();
    predictionsDeferred.resolve(new Map());
    missionHandoffDeferred.resolve();
    await new Promise((r) => setTimeout(r, 0));
    knowledgeDeferred.resolve();

    await resultPromise;

    expect(cw.resolvedContextProviders).toEqual([
      '## Upstream Task Handoff\nblock',
      '## Retrieved Knowledge\nblock',
      '## Subject Prior Work\nblock',
      '## Spec Discrepancies\nblock',
    ]);
  });

  it('returns the task-area predictions for the caller to pass to attachTaskAreaScope', async () => {
    const cw = claimedWorker('task-1');
    const claimedTasks = [{ id: 'task-1', title: 'Fix the thing', workspaceId: 'ws-1' }];
    const predictions = new Map([['task-1', { predictedPaths: ['a.ts'] }]]);

    const resultPromise = runDependentContextInjections([cw], claimedTasks as any);
    predictionsDeferred.resolve(predictions as any);
    missionHandoffDeferred.resolve();
    await new Promise((r) => setTimeout(r, 0));
    knowledgeDeferred.resolve();
    subjectPriorWorkDeferred.resolve();
    discrepancyDeferred.resolve();

    const result = await resultPromise;
    expect(result).toBe(predictions as any);
  });

  it('predicts only the tasks that were actually claimed, not the full over-fetched candidate pool', async () => {
    const cw = claimedWorker('task-1');
    // `claimedTasks` here stands in for route.ts's `filteredTasks` — the whole
    // over-fetched candidate pool, most of which was not handed out.
    const claimedTasks = [
      { id: 'task-1', title: 'Fix the thing', workspaceId: 'ws-1' },
      { id: 'task-2', title: 'Unrelated candidate', workspaceId: 'ws-1' },
      { id: 'task-3', title: 'Another candidate', workspaceId: 'ws-1' },
    ];

    const resultPromise = runDependentContextInjections([cw], claimedTasks as any);
    predictionsDeferred.resolve(new Map());
    missionHandoffDeferred.resolve();
    subjectPriorWorkDeferred.resolve();
    discrepancyDeferred.resolve();
    await new Promise((r) => setTimeout(r, 0));
    knowledgeDeferred.resolve();
    await resultPromise;

    expect(mockPredictTaskAreas).toHaveBeenCalledTimes(1);
    expect(mockPredictTaskAreas.mock.calls[0]?.[0]).toEqual([
      { id: 'task-1', title: 'Fix the thing', workspaceId: 'ws-1' },
    ]);
  });

  it('does not wait for predictions before starting knowledge context when the claimed task is control-arm', async () => {
    mockAssignTaskAreaArm.mockImplementationOnce(() => ({
      arm: 'regex_paths',
      propensity: 1,
      fraction: 1,
      policyVersion: 'v1',
    }));
    const cw = claimedWorker('task-1');
    const claimedTasks = [{ id: 'task-1', title: 'Fix the thing', workspaceId: 'ws-1' }];

    const resultPromise = runDependentContextInjections([cw], claimedTasks as any);
    missionHandoffDeferred.resolve();
    // predictionsDeferred is deliberately left unresolved — knowledge must not
    // need it for a batch with no treatment-arm task.
    await new Promise((r) => setTimeout(r, 0));

    expect(started).toContain('knowledge');
    expect(finished).not.toContain('predictTaskAreas');

    knowledgeDeferred.resolve();
    subjectPriorWorkDeferred.resolve();
    discrepancyDeferred.resolve();
    predictionsDeferred.resolve(new Map());
    await resultPromise;
  });
});
