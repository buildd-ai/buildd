import { describe, it, expect, mock, beforeEach } from 'bun:test';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

// Independent per-task deferreds so the test can resolve them in an order
// that does not match the input array — proving the loop doesn't process one
// task at a time.
const taskDeferreds = new Map<string, ReturnType<typeof deferred<any>>>();
const started: string[] = [];

const mockLoadTaskAreaConfig = mock(async () => ({ enabled: true } as any));
const mockPredictTaskArea = mock(async (_store: any, task: { taskId: string }) => {
  started.push(task.taskId);
  return taskDeferreds.get(task.taskId)!.promise;
});
const mockRecordTaskAreaPrediction = mock(async () => {});

mock.module('@buildd/core/task-area-prediction-source', () => ({
  loadTaskAreaConfig: mockLoadTaskAreaConfig,
  predictTaskArea: mockPredictTaskArea,
  recordTaskAreaPrediction: mockRecordTaskAreaPrediction,
}));

const realKnowledgeStore = await import('@buildd/core/knowledge-store');
mock.module('@buildd/core/knowledge-store', () => ({
  ...realKnowledgeStore,
  PgVectorStore: class {},
  getVoyageEmbedder: () => ({}),
  getVoyageReranker: () => ({}),
}));

const realKnowledgeContext = await import('@/lib/knowledge-context');
mock.module('@/lib/knowledge-context', () => ({
  buildClusteredKnowledgeContext: mock(async () => ({ parts: [], assembly: null })),
  buildKnowledgeContext: mock(async () => []),
  buildEntityCatalogContext: mock(async () => ''),
  logContextAssembly: mock(() => {}),
  buildFanOutAssembly: realKnowledgeContext.buildFanOutAssembly,
}));

const { predictTaskAreas } = await import('./context-injection');

beforeEach(() => {
  started.length = 0;
  taskDeferreds.clear();
  mockLoadTaskAreaConfig.mockClear();
  mockPredictTaskArea.mockClear();
  mockRecordTaskAreaPrediction.mockClear();
});

describe('predictTaskAreas', () => {
  it('predicts every claimed task concurrently instead of one at a time', async () => {
    const tasks = [
      { id: 'task-1', title: 'A', workspaceId: 'ws-1' },
      { id: 'task-2', title: 'B', workspaceId: 'ws-1' },
      { id: 'task-3', title: 'C', workspaceId: 'ws-1' },
    ] as any;
    for (const t of tasks) taskDeferreds.set(t.id, deferred());

    const resultPromise = predictTaskAreas(tasks);

    // Let the leading `await loadTaskAreaConfig()` settle, then all three
    // tasks should already have been called — a sequential `for...of` loop
    // would only have called the first at this point.
    await new Promise((r) => setTimeout(r, 0));
    expect(started.slice().sort()).toEqual(['task-1', 'task-2', 'task-3']);

    // Resolve out of input order.
    taskDeferreds.get('task-3')!.resolve({ taskId: 'task-3', predictedPaths: ['c.ts'] });
    taskDeferreds.get('task-1')!.resolve({ taskId: 'task-1', predictedPaths: ['a.ts'] });
    taskDeferreds.get('task-2')!.resolve({ taskId: 'task-2', predictedPaths: ['b.ts'] });

    const result = await resultPromise;
    expect(result.get('task-1')).toMatchObject({ predictedPaths: ['a.ts'] });
    expect(result.get('task-2')).toMatchObject({ predictedPaths: ['b.ts'] });
    expect(result.get('task-3')).toMatchObject({ predictedPaths: ['c.ts'] });
    expect(mockRecordTaskAreaPrediction).toHaveBeenCalledTimes(3);
  });

  it('returns an empty map when the experiment is disabled, without calling predictTaskArea', async () => {
    mockLoadTaskAreaConfig.mockResolvedValueOnce({ enabled: false } as any);
    const tasks = [{ id: 'task-1', title: 'A', workspaceId: 'ws-1' }] as any;

    const result = await predictTaskAreas(tasks);

    expect(result.size).toBe(0);
    expect(mockPredictTaskArea).not.toHaveBeenCalled();
  });

  it('caps the batch at CLAIM_FANOUT_CONCURRENCY in-flight predictions, so a deep candidate pool cannot fan out unbounded Neon queries', async () => {
    const tasks = Array.from({ length: 6 }, (_, i) => ({
      id: `task-${i}`,
      title: `T${i}`,
      workspaceId: 'ws-1',
    })) as any;
    for (const t of tasks) taskDeferreds.set(t.id, deferred());

    const resultPromise = predictTaskAreas(tasks);

    await new Promise((r) => setTimeout(r, 0));
    // Only the cap's worth started, not all 6 — the remaining 2 are queued
    // behind the first wave.
    expect(started.length).toBe(4);

    // Resolving two of the in-flight ones should let the queued two start.
    taskDeferreds.get('task-0')!.resolve({ taskId: 'task-0', predictedPaths: [] });
    taskDeferreds.get('task-1')!.resolve({ taskId: 'task-1', predictedPaths: [] });
    await new Promise((r) => setTimeout(r, 0));
    expect(started.length).toBe(6);

    for (const t of tasks) {
      taskDeferreds.get(t.id)!.resolve({ taskId: t.id, predictedPaths: [] });
    }
    await resultPromise;
  });
});
