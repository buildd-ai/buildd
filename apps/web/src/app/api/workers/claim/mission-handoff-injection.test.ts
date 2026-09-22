import { describe, it, expect, mock, beforeEach } from 'bun:test';

// ── DB mock setup ─────────────────────────────────────────────────────────────

const mockTasksFindMany = mock(async () => [] as any[]);
const mockMissionsFindMany = mock(async () => [] as any[]);
const mockArtifactsFindMany = mock(async () => [] as any[]);
const mockMissionNotesFindMany = mock(async () => [] as any[]);
const mockSelectDistinct = mock(() => ({
  from: () => ({
    where: () => ({
      orderBy: () => Promise.resolve([] as any[]),
    }),
  }),
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      tasks: { findMany: mockTasksFindMany },
      missions: { findMany: mockMissionsFindMany },
      artifacts: { findMany: mockArtifactsFindMany },
      missionNotes: { findMany: mockMissionNotesFindMany },
    },
    selectDistinct: mockSelectDistinct,
  },
}));

mock.module('@buildd/core/db/schema', () => ({
  tasks: { id: 'id' },
  workers: { taskId: 'taskId', prUrl: 'prUrl', prNumber: 'prNumber', mergedAt: 'mergedAt', status: 'status', createdAt: 'createdAt' },
  missions: { id: 'id' },
  missionNotes: { missionId: 'missionId', type: 'type' },
  artifacts: { missionId: 'missionId', type: 'type' },
}));

mock.module('drizzle-orm', () => ({
  eq: (a: unknown, b: unknown) => ({ op: 'eq', a, b }),
  inArray: (a: unknown, b: unknown) => ({ op: 'inArray', a, b }),
  and: (...args: unknown[]) => ({ op: 'and', args }),
  not: (a: unknown) => ({ op: 'not', a }),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
    { raw: (s: string) => ({ raw: s }) },
  ),
}));

/**
 * Real appendContextBlock mirrors onto both rails (cw.resolvedContextProviders
 * and cw.task.context.resolvedContextProviders); the runner only ever reads
 * the latter (apps/runner/src/workers.ts). Stubbing it here keeps this file
 * focused on attachMissionHandoff's own querying/rendering logic — the mirror
 * contract itself is covered by context-injection.test.ts.
 */
const mockAppendContextBlock = mock((cw: any, block: string) => {
  cw.resolvedContextProviders = [...(cw.resolvedContextProviders ?? []), block];
  cw.task.context = cw.task.context ?? {};
  cw.task.context.resolvedContextProviders = [...(cw.task.context.resolvedContextProviders ?? []), block];
});
mock.module('./context-injection', () => ({
  appendContextBlock: mockAppendContextBlock,
}));

import { attachMissionHandoff } from './mission-handoff-injection';

beforeEach(() => {
  mockTasksFindMany.mockReset();
  mockTasksFindMany.mockResolvedValue([]);
  mockMissionsFindMany.mockReset();
  mockMissionsFindMany.mockResolvedValue([]);
  mockArtifactsFindMany.mockReset();
  mockArtifactsFindMany.mockResolvedValue([]);
  mockMissionNotesFindMany.mockReset();
  mockMissionNotesFindMany.mockResolvedValue([]);
  mockSelectDistinct.mockReset();
  mockSelectDistinct.mockReturnValue({
    from: () => ({ where: () => ({ orderBy: () => Promise.resolve([]) }) }),
  });
  mockAppendContextBlock.mockClear();
});

function claimedWorker(taskId: string) {
  return { id: `w-${taskId}`, taskId, branch: 'b', task: { id: taskId, context: {} } } as any;
}

describe('attachMissionHandoff', () => {
  it('renders upstream handoff.delivered and mirrors into task.context.resolvedContextProviders', async () => {
    mockTasksFindMany.mockResolvedValue([
      {
        id: 'dep-1',
        title: 'Build the shared client',
        status: 'completed',
        result: { structuredOutput: { handoff: { delivered: 'Implemented the shared HTTP client.' } } },
        missionId: null,
        missionPhaseLabel: null,
        pathManifest: null,
      },
    ]);

    const cw = claimedWorker('task-2');
    const claimedTasks = [{ id: 'task-2', missionId: null, dependsOn: ['dep-1'], title: 'Downstream task' }] as any;

    await attachMissionHandoff([cw], claimedTasks);

    expect(mockAppendContextBlock).toHaveBeenCalledTimes(1);
    const block = mockAppendContextBlock.mock.calls[0][1] as string;
    expect(block).toContain('## Upstream Task Handoff');
    expect(block).toContain('Implemented the shared HTTP client.');
    // The rail the runner actually reads (apps/runner/src/workers.ts).
    expect(cw.task.context.resolvedContextProviders).toContain(block);
  });

  it('does nothing for a claimed task with no dependsOn', async () => {
    const cw = claimedWorker('task-3');
    const claimedTasks = [{ id: 'task-3', missionId: null, dependsOn: [], title: 'No deps' }] as any;

    await attachMissionHandoff([cw], claimedTasks);

    expect(mockTasksFindMany).not.toHaveBeenCalled();
    expect(mockAppendContextBlock).not.toHaveBeenCalled();
  });

  it('falls back to title/status when the upstream result has no handoff', async () => {
    mockTasksFindMany.mockResolvedValue([
      {
        id: 'dep-1',
        title: 'Old task',
        status: 'completed',
        result: { summary: 'did stuff, no handoff field' },
        missionId: null,
        missionPhaseLabel: null,
        pathManifest: null,
      },
    ]);

    const cw = claimedWorker('task-4');
    const claimedTasks = [{ id: 'task-4', missionId: null, dependsOn: ['dep-1'], title: 'Downstream' }] as any;

    await attachMissionHandoff([cw], claimedTasks);

    const block = mockAppendContextBlock.mock.calls[0][1] as string;
    expect(block).toContain('Old task (completed)');
  });

  it('is best-effort: a DB error attaches nothing rather than throwing', async () => {
    mockTasksFindMany.mockRejectedValue(new Error('DB down'));

    const cw = claimedWorker('task-5');
    const claimedTasks = [{ id: 'task-5', missionId: null, dependsOn: ['dep-1'], title: 'Downstream' }] as any;

    await expect(attachMissionHandoff([cw], claimedTasks)).resolves.toBeUndefined();
    expect(mockAppendContextBlock).not.toHaveBeenCalled();
  });
});
