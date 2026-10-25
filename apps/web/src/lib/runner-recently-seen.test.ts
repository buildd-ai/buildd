import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { RUNNER_LIVE_WINDOW_MS, RUNNER_ONLINE_THRESHOLD_MS, RUNNER_STALE_CUTOFF_MS } from '@buildd/shared';
import { isRunnerOnline, isRunnerRecentlySeen } from './runner-heartbeats-shared';

/**
 * Health lists and counts only runners seen recently: online now, or offline
 * inside the runner-list window. A runner gone longer is off the page and out
 * of "N online · N running", though the heartbeat query still returns it (its
 * window is the "not dead" one, which fails workers and must stay wide).
 */
const NOW = Date.parse('2026-10-25T12:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe('isRunnerRecentlySeen', () => {
  it('an online runner is recently seen', () => {
    expect(isRunnerOnline(ago(30_000), NOW)).toBe(true);
    expect(isRunnerRecentlySeen(ago(30_000), NOW)).toBe(true);
  });

  it('an offline runner inside the list window is listed, as offline', () => {
    const beat = ago(RUNNER_LIVE_WINDOW_MS + 25 * 60_000);
    expect(isRunnerOnline(beat, NOW)).toBe(false);
    expect(isRunnerRecentlySeen(beat, NOW)).toBe(true);
  });

  it('a long-gone runner is not listed, though it is not yet presumed dead', () => {
    const beat = ago(RUNNER_ONLINE_THRESHOLD_MS + 60_000);
    expect(RUNNER_ONLINE_THRESHOLD_MS + 60_000).toBeLessThan(RUNNER_STALE_CUTOFF_MS);
    expect(isRunnerRecentlySeen(beat, NOW)).toBe(false);
  });
});

describe('Health uses it for everything it lists and counts', () => {
  const src = (p: string) => readFileSync(resolve(import.meta.dir, p), 'utf8');

  it('the Health loader filters runners before any count', () => {
    const loader = src('../app/app/(protected)/health/_lib/health-data.ts');
    const filter = loader.indexOf('const runners = heartbeats.filter(r => isRunnerRecentlySeen(r.lastHeartbeatAt, now))');
    expect(filter).toBeGreaterThan(-1);
    expect(filter).toBeLessThan(loader.indexOf('const onlineRunners = runners.filter'));
  });

  it("the runners page's fleet holds the same runners", () => {
    expect(src('./home-fleet.ts')).toContain('isRunnerRecentlySeen(r.lastHeartbeatAt, now)');
  });
});
