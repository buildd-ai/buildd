/**
 * Signups, DAU and MAU against real Postgres (lib/active-days.ts writes,
 * lib/admin/growth.ts reads).
 *
 * The unit suite stubs db.execute, so neither the ON CONFLICT nor the UTC day
 * arithmetic nor the distinct counting is observable there. This seeds people
 * and active days in a year no other suite writes to, then reads them back
 * through the real queries.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { recordActiveDay, resetActiveDayCache } from '@/lib/active-days';
import { loadGrowth } from '@/lib/admin/growth';
import { assertDbConfigured, q } from './harness';

const NOW = new Date('2031-03-15T12:00:00Z');
let a: string;
let b: string;
let c: string;

async function seedUser(createdAt: string): Promise<string> {
  const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const [u] = await q<{ id: string }>(sql`
    INSERT INTO users (email, created_at) VALUES (${`growth-${tag}@example.test`}, ${createdAt}::timestamptz)
    RETURNING id`);
  return u.id;
}

beforeAll(async () => {
  assertDbConfigured();
  a = await seedUser('2031-03-10T08:00:00Z');
  b = await seedUser('2031-03-10T09:00:00Z');
  c = await seedUser('2031-03-15T23:59:59Z');
  // The next UTC day: not a signup "today", not in the series.
  await seedUser('2031-03-16T00:00:01Z');

  resetActiveDayCache();
  await recordActiveDay(a, 'web', { now: new Date('2031-03-14T10:00:00Z') });
  await recordActiveDay(a, 'web', { now: NOW });
  await recordActiveDay(b, 'mcp', { now: NOW });
  await recordActiveDay(c, 'web', { now: new Date('2031-02-20T10:00:00Z') });
  // Outside the 30-day window.
  await recordActiveDay(c, 'web', { now: new Date('2031-01-01T10:00:00Z') });
});

describe('recordActiveDay', () => {
  test('a second write for the same person and day is a no-op, even from another instance', async () => {
    resetActiveDayCache();
    await recordActiveDay(a, 'mcp', { now: new Date('2031-03-15T22:00:00Z') });
    const rows = await q<{ first_surface: string }>(sql`
      SELECT first_surface FROM user_active_days WHERE user_id = ${a}::uuid AND day = '2031-03-15'`);
    expect(rows).toEqual([{ first_surface: 'web' }]);
  });

  test('the day is the UTC day', async () => {
    resetActiveDayCache();
    await recordActiveDay(b, 'web', { now: new Date('2031-03-12T23:30:00-05:00') });
    const rows = await q<{ day: string }>(sql`
      SELECT day::text AS day FROM user_active_days WHERE user_id = ${b}::uuid ORDER BY day`);
    expect(rows.map(r => r.day)).toEqual(['2031-03-13', '2031-03-15']);
    await q(sql`DELETE FROM user_active_days WHERE user_id = ${b}::uuid AND day = '2031-03-13'`);
  });
});

describe('loadGrowth', () => {
  test('counts distinct people per window and surface', async () => {
    const g = await loadGrowth({ now: NOW });
    expect(g.asOf).toBe('2031-03-15');
    expect(g.dauToday).toBe(2);
    expect(g.wau).toBe(2);
    expect(g.mau).toBe(3);
    expect(g.bySurface).toEqual({ web: { dau: 1, mau: 2 }, mcp: { dau: 1, mau: 1 } });
    // 4 person-days in the last 30 days, averaged over 30, over 3 people.
    expect(g.dauMauRatio).toBe(Math.round((4 / 30 / 3) * 1000) / 1000);
    expect(g.newUsers7d).toBe(3);
    expect(g.totalUsers).toBeGreaterThanOrEqual(4);
    expect(g.activeSince).not.toBeNull();
  });

  test('the series is 90 UTC days ending today, with signups by created_at day', async () => {
    const g = await loadGrowth({ now: NOW });
    expect(g.days).toHaveLength(90);
    expect(g.days[0].day).toBe('2030-12-16');
    const byDay = new Map(g.days.map(d => [d.day, d]));
    expect(byDay.get('2031-03-15')).toEqual({ day: '2031-03-15', signups: 1, dau: 2, dauWeb: 1, dauMcp: 1 });
    expect(byDay.get('2031-03-14')).toMatchObject({ dau: 1, dauWeb: 1 });
    expect(byDay.get('2031-03-10')).toMatchObject({ signups: 2, dau: 0 });
    expect(byDay.get('2031-01-01')).toMatchObject({ dau: 1 });
    expect(byDay.has('2031-03-16')).toBe(false);
  });
});
