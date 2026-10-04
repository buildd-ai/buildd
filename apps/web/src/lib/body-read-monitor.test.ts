import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';

// No Redis: the per-instance window is what is exercised.
const operatorAlerts: Array<{ title: string; message: string }> = [];
mock.module('./pushover', () => ({
  notifyOperator: (opts: { title: string; message: string }) => { operatorAlerts.push(opts); },
}));
mock.module('./redis', () => ({
  isRedisConfigured: () => false,
  setOnce: async () => false,
  windowMembersAdd: async () => null,
}));

const {
  BODY_READ_ALERT_THRESHOLD, BODY_READ_LIMIT, BODY_READ_WINDOW_SEC, bodyReadRefused, noteBodyReads, resetBodyReadMonitor,
} = await import('./body-read-monitor');

const ids = (n: number, prefix = 'skill') => Array.from({ length: n }, (_, i) => `${prefix}-${i}`);

let warn: ReturnType<typeof spyOn>;
beforeEach(() => {
  resetBodyReadMonitor();
  operatorAlerts.length = 0;
  warn = spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());

describe('noteBodyReads', () => {
  it('counts distinct bodies, not reads: a runner re-reading the same roles never trips it', async () => {
    for (let i = 0; i < 500; i++) {
      const v = await noteBodyReads('acct-runner', ['role-builder', 'role-organizer', 'skill-a'], 'claim_role', { enforce: false });
      expect(v.allowed).toBe(true);
      expect(v.distinct).toBe(3);
    }
    expect(operatorAlerts).toEqual([]);
  });

  it('alerts the operator once when one caller crosses the threshold', async () => {
    const now = 1_000_000;
    await noteBodyReads('acct-1', ids(BODY_READ_ALERT_THRESHOLD - 1), 'skills_list', { nowMs: now });
    expect(operatorAlerts).toHaveLength(0);
    const v = await noteBodyReads('acct-1', ['skill-new'], 'skill_get', { nowMs: now + 1 });
    expect(v).toEqual({ allowed: true, distinct: BODY_READ_ALERT_THRESHOLD });
    expect(operatorAlerts).toHaveLength(1);
    expect(operatorAlerts[0].message).toContain('acct-1');
    expect(operatorAlerts[0].message).not.toContain('skill-new');
    await noteBodyReads('acct-1', ['skill-newer'], 'skill_get', { nowMs: now + 2 });
    expect(operatorAlerts).toHaveLength(1);
    // Another caller is counted on its own.
    expect((await noteBodyReads('acct-2', ['skill-0'], 'skill_get', { nowMs: now })).distinct).toBe(1);
  });

  it('refuses an API read past the limit, but never a claim delivery', async () => {
    const now = 2_000_000;
    expect((await noteBodyReads('acct-3', ids(BODY_READ_LIMIT), 'skills_list', { nowMs: now })).allowed).toBe(true);
    const refused = await noteBodyReads('acct-3', ['one-more'], 'skill_get', { nowMs: now + 1 });
    expect(refused.allowed).toBe(false);
    expect((await noteBodyReads('acct-3', ['claim-role'], 'claim_role', { enforce: false, nowMs: now + 2 })).allowed).toBe(true);
    const res = bodyReadRefused();
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe(String(BODY_READ_WINDOW_SEC));
  });

  it('forgets bodies once the window has passed', async () => {
    const now = 3_000_000;
    await noteBodyReads('acct-4', ids(BODY_READ_LIMIT + 5), 'skills_list', { nowMs: now });
    const later = await noteBodyReads('acct-4', ['fresh'], 'skill_get', { nowMs: now + BODY_READ_WINDOW_SEC * 1000 + 1 });
    expect(later).toEqual({ allowed: true, distinct: 1 });
  });

  it('ignores a read with no caller or no bodies', async () => {
    expect(await noteBodyReads(null, ['x'], 'skill_get')).toEqual({ allowed: true, distinct: null });
    expect(await noteBodyReads('acct-5', [], 'skills_list')).toEqual({ allowed: true, distinct: null });
  });
});
