import { describe, it, expect, beforeEach, mock } from 'bun:test';

// A scripted db: every update() records its table and SET, and returns the
// next queued row list (an empty list is a lost compare-and-swap).
const updates: Array<{ table: string; set: any }> = [];
let returningQueue: any[][] = [];
let liveWorker: any = null;
let pausingTasks: any[] = [];
const notes: any[] = [];

const nameOf = (t: any) => (t === schema.workers ? 'workers' : t === schema.tasks ? 'tasks' : 'other');
const schema = { workers: { id: 'w.id', status: 'w.status', pendingInstructions: 'w.pi', taskId: 'w.taskId' }, tasks: { id: 't.id', context: 't.context' }, missionNotes: {} };

mock.module('@buildd/core/db/schema', () => schema);
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workers: { findFirst: async () => liveWorker },
      tasks: { findMany: async () => pausingTasks },
    },
    update: (table: any) => ({
      set: (set: any) => {
        updates.push({ table: nameOf(table), set });
        const rows = () => Promise.resolve(returningQueue.length ? returningQueue.shift()! : [{ id: 'row' }]);
        // Lazy: only the call that is awaited takes a row list from the queue.
        const where = () => ({ returning: rows, then: (ok: any, no: any) => Promise.resolve().then(ok, no), catch: (_f: any) => Promise.resolve() });
        return { where };
      },
    }),
    insert: () => ({ values: (v: any) => { notes.push(v); return Promise.resolve(); } }),
  },
}));
mock.module('@buildd/core/db/relational-sql', () => ({ sqlWhere: (x: any) => x }));
mock.module('drizzle-orm', () => ({
  and: (...a: any[]) => a, eq: (...a: any[]) => a, inArray: (...a: any[]) => a,
  sql: Object.assign((s: TemplateStringsArray, ...v: any[]) => ({ sql: s.join('?'), v }), { raw: (s: string) => s }),
}));
const mockTrigger = mock(async (..._a: any[]) => {});
mock.module('@/lib/pusher', () => ({
  triggerEvent: mockTrigger,
  channels: { worker: (id: string) => `worker-${id}` },
  events: { WORKER_COMMAND: 'worker:command' },
}));
const mockDispatchResumed = mock(async (..._a: any[]) => true);
mock.module('@/lib/task-dispatch-delivery', () => ({ dispatchResumedTask: mockDispatchResumed }));
const mockRequestPause = mock(async (_id: string) => true);
mock.module('@/lib/worker-pause', () => ({ requestWorkerPause: mockRequestPause }));
const mockEndLive = mock(async (_id: string) => ['w-1']);
mock.module('@/lib/task-cancel', () => ({ endLiveWorkersForRequeue: mockEndLive }));
const mockWake = mock(async (..._a: any[]) => {});
mock.module('@/lib/dispatch-authority', () => ({ wakeTask: mockWake }));
mock.module('@/modules', () => ({ TIER_MODEL: { resolve: async () => 'model-premium' } }));

import {
  queueInPlaceResume, resumeAfterPause, settleOnReactivation, sweepInPlaceResumes, startInPlaceResume, resolveChangeTarget,
  buildInPlaceResumeIntent,
} from './in-place-resume';

const NOW = Date.parse('2026-01-01T00:00:00Z');
const worker = (over: Record<string, unknown> = {}) => ({
  id: 'w-1', status: 'waiting_input', waitingFor: { type: 'pause' }, pendingInstructions: null, instructionHistory: [],
  parkedUntil: null, workspaceId: 'ws-1', taskId: 't-1', runner: 'runner-a', updatedAt: new Date(NOW), supportsInstructionAck: true, ...over,
});
const intent = (over: Record<string, unknown> = {}) => ({
  ...buildInPlaceResumeIntent({ workerId: 'w-1', cause: 'model_change', phase: 'pausing', fromTier: 'standard', fromModel: 'model-a', toTier: 'premium', toModel: 'model-b', now: NOW }),
  ...over,
});
const task = (context: Record<string, unknown> = {}) => ({ id: 't-1', workspaceId: 'ws-1', title: 'T', description: null, missionId: null, context });

beforeEach(() => {
  updates.length = 0; notes.length = 0; returningQueue = []; liveWorker = null; pausingTasks = [];
  mockTrigger.mockClear(); mockDispatchResumed.mockClear(); mockRequestPause.mockClear(); mockEndLive.mockClear(); mockWake.mockClear();
});

describe('queueInPlaceResume', () => {
  it('queues one message on the same worker row and leaves a resume record with a deadline', async () => {
    const ok = await queueInPlaceResume({ worker: worker(), task: task(), intent: intent({ phase: 'resuming' }) as never, now: NOW });
    expect(ok).toBe(true);
    expect(updates[0].table).toBe('workers');
    expect(updates[0].set.waitingFor).toBeNull();
    expect(updates[0].set.pendingInstructions).toContain('You now run on model-b');
    expect(updates[0].set.status).toBeUndefined();
    expect(updates[1].table).toBe('tasks');
    expect(JSON.stringify(updates[1].set.context)).toContain('ackDeadlineAt');
    expect(mockTrigger).toHaveBeenCalledWith('worker-w-1', 'worker:command', expect.objectContaining({ action: 'message' }));
    expect(mockDispatchResumed).not.toHaveBeenCalled();
  });

  it('writes nothing more when the worker is no longer parked (a lost compare-and-swap)', async () => {
    returningQueue = [[]];
    expect(await queueInPlaceResume({ worker: worker(), task: task(), intent: intent() as never, now: NOW })).toBe(false);
    expect(updates).toHaveLength(1);
    expect(mockTrigger).not.toHaveBeenCalled();
  });

  it('wakes a container for a parked cloud worker', async () => {
    await queueInPlaceResume({ worker: worker({ parkedUntil: new Date(NOW + 60_000) }), task: task(), intent: intent() as never, now: NOW });
    expect(mockDispatchResumed).toHaveBeenCalledTimes(1);
    expect(mockDispatchResumed.mock.calls[0][2]).toBe('w-1');
  });
});

describe('resumeAfterPause', () => {
  it('resumes a worker that parked for a tier change, with nobody pressing Resume', async () => {
    expect(await resumeAfterPause({ worker: worker(), task: task({ inPlaceResume: intent() }) })).toBe(true);
    expect(updates.map(u => u.table)).toEqual(['tasks', 'workers', 'tasks']);
  });

  it('does not resume twice: the second caller loses the step and queues nothing', async () => {
    returningQueue = [[]];
    expect(await resumeAfterPause({ worker: worker(), task: task({ inPlaceResume: intent() }) })).toBe(false);
    expect(updates).toHaveLength(1);
    expect(updates[0].table).toBe('tasks');
  });

  it('leaves a pause a person asked for alone', async () => {
    expect(await resumeAfterPause({ worker: worker(), task: task() })).toBe(false);
    expect(await resumeAfterPause({ worker: worker(), task: task({ inPlaceResume: intent({ workerId: 'w-other' }) }) })).toBe(false);
    expect(await resumeAfterPause({ worker: worker({ waitingFor: { type: 'question' } }), task: task({ inPlaceResume: intent() }) })).toBe(false);
    expect(updates).toHaveLength(0);
  });
});

describe('settleOnReactivation', () => {
  it('hands the new model to a runner that takes it and records resumed in place', async () => {
    const out = await settleOnReactivation({ worker: { id: 'w-1' }, task: task({ inPlaceResume: intent({ phase: 'resuming' }) }), runnerTakesModel: true, now: NOW });
    expect(out).toEqual({ sessionModel: 'model-b' });
    expect(updates[0].set.predictedModel).toBe('model-b');
    const sqlText = JSON.stringify(updates[0].set.context);
    expect(sqlText).toContain('resumed_in_place');
    expect(sqlText).toContain('inPlaceResume');
    expect(sqlText).toContain('pendingModelChange');
    expect(notes[0]).toMatchObject({ taskId: 't-1', workerId: 'w-1', title: 'Resumed in place' });
    expect(notes[0].body).toContain('model-a → model-b');
  });

  it('an older runner keeps its model: the resume is recorded, the model waits for a new attempt', async () => {
    const out = await settleOnReactivation({ worker: { id: 'w-1' }, task: task({ inPlaceResume: intent({ phase: 'resuming' }) }), runnerTakesModel: false, now: NOW });
    expect(out).toEqual({});
    expect(updates[0].set.predictedModel).toBeUndefined();
    expect(notes.map(n => n.title)).toEqual(['Resumed in place', 'Model change waits for a new attempt']);
  });

  it('a runner that came back resumes its session on a change made while it was away', async () => {
    const pendingModelChange = { tier: 'premium', resolvedModel: 'model-b', runningTier: 'standard', runningModel: 'model-a', workerId: 'w-1', at: 'x' };
    const out = await settleOnReactivation({ worker: { id: 'w-1' }, task: task({ pendingModelChange }), runnerTakesModel: true, now: NOW });
    expect(out).toEqual({ sessionModel: 'model-b' });
  });

  it('does nothing for a resume with no change waiting, or one meant for another worker', async () => {
    expect(await settleOnReactivation({ worker: { id: 'w-1' }, task: task(), runnerTakesModel: true })).toEqual({});
    expect(await settleOnReactivation({ worker: { id: 'w-2' }, task: task({ inPlaceResume: intent() }), runnerTakesModel: true })).toEqual({});
    expect(updates).toHaveLength(0);
  });

  it('a retry or recovery session, which also reactivates the worker, settles nothing', async () => {
    expect(await settleOnReactivation({ worker: { id: 'w-1' }, task: task({ inPlaceResume: intent() }), runnerTakesModel: false })).toEqual({});
    expect(updates).toHaveLength(0);
    expect(notes).toHaveLength(0);
  });

  it('a requeue with no model change is recorded as resumed in place', async () => {
    const requeue = buildInPlaceResumeIntent({ workerId: 'w-1', cause: 'requeue', phase: 'resuming', fromTier: null, fromModel: 'model-a', now: NOW });
    expect(await settleOnReactivation({ worker: { id: 'w-1' }, task: task({ inPlaceResume: requeue }), runnerTakesModel: true })).toEqual({});
    expect(notes[0].body).toMatch(/^Resumed in place: the same session/);
  });
});

describe('startInPlaceResume', () => {
  it('asks for the pause when the agent is running', async () => {
    expect(await startInPlaceResume({ worker: worker({ status: 'running' }) as never, task: task(), intent: intent() as never })).toBe(true);
    expect(mockRequestPause).toHaveBeenCalledWith('w-1');
    expect(updates).toHaveLength(0);
  });

  it('queues the resume when the agent is already parked', async () => {
    await startInPlaceResume({ worker: worker() as never, task: task(), intent: intent({ phase: 'resuming' }) as never });
    expect(mockRequestPause).not.toHaveBeenCalled();
    expect(updates[0].table).toBe('workers');
  });
});

describe('sweepInPlaceResumes', () => {
  const pausing = (over: Record<string, unknown> = {}) => ({ ...task({ inPlaceResume: intent(over) }), status: 'in_progress' });

  it('resumes a worker that parked before its intent was written', async () => {
    pausingTasks = [pausing()];
    liveWorker = worker();
    expect(await sweepInPlaceResumes(new Date(NOW + 1000))).toEqual({ resumed: 1, fellBack: 0, cleared: 0 });
  });

  it('drops the intent of a worker that ended by itself', async () => {
    pausingTasks = [pausing()];
    expect(await sweepInPlaceResumes(new Date(NOW + 1000))).toEqual({ resumed: 0, fellBack: 0, cleared: 1 });
    expect(mockEndLive).not.toHaveBeenCalled();
  });

  it('waits for the pause until its deadline', async () => {
    pausingTasks = [pausing()];
    liveWorker = worker({ status: 'running', waitingFor: null });
    expect(await sweepInPlaceResumes(new Date(NOW + 60_000))).toEqual({ resumed: 0, fellBack: 0, cleared: 0 });
    expect(updates).toHaveLength(0);
  });

  it('past the deadline a model change waits for the next attempt and the worker keeps running', async () => {
    pausingTasks = [pausing()];
    liveWorker = worker({ status: 'running', waitingFor: null });
    expect(await sweepInPlaceResumes(new Date(NOW + 60 * 60_000))).toEqual({ resumed: 0, fellBack: 1, cleared: 0 });
    expect(mockEndLive).not.toHaveBeenCalled();
    expect(notes[0].title).toBe('New attempt');
  });

  it('past the deadline a requeue ends the worker first, then frees the task', async () => {
    pausingTasks = [pausing({ cause: 'requeue' })];
    liveWorker = worker({ status: 'running', waitingFor: null });
    expect((await sweepInPlaceResumes(new Date(NOW + 60 * 60_000))).fellBack).toBe(1);
    expect(mockEndLive).toHaveBeenCalledWith('t-1');
    expect(updates.at(-1)!.set).toMatchObject({ status: 'pending', claimedBy: null });
    expect(mockWake).toHaveBeenCalledWith('t-1', 'manual.start');
  });
});

describe('resolveChangeTarget', () => {
  const t = { workspaceId: 'ws-1', workspace: { teamId: 'team-1' } };
  it('takes a model pin as it is, and resolves a tier through the registry', async () => {
    expect(await resolveChangeTarget(t, { model: ' model-x ' })).toEqual({ tier: null, model: 'model-x' });
    expect(await resolveChangeTarget(t, { tier: 'premium' })).toEqual({ tier: 'premium', model: 'model-premium' });
  });
  it('names no model when the pin or tier is cleared', async () => {
    expect(await resolveChangeTarget(t, { tier: null })).toBeNull();
    expect(await resolveChangeTarget(t, { model: null })).toBeNull();
  });
});
