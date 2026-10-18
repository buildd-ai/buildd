/**
 * The schedules cron tick against its budget (Living Spec "Fast at any size",
 * R-25): a scheduled job reads only what is due or changed, or a bounded
 * batch, and no single run reads more than 5 MB from the database.
 *
 * Seeded: the large synthetic team (budget-harness.ts) plus a few thousand
 * schedules with realistic templates. Most are not due; some are due, some
 * are mission heartbeats, and some heartbeats are long overdue (the overdue
 * check reads those). One tick of GET /api/cron/schedules is measured, every
 * outside call refused.
 */
import { describe, it, expect, beforeAll, mock } from 'bun:test';
import { sql } from 'drizzle-orm';
import { assertDbConfigured, q } from './harness';
import { measureLoader, reportBudget, seedLargeTeam, seedScale, type SeededTeam } from './budget-harness';

assertDbConfigured();

/**
 * R-25: 5 MB per run. The query count is reported, and bounded loosely: the
 * tick fires at most its 50-schedule cap, and each fired mission heartbeat
 * runs the prepass, the completion gate and the planning context.
 */
const SCHEDULES_TICK_BUDGET = { queries: 1200, bytes: 5 * 1024 * 1024 };

const notified: string[] = [];
mock.module('../../src/lib/pushover', () => ({
  notifyOperator: (o: { title: string }) => { notified.push(o.title); },
  sendPushover: async () => false,
}));
const nextServer = await import('next/server');
mock.module('next/server', () => ({ ...nextServer, after: (_fn: () => unknown) => {} }));

process.env.CRON_SECRET = 'budget-cron-secret';
const { GET } = await import('../../src/app/api/cron/schedules/route');

const SCHEDULES = Number(process.env.BUDGET_SEED_SCHEDULES ?? 3000);
const PREFIX = 'budget-sched-';

let team: SeededTeam;
// A team of its own (one mission more than the shared one, so its own seed
// slug): a tick fires heartbeats on the team's missions, files tasks and may
// complete missions, and the page budget files share the default team.
const base = seedScale();
const scale = { ...base, missions: base.missions + 1 };

/** (Re)seed this file's schedules: same shape every run, so a re-run measures the same tick. */
async function seedSchedules(t: SeededTeam): Promise<void> {
  await q(sql`UPDATE missions SET schedule_id = NULL WHERE schedule_id IN (SELECT id FROM task_schedules WHERE name LIKE ${PREFIX + '%'})`);
  await q(sql`DELETE FROM task_schedules WHERE name LIKE ${PREFIX + '%'}`);
  const ws = `{${t.workspaceIds.join(',')}}`;
  // g % 100: 0-3 due plain, 4-5 due heartbeat (mission-linked), 6-8 heartbeat
  // overdue by days, the rest not due for an hour.
  await q(sql`
    INSERT INTO task_schedules (workspace_id, name, cron_expression, timezone, task_template, enabled, next_run_at, max_concurrent_from_schedule)
    SELECT (${ws}::uuid[])[1 + g % ${t.workspaceIds.length}], ${PREFIX} || g, '0 * * * *', 'UTC',
      jsonb_build_object(
        'title', 'Scheduled check ' || g,
        'description', repeat('What this scheduled run should look at and report. ', 40),
        'priority', 1,
        'context', jsonb_build_object(
          'heartbeat', (g % 100) BETWEEN 4 AND 8,
          'notes', repeat('Template context carried into every spawned task. ', 25))),
      true,
      -- Millisecond precision, as the app writes it: the claim compares nextRunAt exactly.
      date_trunc('milliseconds', CASE WHEN g % 100 < 6 THEN now() - interval '5 minutes'
           WHEN g % 100 < 9 THEN now() - interval '3 days'
           ELSE now() + interval '1 hour' END),
      1
    FROM generate_series(1, ${SCHEDULES}) g`);
  // Link the heartbeats to active missions of the team, one each, in a fixed
  // order so every fresh database measures the same tick.
  await q(sql`
    WITH s AS (
      SELECT id, row_number() OVER (ORDER BY name) AS rn FROM task_schedules
      WHERE name LIKE ${PREFIX + '%'} AND (task_template->'context'->>'heartbeat')::boolean
    ), m AS (
      SELECT id, row_number() OVER (ORDER BY title) AS rn FROM missions
      WHERE team_id = ${t.teamId}::uuid AND status = 'active' AND schedule_id IS NULL
    )
    UPDATE missions SET schedule_id = s.id FROM s JOIN m ON m.rn = s.rn WHERE missions.id = m.id`);
}

beforeAll(async () => {
  team = await seedLargeTeam(scale);
  await seedSchedules(team);
}, 900_000);

describe('Schedules cron tick budget', () => {
  it('fits R-25 at large scale: at most 5 MB read, overdue check in set queries', async () => {
    // Outside calls are refused (a tick must not depend on one to stay in budget) and listed.
    const outside: string[] = [];
    const realFetch = globalThis.fetch;
    const dbHost = new URL(process.env.NEON_LOCAL_FETCH_ENDPOINT!).host;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.host === dbHost) return realFetch(input, init);
      outside.push(url.host);
      throw new Error(`outside call during the tick: ${url.host}`);
    }) as typeof fetch;
    let status = 0;
    let body: Record<string, unknown> = {};
    try {
      const m = await measureLoader('cronSchedules', async () => {
        const res = await GET(new nextServer.NextRequest('http://localhost/api/cron/schedules', {
          headers: { authorization: 'Bearer budget-cron-secret' },
        }));
        status = res.status;
        body = await res.json();
      });
      reportBudget(m, SCHEDULES_TICK_BUDGET, scale);
      process.stdout.write(`[budget] cronSchedules body: ${JSON.stringify({ ...body, taskCategories: undefined })}\n`);
      expect(status).toBe(200);
      // The tick did its work: it processed its cap of due schedules and filed tasks.
      expect(body.processed).toBe(50);
      expect(Number(body.created)).toBeGreaterThan(0);
      expect(notified.some(t => t.startsWith('Check-in overdue'))).toBe(true);
      // Overdue check-ins: one read of the linked missions and one stamp for all, not one each.
      expect(m.queries.filter(x => /last_overdue_alert_at = /.test(x.head)).length).toBe(1);
      expect(m.queries.filter(x => /^select d0\.id as id from missions as d0 where d0\.schedule_id = \$1/.test(x.head)).length).toBe(0);
      if (outside.length) process.stdout.write(`[budget] cronSchedules refused outside calls: ${[...new Set(outside)].join(', ')}\n`);
      expect(m.bytes).toBeLessThanOrEqual(SCHEDULES_TICK_BUDGET.bytes);
      expect(m.count).toBeLessThanOrEqual(SCHEDULES_TICK_BUDGET.queries);
    } finally {
      globalThis.fetch = realFetch;
    }
  }, 300_000);
});
