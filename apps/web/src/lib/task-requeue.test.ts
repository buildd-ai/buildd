import { describe, it, expect, beforeEach, mock } from 'bun:test';

let endedRows: any[] = [];
let setArg: any;
const mockTriggerEvent = mock(async (..._a: any[]) => {});
const mockReleaseAndNotify = mock(async (..._a: any[]) => {});

mock.module('@buildd/core/db', () => ({
  db: {
    query: {},
    update: () => ({ set: (v: any) => { setArg = v; return { where: () => ({ returning: async () => endedRows }) }; } }),
  },
}));
mock.module('@/lib/pusher', () => ({
  triggerEvent: mockTriggerEvent,
  channels: { workspace: (id: string) => `workspace-${id}`, worker: (id: string) => `worker-${id}` },
  events: { WORKER_COMMAND: 'worker:command', WORKER_FAILED: 'worker:failed', TASK_UPDATED: 'task:updated' },
}));
mock.module('@/lib/path-claim-release', () => ({ releaseAndNotify: mockReleaseAndNotify }));

import { endLiveWorkersForRequeue, REQUEUED_WORKER_ERROR } from './task-cancel';

describe('endLiveWorkersForRequeue', () => {
  beforeEach(() => {
    endedRows = [];
    setArg = undefined;
    mockTriggerEvent.mockClear();
    mockReleaseAndNotify.mockClear();
  });

  it('marks live workers failed with the requeue reason, aborts them and releases path claims', async () => {
    endedRows = [{ id: 'w-1', taskId: 't-1', accountId: 'a-1' }, { id: 'w-2', taskId: 't-1', accountId: 'a-1' }];
    const ids = await endLiveWorkersForRequeue('t-1');
    expect(ids).toEqual(['w-1', 'w-2']);
    expect(setArg).toMatchObject({ status: 'failed', exitCause: 'reassigned', error: REQUEUED_WORKER_ERROR, waitingFor: null });
    expect(mockTriggerEvent).toHaveBeenCalledWith('worker-w-1', 'worker:command', expect.objectContaining({ action: 'abort' }));
    expect(mockTriggerEvent).toHaveBeenCalledWith('worker-w-2', 'worker:failed', expect.objectContaining({ workerId: 'w-2' }));
    expect(mockReleaseAndNotify).toHaveBeenCalledWith('t-1', 'abandoned');
  });

  it('does nothing further when no worker is live', async () => {
    expect(await endLiveWorkersForRequeue('t-1')).toEqual([]);
    expect(mockTriggerEvent).not.toHaveBeenCalled();
    expect(mockReleaseAndNotify).not.toHaveBeenCalled();
  });
});
