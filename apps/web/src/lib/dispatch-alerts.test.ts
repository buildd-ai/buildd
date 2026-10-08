import { describe, it, expect, beforeEach } from 'bun:test';
import {
  alertDispatchFailed,
  alertFloorRepair,
  floorRepairConditions,
  FAILED_ALERT_TTL_SEC,
  FLOOR_ALERT_TTL_SEC,
  type AlertDeps,
} from './dispatch-alerts';

const WS_A = '11111111-1111-4111-8111-111111111111';
const WS_B = '22222222-2222-4222-8222-222222222222';
const ROW = '33333333-3333-4333-8333-333333333333';
const ROW2 = '44444444-4444-4444-8444-444444444444';

const ZERO_RC = { checked: 0, republished: 0, projected: 0, fellBack: 0, left: 0, workerErrors: 0 };
const ZERO_H = { overdue: 0, stuck: 0, failed: 0, unacked: 0, orphaned: 0, unackedStale: 0 };

/** In-memory Redis with the real helpers' contracts; `down` makes every call "could not ask". */
function fakeDeps() {
  const store = new Map<string, unknown>();
  const sent: Array<{ title: string; message: string; priority?: number }> = [];
  const state = { down: false };
  const deps: AlertDeps = {
    tryLock: async (key, _ttl) => {
      if (state.down) return null;
      if (store.has(key)) return false;
      store.set(key, 1);
      return true;
    },
    getKey: async <T,>(key: string) => (state.down ? undefined : ((store.get(key) as T | undefined) ?? null)),
    setWithTtl: async (key, value, _ttl) => { if (state.down) return false; store.set(key, value); return true; },
    delKey: async key => { if (!state.down) store.delete(key); },
    notify: o => { sent.push({ title: o.title, message: o.message, priority: o.priority }); },
  };
  return { deps, sent, store, state };
}

describe('alertDispatchFailed (receipts route: a terminal failed receipt)', () => {
  let f: ReturnType<typeof fakeDeps>;
  beforeEach(() => { f = fakeDeps(); });

  it('sends one alert naming the workspace, an outbox id and the error, and calls it a bug signal', async () => {
    const r = await alertDispatchFailed([{ id: ROW, workspaceId: WS_A, error: 'http_500' }], f.deps);
    expect(r).toEqual({ alerted: [WS_A], muted: [] });
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0].title).toContain('Dispatch delivery failed');
    expect(f.sent[0].message).toContain(WS_A);
    expect(f.sent[0].message).toContain(ROW);
    expect(f.sent[0].message).toContain('http_500');
    expect(f.sent[0].message).toContain('bug signal');
  });

  it('dedupes per workspace for a few hours', async () => {
    await alertDispatchFailed([{ id: ROW, workspaceId: WS_A, error: 'x' }], f.deps);
    const again = await alertDispatchFailed([{ id: ROW2, workspaceId: WS_A, error: 'y' }], f.deps);
    expect(again).toEqual({ alerted: [], muted: [WS_A] });
    expect(f.sent).toHaveLength(1);
    // Another workspace still alerts.
    await alertDispatchFailed([{ id: ROW2, workspaceId: WS_B, error: 'y' }], f.deps);
    expect(f.sent).toHaveLength(2);
    expect(FAILED_ALERT_TTL_SEC).toBeGreaterThanOrEqual(2 * 3600);
  });

  it('several workspaces in one batch: one digest, counted per workspace', async () => {
    await alertDispatchFailed([
      { id: ROW, workspaceId: WS_A, error: 'x' },
      { id: ROW2, workspaceId: WS_A, error: 'x' },
      { id: ROW2, workspaceId: WS_B, error: null },
    ], f.deps);
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0].message).toContain('2 wakes');
    expect(f.sent[0].message).toContain(WS_B);
  });

  it('fails open when Redis is unavailable', async () => {
    f.state.down = true;
    await alertDispatchFailed([{ id: ROW, workspaceId: WS_A, error: 'x' }], f.deps);
    await alertDispatchFailed([{ id: ROW, workspaceId: WS_A, error: 'x' }], f.deps);
    expect(f.sent).toHaveLength(2);
  });

  it('nothing failed: no Redis call, no alert', async () => {
    expect(await alertDispatchFailed([], f.deps)).toEqual({ alerted: [], muted: [] });
    expect(f.sent).toHaveLength(0);
  });
});

describe('floorRepairConditions', () => {
  it('a quiet floor has no conditions', () => {
    expect(floorRepairConditions({ reconcile: ZERO_RC, health: ZERO_H })).toEqual([]);
  });

  it('repairs, worker errors, orphans and unacked rows past the fallback are conditions', () => {
    const c = floorRepairConditions({
      reconcile: { ...ZERO_RC, republished: 2, projected: 1, fellBack: 3, workerErrors: 1, left: 9, checked: 16 },
      health: { ...ZERO_H, orphaned: 4, unackedStale: 5 },
    });
    expect(c.map(x => x.key)).toEqual(['republished', 'projected', 'fellBack', 'workerErrors', 'orphaned', 'unackedStale']);
    expect(c.find(x => x.key === 'fellBack')?.count).toBe(3);
  });

  it('fresh unacked rows, failed and overdue counts do not alert from the floor', () => {
    // Unacked rows are the in-app drain's after the grace; a terminal failure
    // alerts from the receipts route when it happens.
    expect(floorRepairConditions({ reconcile: ZERO_RC, health: { ...ZERO_H, unacked: 7, failed: 3, overdue: 2 } })).toEqual([]);
  });

  it('a reconcile that threw is itself a condition', () => {
    expect(floorRepairConditions({ reconcile: { error: 'boom' }, health: ZERO_H }).map(c => c.key)).toEqual(['reconcileFailed']);
  });

  it('an unreadable health report adds nothing', () => {
    expect(floorRepairConditions({ reconcile: ZERO_RC, health: { error: 'db' } })).toEqual([]);
  });
});

describe('alertFloorRepair (hourly backstop)', () => {
  let f: ReturnType<typeof fakeDeps>;
  beforeEach(() => { f = fakeDeps(); });

  it('alerts with every count and says repair is a bug signal, not routine', async () => {
    const r = await alertFloorRepair([{ key: 'fellBack', count: 3 }, { key: 'orphaned', count: 1 }], f.deps);
    expect(r).toBe('alerted');
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0].message).toContain('fellBack=3');
    expect(f.sent[0].message).toContain('orphaned=1');
    expect(f.sent[0].message).toContain('bug signal');
    expect(f.sent[0].message).toContain('not routine');
  });

  it('the same condition alerts at most once per window', async () => {
    await alertFloorRepair([{ key: 'fellBack', count: 3 }], f.deps);
    expect(await alertFloorRepair([{ key: 'fellBack', count: 5 }], f.deps)).toBe('muted');
    expect(f.sent).toHaveLength(1);
    expect(FLOOR_ALERT_TTL_SEC).toBeGreaterThanOrEqual(2 * 3600);
    // A different condition set is a different signal.
    expect(await alertFloorRepair([{ key: 'workerErrors', count: 1 }], f.deps)).toBe('alerted');
  });

  it('sends one recovery note when it clears, then stays quiet', async () => {
    await alertFloorRepair([{ key: 'fellBack', count: 3 }], f.deps);
    expect(await alertFloorRepair([], f.deps)).toBe('recovered');
    expect(f.sent[1].title).toContain('cleared');
    expect(await alertFloorRepair([], f.deps)).toBe('quiet');
    expect(f.sent).toHaveLength(2);
    // After recovery a recurrence alerts at once, not after the window.
    expect(await alertFloorRepair([{ key: 'fellBack', count: 1 }], f.deps)).toBe('alerted');
  });

  it('fails open on Redis: alerts every time, and sends no recovery it cannot know about', async () => {
    f.state.down = true;
    expect(await alertFloorRepair([{ key: 'orphaned', count: 1 }], f.deps)).toBe('alerted');
    expect(await alertFloorRepair([{ key: 'orphaned', count: 1 }], f.deps)).toBe('alerted');
    expect(await alertFloorRepair([], f.deps)).toBe('quiet');
    expect(f.sent).toHaveLength(2);
  });
});
