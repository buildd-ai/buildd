import { describe, expect, test } from 'bun:test';
import {
  CHECKOUT_TRIGGER_BYTES,
  LOW_DISK_TRIGGER_BYTES,
  MEMORY_PRESSURE_RATIO,
  STANDARD_MEMORY_BYTES,
  describeRunnerSizeReason,
  resolveRunnerSize,
  runnerSizeTrigger,
} from './runner-size';

const GIB = 1024 ** 3;
const NOW = new Date('2026-10-01T12:00:00Z');

/** A run report as the cloud runner delivers it (run-report.ts), trimmed to what the rule reads. */
function report(over: Record<string, unknown> = {}) {
  return {
    kind: 'cloud-run-report',
    instanceType: 'standard-1',
    outcome: 'done',
    interruption: null,
    resources: { memoryPeakBytes: 1 * GIB, memoryLimitBytes: 4 * GIB, diskFreeMinBytes: 5 * GIB, diskTotalBytes: 8 * GIB },
    repo: { bytes: { warmRepo: 200 * 1024 ** 2, cache: 100 * 1024 ** 2, cacheRaw: 300 * 1024 ** 2 }, cacheSkipped: null },
    ...over,
  };
}

describe('runnerSizeTrigger: one per trigger', () => {
  test('a light run triggers nothing', () => {
    expect(runnerSizeTrigger(report())).toBeNull();
  });

  test('memory: working set within ~10% of the class memory', () => {
    expect(MEMORY_PRESSURE_RATIO).toBe(0.9);
    const limit = 4 * GIB;
    expect(runnerSizeTrigger(report({ resources: { memoryPeakBytes: Math.ceil(limit * 0.9), memoryLimitBytes: limit } }))).toBe('memory_pressure');
    expect(runnerSizeTrigger(report({ resources: { memoryPeakBytes: Math.floor(limit * 0.89), memoryLimitBytes: limit } }))).toBeNull();
  });

  test('memory: the class memory stands in when the container reported no limit', () => {
    const peak = Math.ceil(STANDARD_MEMORY_BYTES * 0.95);
    expect(runnerSizeTrigger(report({ resources: { memoryPeakBytes: peak, memoryLimitBytes: null } }))).toBe('memory_pressure');
    // Same peak on the large class (8 GiB) is not pressure.
    expect(runnerSizeTrigger(report({ instanceType: 'standard-3', resources: { memoryPeakBytes: peak, memoryLimitBytes: null } }))).toBeNull();
  });

  test('disk: minimum free disk under ~3 GB', () => {
    expect(LOW_DISK_TRIGGER_BYTES).toBe(3e9);
    expect(runnerSizeTrigger(report({ resources: { diskFreeMinBytes: 2.9e9 } }))).toBe('low_disk');
    expect(runnerSizeTrigger(report({ resources: { diskFreeMinBytes: 3.1e9 } }))).toBeNull();
  });

  test('restart: the container stopped under the run', () => {
    expect(runnerSizeTrigger(report({ outcome: 'crashed', interruption: 'container_stopped' }))).toBe('container_restart');
  });

  test.each([
    ['a deploy (the agent restarted)', 'agent_restart', 'crashed'],
    ['a question (parked waiting for input)', 'question', 'parked'],
  ])('restart: not one caused by %s', (_label, interruption, outcome) => {
    expect(runnerSizeTrigger(report({ outcome, interruption }))).toBeNull();
  });

  test('checkout: warm checkout plus cache over a few GB', () => {
    expect(CHECKOUT_TRIGGER_BYTES).toBe(4e9);
    expect(runnerSizeTrigger(report({ repo: { bytes: { warmRepo: 2.5e9, cacheRaw: 1.6e9 } } }))).toBe('large_checkout');
    expect(runnerSizeTrigger(report({ repo: { bytes: { warmRepo: 2.5e9, cacheRaw: 1.0e9 } } }))).toBeNull();
  });

  test('checkout: a cache left out of the upload for size still counts', () => {
    expect(runnerSizeTrigger(report({ repo: { bytes: { warmRepo: 1e9, cacheRaw: null }, cacheSkipped: { part: 'cache', bytes: 3.5e9, cap: 1e9 } } }))).toBe('large_checkout');
  });

  test.each([[null], [undefined], ['x'], [{}], [{ resources: 'x', repo: 7 }]])('anything malformed (%p) triggers nothing', (r) => {
    expect(runnerSizeTrigger(r)).toBeNull();
  });
});

describe('resolveRunnerSize', () => {
  test('nothing set, no reports: standard by default', () => {
    expect(resolveRunnerSize({ gitConfig: null, reports: [], now: NOW })).toEqual({ size: 'standard', source: 'default', reason: null });
  });

  test('a recent heavy run derives large, and asks to persist it', () => {
    const r = resolveRunnerSize({ gitConfig: {}, reports: [report(), report({ resources: { diskFreeMinBytes: 1e9 } })], now: NOW });
    expect(r).toEqual({
      size: 'large', source: 'derived', reason: 'low_disk',
      persist: { size: 'large', reason: 'low_disk', at: NOW.toISOString() },
    });
  });

  test('the newest triggering report names the reason', () => {
    const r = resolveRunnerSize({
      gitConfig: {},
      reports: [report({ outcome: 'crashed', interruption: 'container_stopped' }), report({ resources: { diskFreeMinBytes: 1e9 } })],
      now: NOW,
    });
    expect(r.reason).toBe('container_restart');
  });

  test('sticky: once derived, light runs do not move it back', () => {
    const gitConfig = { runnerSizeDerived: { size: 'large', reason: 'memory_pressure', at: '2026-09-01T00:00:00.000Z' } };
    const r = resolveRunnerSize({ gitConfig, reports: [report(), report(), report()], now: NOW });
    expect(r).toEqual({ size: 'large', source: 'derived', reason: 'memory_pressure' });
    expect(r.persist).toBeUndefined();
  });

  test('a malformed sticky marker is ignored', () => {
    for (const runnerSizeDerived of [{ size: 'huge', reason: 'low_disk' }, { size: 'large', reason: 'bored' }, 'large', null]) {
      expect(resolveRunnerSize({ gitConfig: { runnerSizeDerived }, reports: [report()], now: NOW }).size).toBe('standard');
    }
  });

  test('explicit standard overrides both a sticky marker and a heavy run', () => {
    const gitConfig = { runnerSize: 'standard', runnerSizeDerived: { size: 'large', reason: 'low_disk', at: NOW.toISOString() } };
    const r = resolveRunnerSize({ gitConfig, reports: [report({ resources: { diskFreeMinBytes: 1 } })], now: NOW });
    expect(r).toEqual({ size: 'standard', source: 'explicit', reason: null });
  });

  test('explicit large needs no evidence', () => {
    expect(resolveRunnerSize({ gitConfig: { runnerSize: 'large' }, reports: [], now: NOW })).toEqual({ size: 'large', source: 'explicit', reason: null });
  });

  test('an unknown explicit value is not an override', () => {
    expect(resolveRunnerSize({ gitConfig: { runnerSize: 'xl' }, reports: [], now: NOW }).source).toBe('default');
  });
});

describe('describeRunnerSizeReason', () => {
  test('plain words for every reason', () => {
    for (const reason of ['memory_pressure', 'low_disk', 'container_restart', 'large_checkout'] as const) {
      expect(describeRunnerSizeReason(reason)).toMatch(/^[A-Z][^_]+\.$/);
    }
  });
});
