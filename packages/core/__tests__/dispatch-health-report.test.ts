import { describe, expect, test } from 'bun:test';
import {
  dispatchVerdict,
  formatDispatchHealth,
  emptyTeamHealth,
  FLOOR_STALE_MS,
  type DispatchHealthInput,
  type DispatchHealthReport,
} from '../dispatch-health-report';

const NOW = Date.parse('2026-10-04T12:00:00.000Z');
const ZERO_RC = { checked: 0, republished: 0, projected: 0, fellBack: 0, left: 0, workerErrors: 0 };

const input = (over: Partial<DispatchHealthInput> = {}): DispatchHealthInput => ({
  outbox: { ...emptyTeamHealth(), delivered24h: 9, deliveredVia: { dispatch: 7, pusher: 2 }, latencyMs: { p50: 812, p95: 4100, samples: 9 } },
  workspaces: [{ id: 'w1', name: 'alpha', transport: 'dispatch' }, { id: 'w2', name: 'beta', transport: 'dispatch' }],
  worker: { status: 'reachable', workerConfigured: true, ms: 40 },
  lastRepair: { at: new Date(NOW - 20 * 60_000).toISOString(), ok: true, reconcile: { ...ZERO_RC }, reconcileError: null },
  ...over,
});

const report = (over: Partial<DispatchHealthInput> = {}): DispatchHealthReport => {
  const i = input(over);
  return { generatedAt: new Date(NOW).toISOString(), ...i, ...dispatchVerdict(i, NOW) };
};

describe('dispatchVerdict', () => {
  test('healthy leads with one line naming throughput and latency', () => {
    const v = dispatchVerdict(input(), NOW);
    expect(v.healthy).toBe(true);
    expect(v.problems).toEqual([]);
    expect(v.verdict).toBe('Healthy: 9 wakes delivered in 24h, p95 4.1s.');
  });

  test('each problem is named, worst first', () => {
    const v = dispatchVerdict(input({
      outbox: { ...emptyTeamHealth(), failed24h: 2, orphaned: 1, unackedStale: 3, overdue: 4, stuck: 1, unacked: 9 },
      worker: { status: 'unreachable', error: 'timeout' },
    }), NOW);
    expect(v.healthy).toBe(false);
    expect(v.problems).toEqual([
      'Dispatch Worker unreachable (timeout)',
      '2 wakes failed in 24h',
      '1 handed-off wake over an hour past due with no receipt',
      '3 unacked wakes the in-app fallback did not take',
      '4 wakes due over 5 min and undelivered',
      '1 wake delivering for over 5 min',
    ]);
    expect(v.verdict).toBe('6 issues: Dispatch Worker unreachable (timeout); 2 wakes failed in 24h; +4 more');
  });

  test('fresh unacked rows are not a problem: the in-app drain takes them after the grace', () => {
    expect(dispatchVerdict(input({ outbox: { ...emptyTeamHealth(), unacked: 4 } }), NOW).healthy).toBe(true);
  });

  test('transport not configured is a problem only when a workspace is on dispatch', () => {
    const off = { status: 'unconfigured' as const };
    expect(dispatchVerdict(input({ worker: off }), NOW).problems).toEqual(['Dispatch transport not configured: 2 workspaces on dispatch deliver in-app only']);
    expect(dispatchVerdict(input({ worker: off, workspaces: [{ id: 'w1', name: 'a', transport: 'in_app' }] }), NOW).healthy).toBe(true);
  });

  test('a Worker that answers but reports itself unconfigured', () => {
    expect(dispatchVerdict(input({ worker: { status: 'reachable', workerConfigured: false } }), NOW).problems)
      .toEqual(['Dispatch Worker reachable but reports itself unconfigured']);
  });

  test('the last floor run: repairs, errors, failure and staleness are problems; a missing record is not', () => {
    const at = new Date(NOW - 10 * 60_000).toISOString();
    expect(dispatchVerdict(input({ lastRepair: { at, ok: true, reconcile: { ...ZERO_RC, fellBack: 2, republished: 1 }, reconcileError: null } }), NOW).problems)
      .toEqual(['Last floor run had to repair 3 rows (platform-wide)']);
    expect(dispatchVerdict(input({ lastRepair: { at, ok: true, reconcile: { ...ZERO_RC, workerErrors: 2 }, reconcileError: null } }), NOW).problems)
      .toEqual(['Last floor run had 2 Worker errors (platform-wide)']);
    expect(dispatchVerdict(input({ lastRepair: { at, ok: true, reconcile: null, reconcileError: 'boom' } }), NOW).problems)
      .toEqual(['Last floor run: reconcile failed (boom)']);
    expect(dispatchVerdict(input({ lastRepair: { at, ok: false, reconcile: null, reconcileError: null } }), NOW).problems)
      .toEqual(['Last floor run failed']);
    const old = new Date(NOW - FLOOR_STALE_MS - 60_000).toISOString();
    expect(dispatchVerdict(input({ lastRepair: { at: old, ok: true, reconcile: ZERO_RC, reconcileError: null } }), NOW).problems[0])
      .toMatch(/^Floor has not run for 2h/);
    expect(dispatchVerdict(input({ lastRepair: null }), NOW).healthy).toBe(true);
  });

  test('no deliveries yet reads as healthy and says so', () => {
    expect(dispatchVerdict(input({ outbox: emptyTeamHealth() }), NOW).verdict).toBe('Healthy: no wakes delivered in 24h.');
  });
});

describe('formatDispatchHealth', () => {
  test('terse: verdict first, then counts, routes, latency, Worker, floor, kill switch', () => {
    const text = formatDispatchHealth(report({
      workspaces: [
        { id: 'w1', name: 'alpha', transport: 'dispatch' },
        { id: 'w2', name: 'beta', transport: 'in_app' },
      ],
    }));
    const lines = text.split('\n');
    expect(lines[0]).toBe('Dispatch: Healthy: 9 wakes delivered in 24h, p95 4.1s.');
    expect(text).toContain('Outbox (2 workspaces): pending 0 (due 0, overdue 0) · delivering 0 (stuck 0) · handed off 0 · unacked 0 (stale 0) · orphaned 0 · failed 24h 0');
    expect(text).toContain('Delivered 24h: 9 (dispatch 7, pusher 2) · latency p50 0.8s, p95 4.1s (n=9)');
    expect(text).toContain('Worker: reachable (40 ms)');
    expect(text).toContain('Last floor run (platform-wide): 2026-10-04T11:40:00.000Z, ok · checked 0, republished 0, projected 0, fellBack 0, left 0, workerErrors 0');
    expect(text).toContain('Not on dispatch (kill switch): beta (in_app)');
    expect(text).not.toContain('Problems:');
  });

  test('lists every problem when unhealthy, and says when the floor result is not stored', () => {
    const text = formatDispatchHealth(report({
      outbox: { ...emptyTeamHealth(), failed24h: 1, orphaned: 2 },
      worker: { status: 'unreachable', error: 'http_502' },
      lastRepair: null,
    }));
    expect(text.split('\n')[0]).toBe('Dispatch: 3 issues: Dispatch Worker unreachable (http_502); 1 wake failed in 24h; +1 more');
    expect(text).toContain('Problems:\n- Dispatch Worker unreachable (http_502)\n- 1 wake failed in 24h\n- 2 handed-off wakes over an hour past due with no receipt');
    expect(text).toContain('Worker: unreachable (http_502)');
    expect(text).toContain('Last floor run: none recorded');
    expect(text).toContain('Delivered 24h: 0\nWorker');
  });
});
