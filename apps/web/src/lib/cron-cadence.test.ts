import { describe, it, expect, afterEach } from 'bun:test';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  CRON_SCHEDULES,
  cronIntervalMinutes,
  sweepLookaheadMinutes,
  LOOKAHEAD_SAFETY_FACTOR,
} from './cron-cadence';

describe('cronIntervalMinutes', () => {
  it('reads a minute-step expression', () => {
    expect(cronIntervalMinutes('*/5 * * * *')).toBe(5);
    expect(cronIntervalMinutes('*/30 * * * *')).toBe(30);
  });

  it('reads every-minute', () => {
    expect(cronIntervalMinutes('* * * * *')).toBe(1);
  });

  it('reads an hour-step expression', () => {
    expect(cronIntervalMinutes('0 */4 * * *')).toBe(240);
    expect(cronIntervalMinutes('0 */1 * * *')).toBe(60);
  });

  it('reads hourly-on-the-hour', () => {
    expect(cronIntervalMinutes('0 * * * *')).toBe(60);
  });

  it('reads daily and weekly', () => {
    expect(cronIntervalMinutes('0 6 * * *')).toBe(1440);
    expect(cronIntervalMinutes('0 4 * * 0')).toBe(10080);
  });

  it('rejects an expression it cannot reason about, rather than guessing', () => {
    // A wrong interval silently mis-sizes every derived window, so an
    // unsupported form must fail loudly at the call site.
    expect(() => cronIntervalMinutes('0 7-19 * * *')).toThrow();
    expect(() => cronIntervalMinutes('nonsense')).toThrow();
  });
});

describe('CRON_SCHEDULES', () => {
  // The cadence a route reasons about MUST equal the cadence it is actually
  // invoked at. cron-manifest.json is the single declared source for every
  // /api/cron/* trigger (docs/specs/external-cron-triggers.md). If a schedule
  // changes there, this test fails until the constant follows — and every
  // derived window then re-derives automatically. That is the whole point: move
  // the sweep to `* * * * *` and the lookahead shrinks with it, no code change.
  const manifest = JSON.parse(
    readFileSync(resolve(import.meta.dir, '../../../../cron-manifest.json'), 'utf8'),
  ) as { jobs: { path: string; schedule: string }[] };

  it('matches cron-manifest.json for every declared route', () => {
    for (const [route, schedule] of Object.entries(CRON_SCHEDULES)) {
      const job = manifest.jobs.find(j => j.path.split('?')[0] === `/api/cron/${route}`);
      expect(job, `/api/cron/${route} is not in cron-manifest.json jobs[]`).toBeDefined();
      expect(job!.schedule).toBe(schedule);
    }
  });

  it('declares a schedule this module can convert to an interval', () => {
    for (const schedule of Object.values(CRON_SCHEDULES)) {
      expect(cronIntervalMinutes(schedule)).toBeGreaterThan(0);
    }
  });
});

describe('sweepLookaheadMinutes', () => {
  const KEY = 'MCP_REFRESH_LOOKAHEAD_MINUTES';
  afterEach(() => { delete process.env[KEY]; });

  it('covers a full poll interval plus margin', () => {
    // The bug this replaces: a 10-minute lookahead on a 4-hour cron, so a
    // credential expiring in (10min, 4h] was never refreshed before it died.
    const interval = cronIntervalMinutes(CRON_SCHEDULES['codex-token-refresh']);
    expect(sweepLookaheadMinutes()).toBeGreaterThanOrEqual(interval);
  });

  it('is 5h at the current 4-hourly cadence', () => {
    expect(sweepLookaheadMinutes()).toBe(300);
  });

  it('shrinks automatically when the cadence tightens', () => {
    expect(Math.ceil(1 * LOOKAHEAD_SAFETY_FACTOR)).toBeLessThan(5);
    expect(sweepLookaheadMinutes('* * * * *')).toBeLessThanOrEqual(5);
    expect(sweepLookaheadMinutes('* * * * *')).toBeGreaterThanOrEqual(1);
  });

  it('honours an ops override without a deploy', () => {
    process.env[KEY] = '45';
    expect(sweepLookaheadMinutes()).toBe(45);
  });

  it('ignores a junk override rather than collapsing the window', () => {
    process.env[KEY] = 'not-a-number';
    expect(sweepLookaheadMinutes()).toBe(300);
    process.env[KEY] = '0';
    expect(sweepLookaheadMinutes()).toBe(300);
    process.env[KEY] = '-5';
    expect(sweepLookaheadMinutes()).toBe(300);
  });
});
