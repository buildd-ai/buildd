import { describe, it, expect, beforeEach } from 'bun:test';
import {
  createThrottle,
  createEscalationRefresher,
  shouldRefreshHomeOnEvent,
  needsInputEventAction,
  createReconnectDetector,
  type Clock,
} from './realtime-throttle';

/**
 * The runner PATCHes every active worker every ~10s and each PATCH publishes
 * `worker:progress` on the workspace channel. These pin that the layout-wide
 * consumers do a small, constant amount of work per minute regardless of how
 * many workers are syncing.
 */

/** Deterministic clock: timers fire only when `advance` passes their deadline. */
function fakeClock(): Clock & { advance(ms: number): void } {
  let t = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => t,
    setTimeout: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { at: t + ms, fn });
      return id;
    },
    clearTimeout: (id) => { timers.delete(id as number); },
    advance(ms: number) {
      const end = t + ms;
      for (;;) {
        let due: [number, { at: number; fn: () => void }] | null = null;
        for (const entry of timers) {
          if (entry[1].at <= end && (!due || entry[1].at < due[1].at)) due = entry;
        }
        if (!due) break;
        timers.delete(due[0]);
        t = due[1].at;
        due[1].fn();
      }
      t = end;
    },
  };
}

/** Stand-in for a pusher-client channel: bind() records, emit() dispatches. */
function fakeChannel() {
  const handlers = new Map<string, Array<(data: unknown) => void>>();
  return {
    bind(event: string, fn: (data: unknown) => void) {
      handlers.set(event, [...(handlers.get(event) ?? []), fn]);
    },
    emit(event: string, data: unknown) {
      for (const fn of handlers.get(event) ?? []) fn(data);
    },
  };
}

describe('createThrottle', () => {
  it('fires the first call immediately (leading)', () => {
    const clock = fakeClock();
    let n = 0;
    const t = createThrottle(() => n++, { waitMs: 1000 }, clock);
    t.call();
    expect(n).toBe(1);
  });

  it('collapses a steady stream into one call per interval', () => {
    const clock = fakeClock();
    let n = 0;
    const t = createThrottle(() => n++, { waitMs: 15_000 }, clock);
    // One event every 500ms for a minute.
    for (let i = 0; i < 120; i++) {
      t.call();
      clock.advance(500);
    }
    clock.advance(30_000);
    expect(n).toBeGreaterThanOrEqual(4);
    expect(n).toBeLessThanOrEqual(5);
  });

  it('max-wait caps a debounce that keeps getting reset', () => {
    const clock = fakeClock();
    let n = 0;
    const t = createThrottle(() => n++, { waitMs: 2000, maxWaitMs: 5000, leading: false }, clock);
    for (let i = 0; i < 10; i++) {
      t.call();
      clock.advance(1000);
    }
    // Without maxWait nothing would have fired yet (every call reset the 2s wait).
    expect(n).toBe(2);
  });

  it('trailing-only debounce fires once after the quiet period', () => {
    const clock = fakeClock();
    let n = 0;
    const t = createThrottle(() => n++, { waitMs: 2000, leading: false }, clock);
    t.call();
    t.call();
    t.call();
    expect(n).toBe(0);
    clock.advance(2000);
    expect(n).toBe(1);
  });

  it('maxDelayMs pulls a pending trailing call forward', () => {
    const clock = fakeClock();
    let n = 0;
    const t = createThrottle(() => n++, { waitMs: 12_000 }, clock);
    t.call(); // leading
    clock.advance(1000);
    t.call(); // trailing, due ~12s out
    t.call({ maxDelayMs: 500 });
    clock.advance(500);
    expect(n).toBe(2);
    // A later normal call does not push the urgent deadline back out.
    t.call({ maxDelayMs: 500 });
    t.call();
    clock.advance(500);
    expect(n).toBe(3);
  });

  it('cancel drops the pending trailing call', () => {
    const clock = fakeClock();
    let n = 0;
    const t = createThrottle(() => n++, { waitMs: 1000 }, clock);
    t.call();
    t.call();
    t.cancel();
    clock.advance(5000);
    expect(n).toBe(1);
  });
});

describe('createEscalationRefresher', () => {
  let clock: ReturnType<typeof fakeClock>;
  let fetches: number;
  let hidden: boolean;
  let channel: ReturnType<typeof fakeChannel>;
  let refresher: ReturnType<typeof createEscalationRefresher>;

  beforeEach(() => {
    clock = fakeClock();
    fetches = 0;
    hidden = false;
    channel = fakeChannel();
    refresher = createEscalationRefresher({
      fetch: () => { fetches++; },
      isHidden: () => hidden,
      clock,
    });
    for (const event of ['worker:progress', 'worker:completed', 'mission:note_posted']) {
      channel.bind(event, (data) => refresher.onEvent(event, data));
    }
  });

  it('20 same-status progress events → at most 2 fetches', () => {
    for (let i = 0; i < 20; i++) {
      channel.emit('worker:progress', { workerId: 'w1', taskId: 't1', status: 'running' });
      clock.advance(500);
    }
    clock.advance(60_000);
    expect(fetches).toBeLessThanOrEqual(2);
  });

  it('many workers syncing at steady status → no fetches at all', () => {
    for (let tick = 0; tick < 6; tick++) {
      for (let w = 0; w < 25; w++) {
        channel.emit('worker:progress', { workerId: `w${w}`, taskId: `t${w}`, status: 'running' });
      }
      clock.advance(10_000);
    }
    expect(fetches).toBe(0);
  });

  it('mission:note_posted fetches immediately', () => {
    channel.emit('mission:note_posted', { missionId: 'm1' });
    expect(fetches).toBe(1);
  });

  it('note bursts are throttled to one fetch per 15s', () => {
    for (let i = 0; i < 30; i++) {
      channel.emit('mission:note_posted', { missionId: 'm1' });
      clock.advance(500);
    }
    clock.advance(20_000);
    expect(fetches).toBeLessThanOrEqual(2);
  });

  it('a worker status change fetches', () => {
    channel.emit('worker:progress', { workerId: 'w1', taskId: 't1', status: 'running' });
    expect(fetches).toBe(0);
    channel.emit('worker:progress', { workerId: 'w1', taskId: 't1', status: 'waiting_input' });
    expect(fetches).toBe(1);
  });

  it('worker:completed goes through a 2s trailing debounce', () => {
    channel.emit('worker:completed', { workerId: 'w1', taskId: 't1', status: 'completed' });
    channel.emit('worker:completed', { workerId: 'w2', taskId: 't2', status: 'completed' });
    expect(fetches).toBe(0);
    clock.advance(2000);
    expect(fetches).toBe(1);
  });

  it('status-less progress (webhook/merge) does not fetch', () => {
    for (let i = 0; i < 10; i++) channel.emit('worker:progress', { taskId: 't1' });
    clock.advance(30_000);
    expect(fetches).toBe(0);
  });

  it('hidden tab → no fetches; exactly one catch-up on visible', () => {
    hidden = true;
    channel.emit('mission:note_posted', {});
    channel.emit('worker:progress', { workerId: 'w1', status: 'running' });
    channel.emit('worker:progress', { workerId: 'w1', status: 'waiting_input' });
    channel.emit('worker:completed', { workerId: 'w1', status: 'completed' });
    clock.advance(60_000);
    expect(fetches).toBe(0);

    hidden = false;
    refresher.onVisible();
    refresher.onVisible();
    expect(fetches).toBe(1);
  });

  it('visible with nothing missed → no catch-up fetch', () => {
    refresher.onVisible();
    expect(fetches).toBe(0);
  });

  it('a trailing fetch that comes due while hidden is deferred to visible', () => {
    channel.emit('mission:note_posted', {}); // leading fetch
    channel.emit('mission:note_posted', {}); // trailing pending
    hidden = true;
    clock.advance(20_000);
    expect(fetches).toBe(1);
    hidden = false;
    refresher.onVisible();
    expect(fetches).toBe(2);
  });

  it('dispose cancels pending work', () => {
    channel.emit('mission:note_posted', {});
    channel.emit('mission:note_posted', {});
    channel.emit('worker:completed', { workerId: 'w1' });
    refresher.dispose();
    clock.advance(60_000);
    expect(fetches).toBe(1);
  });
});

describe('shouldRefreshHomeOnEvent', () => {
  let seen: Map<string, string>;
  beforeEach(() => { seen = new Map(); });

  it('first sighting of a worker only records its status', () => {
    expect(shouldRefreshHomeOnEvent('worker:progress', { workerId: 'w1', status: 'running' }, seen)).toBe('none');
    expect(seen.get('w1')).toBe('running');
  });

  it('repeated running after the first sighting → no refresh', () => {
    shouldRefreshHomeOnEvent('worker:progress', { workerId: 'w1', status: 'running' }, seen);
    for (let i = 0; i < 5; i++) {
      expect(shouldRefreshHomeOnEvent('worker:progress', { workerId: 'w1', status: 'running' }, seen)).toBe('none');
    }
  });

  it('running → waiting_input refreshes urgently', () => {
    shouldRefreshHomeOnEvent('worker:progress', { workerId: 'w1', status: 'running' }, seen);
    expect(shouldRefreshHomeOnEvent('worker:progress', { workerId: 'w1', status: 'waiting_input' }, seen)).toBe('urgent');
  });

  it('a non-urgent status change refreshes, throttled', () => {
    shouldRefreshHomeOnEvent('worker:progress', { workerId: 'w1', status: 'idle' }, seen);
    expect(shouldRefreshHomeOnEvent('worker:progress', { workerId: 'w1', status: 'running' }, seen)).toBe('throttled');
  });

  it('{taskId} only (webhook / merge / PR refresh) always refreshes', () => {
    expect(shouldRefreshHomeOnEvent('worker:progress', { taskId: 't1' }, seen)).not.toBe('none');
    expect(shouldRefreshHomeOnEvent('worker:progress', { taskId: 't1' }, seen)).not.toBe('none');
  });

  it('terminal worker events refresh urgently', () => {
    expect(shouldRefreshHomeOnEvent('worker:completed', { workerId: 'w1', status: 'completed' }, seen)).toBe('urgent');
    expect(shouldRefreshHomeOnEvent('worker:failed', { workerId: 'w2', status: 'failed' }, seen)).toBe('urgent');
  });

  it('non-progress task events refresh as before', () => {
    for (const e of ['task:created', 'task:claimed', 'task:completed', 'task:failed', 'task:unblocked']) {
      expect(shouldRefreshHomeOnEvent(e, { taskId: 't1' }, seen)).not.toBe('none');
    }
  });

  it('20 status-changing events in 10s through the Home throttle → at most 2 refreshes', () => {
    const clock = fakeClock();
    let refreshes = 0;
    const throttle = createThrottle(() => refreshes++, { waitMs: 12_000 }, clock);
    for (let i = 0; i < 20; i++) {
      // Alternate between two non-urgent statuses so every event is a change.
      const status = i % 2 === 0 ? 'running' : 'idle';
      const d = shouldRefreshHomeOnEvent('worker:progress', { workerId: `w${i % 3}`, status }, seen);
      if (d !== 'none') throttle.call(d === 'urgent' ? { maxDelayMs: 500 } : undefined);
      clock.advance(500);
    }
    expect(refreshes).toBeLessThanOrEqual(2);
  });
});

describe('needsInputEventAction', () => {
  const known = new Set(['t1']);

  it('status-less progress keeps a waiting task (CI/merge webhooks)', () => {
    expect(needsInputEventAction('worker:progress', { taskId: 't1' }, known)).toEqual({ kind: 'none' });
  });

  it('a non-waiting status removes it', () => {
    expect(needsInputEventAction('worker:progress', { taskId: 't1', status: 'running' }, known))
      .toEqual({ kind: 'remove', taskId: 't1' });
  });

  it('worker:completed / worker:failed remove it', () => {
    expect(needsInputEventAction('worker:completed', { taskId: 't1' }, known)).toEqual({ kind: 'remove', taskId: 't1' });
    expect(needsInputEventAction('worker:failed', { taskId: 't1', status: 'failed' }, known)).toEqual({ kind: 'remove', taskId: 't1' });
  });

  it('waiting_input for an already-listed task does not refetch', () => {
    expect(needsInputEventAction('worker:progress', { taskId: 't1', status: 'waiting_input' }, known)).toEqual({ kind: 'none' });
  });

  it('waiting_input for a new task refetches', () => {
    expect(needsInputEventAction('worker:progress', { taskId: 't2', status: 'waiting_input' }, known)).toEqual({ kind: 'refetch' });
  });

  it('accepts the legacy {worker:{taskId,status}} shape', () => {
    expect(needsInputEventAction('worker:progress', { worker: { taskId: 't2', status: 'waiting_input' } }, known))
      .toEqual({ kind: 'refetch' });
  });

  it('events for tasks not in the list are ignored unless they start waiting', () => {
    expect(needsInputEventAction('worker:progress', { taskId: 't9', status: 'running' }, known)).toEqual({ kind: 'none' });
    expect(needsInputEventAction('worker:completed', { taskId: 't9' }, known)).toEqual({ kind: 'none' });
    expect(needsInputEventAction('worker:progress', { status: 'waiting_input' }, known)).toEqual({ kind: 'none' });
  });
});

describe('createReconnectDetector', () => {
  it('ignores the initial connect and reports a reconnect after a drop', () => {
    const isReconnect = createReconnectDetector();
    expect(isReconnect({ previous: 'initialized', current: 'connecting' })).toBe(false);
    expect(isReconnect({ previous: 'connecting', current: 'connected' })).toBe(false);
    expect(isReconnect({ previous: 'connected', current: 'unavailable' })).toBe(false);
    expect(isReconnect({ previous: 'unavailable', current: 'connecting' })).toBe(false);
    expect(isReconnect({ previous: 'connecting', current: 'connected' })).toBe(true);
    expect(isReconnect({ previous: 'connected', current: 'connected' })).toBe(false);
  });
});
