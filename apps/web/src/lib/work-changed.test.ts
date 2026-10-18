import { afterEach, describe, expect, it, mock } from 'bun:test';

// The composition root, as emit() reads it: no subscribers, so the test sees only the note.
mock.module('@/modules', () => ({ SUBSCRIBERS: [] }));

const {
  flushWorkChanges, isEmptyWorkChange, noteWorkChanged, setWorkChangeListenersForTests,
  workChangeOfEvent, workChangeOfKernelInput,
} = await import('./work-changed');
const { emit } = await import('./core-emit');
type Batch = Parameters<Parameters<typeof setWorkChangeListenersForTests>[0] extends readonly (infer L)[] | null ? L : never>[0];

afterEach(() => { setWorkChangeListenersForTests(null); });

function listen() {
  const batches: Batch[] = [];
  setWorkChangeListenersForTests([(b) => { batches.push(b); }]);
  return batches;
}

describe('noteWorkChanged', () => {
  it('coalesces every note before the flush into one deduplicated batch', async () => {
    const batches = listen();
    noteWorkChanged({ taskIds: ['t1', 't2'] });
    noteWorkChanged({ taskIds: ['t1'], workerIds: ['w1'], missionIds: [null, 'm1', ''] });
    noteWorkChanged({ prs: [{ repoFullName: 'acme/app', prNumber: 7 }, { repoFullName: 'acme/app', prNumber: 7 }] });
    noteWorkChanged({ workspacePrs: [{ workspaceId: 'ws', prNumber: 7 }] });
    await flushWorkChanges();
    expect(batches).toEqual([{
      missionIds: ['m1'], taskIds: ['t1', 't2'], workerIds: ['w1'],
      prs: [{ repoFullName: 'acme/app', prNumber: 7 }], workspacePrs: [{ workspaceId: 'ws', prNumber: 7 }],
    }]);
  });

  it('a note with no ids schedules nothing', async () => {
    const batches = listen();
    noteWorkChanged({ taskIds: [null, undefined] });
    await flushWorkChanges();
    expect(batches).toEqual([]);
  });

  it('a listener that throws neither reaches the caller nor stops the next listener', async () => {
    const seen: string[] = [];
    setWorkChangeListenersForTests([() => { throw new Error('boom'); }, (b) => { seen.push(...b.taskIds); }]);
    expect(() => noteWorkChanged({ taskIds: ['t1'] })).not.toThrow();
    await flushWorkChanges();
    expect(seen).toEqual(['t1']);
  });

  it('in a test process with no listeners installed, notes nothing (never loads the composition root)', async () => {
    setWorkChangeListenersForTests(null);
    noteWorkChanged({ taskIds: ['t1'] });
    const batches = listen();
    await flushWorkChanges();
    expect(batches).toEqual([]);
  });
});

describe('what a core event names', () => {
  it('reads ids wherever the event keeps them', () => {
    expect(workChangeOfEvent({ type: 'worker.reported', taskId: 't', workerId: 'w', missionId: 'm' } as never))
      .toEqual({ missionIds: ['m'], taskIds: ['t'], workerIds: ['w'], prs: [] });
    expect(workChangeOfEvent({ type: 'tasks.claimed', tasks: [{ id: 't1', missionId: 'm1' }, { id: 't2', missionId: null }] } as never))
      .toMatchObject({ missionIds: ['m1'], taskIds: ['t1', 't2'] });
    expect(workChangeOfEvent({ type: 'pr.review_ready', repoFullName: 'acme/app', pr: { number: 9 }, worker: { id: 'w', taskId: 't' } } as never))
      .toMatchObject({ taskIds: ['t'], workerIds: ['w'], prs: [{ repoFullName: 'acme/app', prNumber: 9 }] });
    expect(workChangeOfEvent({ type: 'pr.review_submitted', repoFullName: 'acme/app', prNumber: 9, owner: { workerId: 'w', taskId: 't', missionId: 'm' } } as never))
      .toMatchObject({ missionIds: ['m'], taskIds: ['t'], workerIds: ['w'] });
    expect(isEmptyWorkChange(workChangeOfEvent({ type: 'team.created', teamId: 'x' } as never))).toBe(true);
  });

  it('a kernel command names its PR by workspace and number', () => {
    expect(workChangeOfKernelInput({ workspaceId: 'ws', prNumber: 4, taskId: 't' }))
      .toEqual({ missionIds: [], taskIds: ['t'], workerIds: [], workspacePrs: [{ workspaceId: 'ws', prNumber: 4 }] });
    expect(isEmptyWorkChange(workChangeOfKernelInput({ deliveryId: 'd' }))).toBe(true);
  });

  it('emit() notes the ids of every event it fans out', async () => {
    const batches = listen();
    await emit({ type: 'task.terminal', taskId: 't9', workerId: 'w9', workspaceId: 'ws', sensitive: false });
    await flushWorkChanges();
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({ taskIds: ['t9'], workerIds: ['w9'] });
  });

  it('emit() under a test\'s own subscriber list notes nothing', async () => {
    const batches = listen();
    await emit({ type: 'task.terminal', taskId: 't9', workerId: 'w9', workspaceId: 'ws', sensitive: false }, { subscribers: [] });
    await flushWorkChanges();
    expect(batches).toEqual([]);
  });
});
