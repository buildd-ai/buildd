import { beforeEach, describe, expect, it, mock } from 'bun:test';

// Filing a mission task must never wait on its scope decision (a model call that can run to
// its timeout): the subscriber hands the work to after() and returns.
const deferred: Array<() => unknown> = [];
mock.module('next/server', () => ({
  after: (task: () => unknown) => { deferred.push(task); },
  NextResponse: { json: () => null },
  NextRequest: class {},
}));

const decide = mock(() => new Promise<void>(() => {})); // never settles
const ensure = mock(async () => {});
mock.module('@/lib/mission-epoch-door', () => ({
  decideMissionTaskScope: decide,
  ensureMissionWritableBranch: ensure,
}));

mock.module('@buildd/core/db', () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ taskClass: 'work', mode: 'execution' }] }) }) }) },
}));

const { SUBSCRIBERS } = await import('../modules');
const sub = SUBSCRIBERS.find(s => s.label === 'open-writable-mission-delivery')!;
const event = { taskId: 't1', workspaceId: 'w1', missionId: 'm1', title: 'x', creator: {} } as never;

describe('open-writable-mission-delivery', () => {
  beforeEach(() => { deferred.length = 0; decide.mockClear(); ensure.mockClear(); });

  it('returns at once and defers the scope decision to after()', () => {
    const result = sub.run(event);
    expect(result).toBeUndefined();
    expect(deferred).toHaveLength(1);
    expect(decide).not.toHaveBeenCalled();
  });

  it('runs the decision when the deferred work runs, even if the decision never settles', async () => {
    sub.run(event);
    void deferred[0]!();
    await new Promise(r => setTimeout(r, 10));
    expect(decide).toHaveBeenCalledTimes(1);
    expect(ensure).not.toHaveBeenCalled(); // still waiting on the decision, off the request path
  });

  it('does nothing for a task with no mission', () => {
    sub.run({ ...(event as object), missionId: null } as never);
    expect(deferred).toHaveLength(0);
  });
});
