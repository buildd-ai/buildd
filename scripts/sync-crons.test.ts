import { describe, expect, test } from 'bun:test';
import {
  parseCronField,
  cronToSchedule,
  methodToCode,
  buildJob,
  signature,
  updateBody,
  loadManifest,
} from './sync-crons';

describe('parseCronField', () => {
  test('wildcard collapses to the cron-job.org "every" sentinel', () => {
    expect(parseCronField('*', 0, 59)).toEqual([-1]);
  });

  test('step expands across the full range', () => {
    expect(parseCronField('*/30', 0, 59)).toEqual([0, 30]);
    expect(parseCronField('*/15', 0, 59)).toEqual([0, 15, 30, 45]);
  });

  test('explicit range expands inclusively — the shape that caused the outage', () => {
    expect(parseCronField('7-19', 0, 23)).toEqual([
      7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19,
    ]);
  });

  test('comma lists and single values', () => {
    expect(parseCronField('1,15', 1, 31)).toEqual([1, 15]);
    expect(parseCronField('4', 0, 23)).toEqual([4]);
  });

  test('deduplicates and sorts overlapping parts', () => {
    expect(parseCronField('5,1-3,2', 0, 59)).toEqual([1, 2, 3, 5]);
  });
});

describe('cronToSchedule', () => {
  test('every 30 minutes, all hours — no hour restriction', () => {
    const s = cronToSchedule('*/30 * * * *', 'UTC');
    expect(s.minutes).toEqual([0, 30]);
    expect(s.hours).toEqual([-1]);
    expect(s.mdays).toEqual([-1]);
    expect(s.months).toEqual([-1]);
    expect(s.wdays).toEqual([-1]);
    expect(s.timezone).toBe('UTC');
    expect(s.expiresAt).toBe(0);
  });

  test('maps cron Sunday=7 onto cron-job.org Sunday=0', () => {
    expect(cronToSchedule('0 4 * * 7', 'UTC').wdays).toEqual([0]);
    expect(cronToSchedule('0 4 * * 0', 'UTC').wdays).toEqual([0]);
  });

  test('rejects an expression that is not 5 fields', () => {
    expect(() => cronToSchedule('*/30 * * *', 'UTC')).toThrow(/5 fields/);
    expect(() => cronToSchedule('0 0 * * * *', 'UTC')).toThrow(/5 fields/);
  });
});

describe('methodToCode', () => {
  test('GET is 0 and POST is 1', () => {
    expect(methodToCode(undefined)).toBe(0);
    expect(methodToCode('GET')).toBe(0);
    expect(methodToCode('POST')).toBe(1);
  });

  test('rejects a method the API has no code for', () => {
    expect(() => methodToCode('DELETE' as 'GET')).toThrow(/DELETE/);
  });
});

describe('buildJob', () => {
  const base = 'https://buildd.dev';

  test('carries the CRON_SECRET bearer header the routes require', () => {
    const j = buildJob(
      { title: 'Buildd: Schedules Tick', path: '/api/cron/schedules', schedule: '*/30 * * * *' },
      'UTC',
      base,
      'shh',
    );
    expect(j.url).toBe('https://buildd.dev/api/cron/schedules');
    expect(j.extendedData.headers.Authorization).toBe('Bearer shh');
    expect(j.requestMethod).toBe(0);
    expect(j.enabled).toBe(true);
  });

  test('POST routes get requestMethod 1', () => {
    const j = buildJob(
      { title: 'Buildd: Stall Notify', path: '/api/cron/stall-notify', schedule: '*/5 * * * *', method: 'POST' },
      'UTC',
      base,
      'shh',
    );
    expect(j.requestMethod).toBe(1);
  });

  test('enabled:false is preserved so a job can be staged but dark', () => {
    const j = buildJob(
      { title: 'x', path: '/api/cron/jwks-rotation', schedule: '0 4 * * 0', enabled: false },
      'UTC',
      base,
      'shh',
    );
    expect(j.enabled).toBe(false);
  });

  test('per-job timezone overrides the manifest default', () => {
    const j = buildJob(
      { title: 'x', path: '/api/cron/schedules', schedule: '0 9 * * *', timezone: 'America/New_York' },
      'UTC',
      base,
      'shh',
    );
    expect(j.schedule.timezone).toBe('America/New_York');
  });
});

describe('signature', () => {
  const mk = (schedule: string) =>
    buildJob({ title: 't', path: '/api/cron/schedules', schedule }, 'UTC', 'https://buildd.dev', 's');

  test('identical jobs compare equal', () => {
    expect(signature(mk('*/30 * * * *'))).toBe(signature(mk('*/30 * * * *')));
  });

  test('an hour restriction is detected as drift', () => {
    // This is exactly the live-vs-manifest difference behind the nightly blackout.
    expect(signature(mk('0 7-19 * * *'))).not.toBe(signature(mk('*/30 * * * *')));
  });

  test('a changed request method is detected as drift', () => {
    const get = buildJob({ title: 't', path: '/p', schedule: '0 * * * *' }, 'UTC', 'b', 's');
    const post = buildJob({ title: 't', path: '/p', schedule: '0 * * * *', method: 'POST' }, 'UTC', 'b', 's');
    expect(signature(get)).not.toBe(signature(post));
  });
});

describe('loadManifest — the checked-in manifest is valid', () => {
  test('every job parses and the schedules tick runs all day', () => {
    const m = loadManifest();
    expect(m.jobs.length).toBeGreaterThan(0);
    for (const job of m.jobs) {
      expect(job.path.startsWith('/api/cron/')).toBe(true);
      expect(() => cronToSchedule(job.schedule, job.timezone || m.timezone || 'UTC')).not.toThrow();
    }
    const tick = m.jobs.find((j) => j.path === '/api/cron/schedules');
    expect(tick).toBeDefined();
    expect(tick!.enabled).not.toBe(false);
    // Regression guard for the 12-hour nightly blackout: no hour restriction.
    expect(cronToSchedule(tick!.schedule, 'UTC').hours).toEqual([-1]);
  });
});

describe('secret handling — the hazard that made a local run risky', () => {
  const mk = (secret: string | undefined) =>
    buildJob({ title: 't', path: '/api/cron/schedules', schedule: '*/30 * * * *' }, 'UTC', 'https://buildd.dev', secret);

  test('a differing CRON_SECRET is NOT reported as drift', () => {
    // Otherwise a stale local secret looks like drift, and "fixing" it
    // overwrites a working job's header and breaks auth.
    expect(signature(mk('local-stale'))).toBe(signature(mk('prod-real')));
  });

  test('but a job with no auth header at all IS drift against one that has it', () => {
    expect(signature(mk(undefined))).not.toBe(signature(mk('prod-real')));
  });

  test('update omits extendedData by default, preserving the live header', () => {
    const body = updateBody(mk('local-stale'), false, true);
    expect('extendedData' in body).toBe(false);
    expect(body.schedule).toBeDefined();
    expect(body.title).toBe('t');
  });

  test('update writes the header when the live job has none', () => {
    const body = updateBody(mk('prod-real'), false, false);
    expect(body.extendedData?.headers.Authorization).toBe('Bearer prod-real');
  });

  test('--rotate-secret writes the header explicitly', () => {
    const body = updateBody(mk('rotated'), true, true);
    expect(body.extendedData?.headers.Authorization).toBe('Bearer rotated');
  });

  test('preserving the header does not mutate the caller\'s job object', () => {
    const job = mk('local-stale');
    updateBody(job, false, true);
    expect(job.extendedData.headers.Authorization).toBe('Bearer local-stale');
  });
});
