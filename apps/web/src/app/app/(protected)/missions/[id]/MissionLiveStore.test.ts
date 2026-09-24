/**
 * The mission page's realtime policy (docs/design/mission-feed-mobile-continuity.md,
 * "Realtime", slice S7, AC-17): steady-status progress patches the store and
 * never renders; structural events render at most once per 3s window.
 */
import { describe, expect, it } from 'bun:test';
import type { Clock } from '@/lib/realtime-throttle';
import {
  MISSION_REFRESH_WINDOW_MS,
  classifyMissionEvent,
  createMissionLiveStore,
  createMissionRefresher,
  mergeLiveLines,
} from './MissionLiveStore';

function fakeClock(): Clock & { advance(ms: number): void } {
  let t = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => t,
    setTimeout: (fn, ms) => { const id = nextId++; timers.set(id, { at: t + ms, fn }); return id; },
    clearTimeout: (id) => { timers.delete(id as number); },
    advance(ms) {
      const end = t + ms;
      for (;;) {
        let due: [number, { at: number; fn: () => void }] | null = null;
        for (const e of timers) if (e[1].at <= end && (!due || e[1].at < due[1].at)) due = e;
        if (!due) break;
        timers.delete(due[0]);
        t = due[1].at;
        due[1].fn();
      }
      t = end;
    },
  };
}

// Illustrative ids only.
const M = 'mission-a';
const T1 = 'task-1';
const T2 = 'task-2';
const W1 = 'worker-1';

function setup(opts: { hidden?: boolean; workerStatuses?: Record<string, string> } = {}) {
  const clock = fakeClock();
  const store = createMissionLiveStore();
  let refreshes = 0;
  let patches = 0;
  store.subscribe(() => { patches++; });
  let hidden = opts.hidden ?? false;
  const r = createMissionRefresher({
    missionId: M,
    taskIds: [T1, T2],
    workerStatuses: opts.workerStatuses ?? { [W1]: 'running' },
    store,
    refresh: () => { refreshes++; },
    isHidden: () => hidden,
    clock,
  });
  return {
    clock, store, r,
    get refreshes() { return refreshes; },
    get patches() { return patches; },
    setHidden(h: boolean) { hidden = h; },
  };
}

describe('AC-17: worker:progress patches, never renders', () => {
  it('20 steady-status progress events → 0 refreshes and 20 store patches', () => {
    const s = setup();
    for (let i = 0; i < 20; i++) {
      s.r.onEvent('worker:progress', { workerId: W1, taskId: T1, status: 'running', currentAction: `step ${i}`, updatedAt: `t${i}` });
      s.clock.advance(1_000);
    }
    s.clock.advance(10_000);
    expect(s.refreshes).toBe(0);
    expect(s.patches).toBe(20);
    expect(s.store.getSnapshot()[T1]).toEqual({ workerId: W1, status: 'running', currentAction: 'step 19', updatedAt: 't19' });
  });

  it('progress for a task outside the mission is ignored entirely', () => {
    const s = setup();
    s.r.onEvent('worker:progress', { workerId: 'w-other', taskId: 'task-other', status: 'running' });
    s.clock.advance(10_000);
    expect(s.refreshes).toBe(0);
    expect(s.patches).toBe(0);
  });
});

describe('AC-17: structural events render at most once per window', () => {
  it('5 structural events within 3s → exactly 1 refresh, at the end of the window', () => {
    const s = setup();
    s.r.onEvent('task:created', { task: { missionId: M } });
    s.clock.advance(500);
    s.r.onEvent('task:claimed', { task: { id: T1 } });
    s.clock.advance(500);
    s.r.onEvent('worker:completed', { workerId: W1, taskId: T1 });
    s.clock.advance(500);
    s.r.onEvent('mission:note_posted', {});
    s.clock.advance(500);
    s.r.onEvent('task:children_completed', { parentTaskId: T2 });
    s.clock.advance(MISSION_REFRESH_WINDOW_MS - 2_000 - 1);
    expect(s.refreshes).toBe(0);
    s.clock.advance(1);
    expect(s.refreshes).toBe(1);
    s.clock.advance(10_000);
    expect(s.refreshes).toBe(1);
  });

  it('a steady stream of structural events stays under one render per window', () => {
    const s = setup();
    for (let i = 0; i < 60; i++) {
      s.r.onEvent('mission:completion_decision', {});
      s.clock.advance(250);
    }
    s.clock.advance(MISSION_REFRESH_WINDOW_MS);
    // 15s of events + one trailing window: never more than ceil(18s / 3s).
    expect(s.refreshes).toBeLessThanOrEqual(6);
    expect(s.refreshes).toBeGreaterThanOrEqual(5);
  });

  it('a worker status change is structural (running → waiting_input moves the row)', () => {
    const s = setup();
    s.r.onEvent('worker:progress', { workerId: W1, taskId: T1, status: 'waiting_input' });
    s.clock.advance(MISSION_REFRESH_WINDOW_MS);
    expect(s.refreshes).toBe(1);
    expect(s.store.getSnapshot()[T1]?.status).toBe('waiting_input');
  });

  it('an unseen worker only records a baseline', () => {
    const s = setup({ workerStatuses: {} });
    s.r.onEvent('worker:progress', { workerId: W1, taskId: T1, status: 'running' });
    s.clock.advance(MISSION_REFRESH_WINDOW_MS);
    expect(s.refreshes).toBe(0);
    s.r.onEvent('worker:progress', { workerId: W1, taskId: T1, status: 'waiting_input' });
    s.clock.advance(MISSION_REFRESH_WINDOW_MS);
    expect(s.refreshes).toBe(1);
  });

  it('the status-less PR webhook nudge is structural', () => {
    const s = setup();
    s.r.onEvent('worker:progress', { taskId: T2 });
    s.clock.advance(MISSION_REFRESH_WINDOW_MS);
    expect(s.refreshes).toBe(1);
  });

  it('a task created on another mission is ignored', () => {
    const s = setup();
    s.r.onEvent('task:created', { task: { missionId: 'mission-b' } });
    s.clock.advance(MISSION_REFRESH_WINDOW_MS);
    expect(s.refreshes).toBe(0);
  });

  it('a task added after load is followed once setTaskIds names it', () => {
    const s = setup();
    s.r.onEvent('task:claimed', { task: { id: 'task-3' } });
    s.clock.advance(MISSION_REFRESH_WINDOW_MS);
    expect(s.refreshes).toBe(0);
    s.r.setTaskIds([T1, T2, 'task-3']);
    s.r.onEvent('task:claimed', { task: { id: 'task-3' } });
    s.clock.advance(MISSION_REFRESH_WINDOW_MS);
    expect(s.refreshes).toBe(1);
  });
});

describe('hidden tab', () => {
  it('renders nothing while hidden and catches up once on return', () => {
    const s = setup({ hidden: true });
    s.r.onEvent('task:created', { task: { missionId: M } });
    s.r.onEvent('worker:failed', { taskId: T1 });
    s.clock.advance(10_000);
    expect(s.refreshes).toBe(0);
    s.setHidden(false);
    s.r.onVisible();
    s.clock.advance(MISSION_REFRESH_WINDOW_MS);
    expect(s.refreshes).toBe(1);
    s.r.onVisible();
    s.clock.advance(MISSION_REFRESH_WINDOW_MS);
    expect(s.refreshes).toBe(1);
  });

  it('a trailing render that comes due after the tab hid is deferred to return', () => {
    const s = setup();
    s.r.onEvent('task:created', { task: { missionId: M } });
    s.setHidden(true);
    s.clock.advance(MISSION_REFRESH_WINDOW_MS);
    expect(s.refreshes).toBe(0);
    s.setHidden(false);
    s.r.onVisible();
    s.clock.advance(MISSION_REFRESH_WINDOW_MS);
    expect(s.refreshes).toBe(1);
  });
});

describe('classifyMissionEvent', () => {
  const ctx = () => ({ missionId: M, taskIds: new Set([T1]), lastStatusByWorker: new Map([[W1, 'running']]) });

  it('accepts the legacy {worker:{taskId}} shape', () => {
    expect(classifyMissionEvent('worker:progress', { workerId: W1, worker: { taskId: T1, status: 'running' } }, ctx()).kind).toBe('patch');
  });

  it('worker:completed forgets the worker baseline', () => {
    const c = ctx();
    classifyMissionEvent('worker:completed', { workerId: W1, taskId: T1 }, c);
    expect(c.lastStatusByWorker.has(W1)).toBe(false);
  });
});

describe('store', () => {
  it('an identical patch does not notify', () => {
    const store = createMissionLiveStore();
    let n = 0;
    store.subscribe(() => n++);
    store.patch(T1, { status: 'running', currentAction: 'a' });
    store.patch(T1, { status: 'running', currentAction: 'a' });
    expect(n).toBe(1);
  });

  it('reset drops every patch', () => {
    const store = createMissionLiveStore();
    store.patch(T1, { currentAction: 'a' });
    store.reset();
    expect(store.getSnapshot()).toEqual({});
  });
});

describe('mergeLiveLines', () => {
  const live = new Set(['running', 'waiting_input']);
  it('the store’s newer action wins over the server line', () => {
    expect(mergeLiveLines({ [T1]: 'old', [T2]: 'kept' }, { [T1]: { workerId: W1, status: 'running', currentAction: 'new', updatedAt: null } }, live))
      .toEqual({ [T1]: 'new', [T2]: 'kept' });
  });

  it('a non-live status drops the line', () => {
    expect(mergeLiveLines({ [T1]: 'old' }, { [T1]: { workerId: W1, status: 'completed', currentAction: null, updatedAt: null } }, live))
      .toEqual({});
  });

  it('no patches → the server object itself', () => {
    const server = { [T1]: 'x' };
    expect(mergeLiveLines(server, {}, live)).toBe(server);
  });
});
