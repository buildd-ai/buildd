/**
 * `buildd top` listens instead of polling (spec 3ef37387 R-21): the runner
 * turns task events on its workspace channels into one `tasks_changed` frame,
 * and watches the channels of the missions top lists for mission-loop events
 * (`mission_changed`). Neither adds a published event: both read channels the
 * server already publishes to.
 */
import { describe, expect, mock, test } from 'bun:test';
import { PusherManager, MISSION_LOOP_EVENTS, WORKSPACE_TASK_EVENTS, MAX_WATCHED_MISSIONS } from '../../src/pusher-manager';

type Handler = (data: unknown) => void;

function fakePusher() {
  const channels = new Map<string, Map<string, Handler>>();
  const subscribed: string[] = [];
  const unsubscribed: string[] = [];
  return {
    channels, subscribed, unsubscribed,
    subscribe(name: string) {
      subscribed.push(name);
      const handlers = new Map<string, Handler>();
      channels.set(name, handlers);
      return { bind: (e: string, fn: Handler) => handlers.set(e, fn), unbind: (e?: string) => { if (e) handlers.delete(e); else handlers.clear(); } };
    },
    unsubscribe(name: string) { unsubscribed.push(name); channels.delete(name); },
    fire(name: string, event: string, data: unknown) { channels.get(name)?.get(event)?.(data); },
  };
}

function makeManager(opts: { workspaces?: Array<{ id: string }> } = {}) {
  const emit = mock((_e: any) => {});
  const callbacks = {
    getWorkers: () => new Map(), emit, emitCommand: mock(() => {}), abort: mock(async () => {}), sendMessage: mock(async () => {}),
    syncWorker: mock(async () => {}), rollback: mock(async () => ({})), recover: mock(async () => {}), sendHeartbeat: mock(() => {}),
    claimPendingTasks: mock(async () => []), claimAndStart: mock(async () => null), getProbedWorkers: () => new Set<string>(),
  };
  const buildd = { listWorkspaces: async () => opts.workspaces ?? [{ id: 'ws-a' }] };
  const manager = new PusherManager({ pusherChannelPrefix: '', acceptRemoteTasks: true } as any, buildd as any, callbacks as any);
  const pusher = fakePusher();
  (manager as any).pusher = pusher;
  return { manager, emit, pusher };
}

describe('workspace task events reach top as tasks_changed', () => {
  test('each task event on a workspace channel is one tasks_changed frame', async () => {
    const { manager, emit, pusher } = makeManager();
    await manager.subscribeToWorkspaceChannels();
    for (const event of WORKSPACE_TASK_EVENTS) pusher.fire('workspace-ws-a', event, { taskId: 't-1' });
    const frames = emit.mock.calls.map(c => c[0]).filter((e: any) => e.type === 'tasks_changed');
    expect(frames).toHaveLength(WORKSPACE_TASK_EVENTS.length);
    expect(frames[0]).toEqual({ type: 'tasks_changed', workspaceId: 'ws-a', taskId: 't-1' });
  });

  test('the events are the ones the server already publishes there', () => {
    expect([...WORKSPACE_TASK_EVENTS].sort()).toEqual([
      'task:children_completed', 'task:created', 'task:dependency_failed', 'task:unblocked', 'task:updated',
      'worker:completed', 'worker:failed',
    ].sort());
  });

  test('worker:progress is not one of them: a heartbeat is not a task-list change', () => {
    expect(WORKSPACE_TASK_EVENTS).not.toContain('worker:progress');
  });

  test('unsubscribing a workspace unbinds every event', async () => {
    const { manager, pusher } = makeManager();
    await manager.subscribeToWorkspaceChannels();
    manager.unsubscribeFromWorkspaceChannels();
    expect(pusher.unsubscribed).toContain('workspace-ws-a');
  });
});

describe('mission-loop events reach top as mission_changed', () => {
  test('watching a mission binds its loop events; each is one mission_changed frame', () => {
    const { manager, emit, pusher } = makeManager();
    manager.watchMissions(['m-1']);
    expect(pusher.subscribed).toEqual(['mission-m-1']);
    for (const event of MISSION_LOOP_EVENTS) pusher.fire('mission-m-1', event, { missionId: 'm-1' });
    expect(emit.mock.calls.map(c => c[0])).toEqual(MISSION_LOOP_EVENTS.map(() => ({ type: 'mission_changed', missionId: 'm-1' })));
    expect([...MISSION_LOOP_EVENTS].sort()).toEqual(['mission:cycle_started', 'mission:loop_completed', 'mission:loop_stalled', 'mission:reopened'].sort());
  });

  test('a new list keeps what stays, adds what is new, and lets go of the rest', () => {
    const { manager, pusher } = makeManager();
    manager.watchMissions(['m-1', 'm-2']);
    manager.watchMissions(['m-2', 'm-3']);
    expect(pusher.subscribed).toEqual(['mission-m-1', 'mission-m-2', 'mission-m-3']);
    expect(pusher.unsubscribed).toEqual(['mission-m-1']);
  });

  test('at most MAX_WATCHED_MISSIONS channels', () => {
    const { manager, pusher } = makeManager();
    manager.watchMissions(Array.from({ length: MAX_WATCHED_MISSIONS + 5 }, (_, i) => `m-${i}`));
    expect(pusher.subscribed).toHaveLength(MAX_WATCHED_MISSIONS);
  });

  test('not renewed (top closed or idle), the watch ends by itself', async () => {
    const { manager, pusher } = makeManager();
    manager.watchMissions(['m-1'], { ttlMs: 30 });
    await Bun.sleep(80);
    expect(pusher.unsubscribed).toEqual(['mission-m-1']);
  });

  test('without Pusher, watching is a no-op', () => {
    const { manager } = makeManager();
    (manager as any).pusher = undefined;
    expect(() => manager.watchMissions(['m-1'])).not.toThrow();
  });
});
