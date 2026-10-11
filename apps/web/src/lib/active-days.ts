import { db } from '@buildd/core/db';
import { sql } from 'drizzle-orm';
import { after } from 'next/server';
import { isUuid } from '@/lib/uuid';

/**
 * Which UTC days each person used buildd: one user_active_days row per person
 * per day, written the first time they are seen that day on the dashboard
 * (auth.ts jwt callback) or over MCP with an OAuth session. API keys and task
 * tokens are not people and never reach here. Read by the platform-owner
 * admin API (lib/admin/growth.ts).
 */

export type ActiveSurface = 'web' | 'mcp';

/** UTC calendar day, YYYY-MM-DD. */
export function utcDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

// userId -> last UTC day this instance recorded. A duplicate insert from
// another instance is harmless (ON CONFLICT DO NOTHING); this only keeps an
// active person from costing a write per request.
const recorded = new Map<string, string>();
const RECORDED_CAP = 10_000;

/** For tests. */
export function resetActiveDayCache(): void {
  recorded.clear();
}

type Exec = (query: ReturnType<typeof sql>) => Promise<unknown>;
const defaultExec: Exec = (query) => db.execute(query);

/**
 * Note that `userId` was active today. At most one write per person per day
 * per instance. Never throws: activity tracking must not break sign-in or an
 * MCP call.
 */
export async function recordActiveDay(
  userId: string | null | undefined,
  surface: ActiveSurface,
  opts: { now?: Date; exec?: Exec } = {},
): Promise<boolean> {
  if (!isUuid(userId)) return false;
  const day = utcDay(opts.now);
  if (recorded.get(userId) === day) return false;
  if (recorded.size >= RECORDED_CAP) recorded.clear();
  recorded.set(userId, day);
  try {
    await (opts.exec ?? defaultExec)(sql`
      INSERT INTO user_active_days (user_id, day, first_surface)
      VALUES (${userId}::uuid, ${day}::date, ${surface})
      ON CONFLICT (user_id, day) DO NOTHING`);
    return true;
  } catch (err) {
    // Let the next request retry rather than losing the day.
    recorded.delete(userId);
    console.warn('[growth] recording an active day failed:', err instanceof Error ? err.message : err);
    return false;
  }
}

/** recordActiveDay after the response is sent; immediately outside a request scope. */
export function scheduleActiveDay(userId: string | null | undefined, surface: ActiveSurface): void {
  if (!isUuid(userId)) return;
  const run = () => { void recordActiveDay(userId, surface); };
  try {
    after(run);
  } catch {
    run();
  }
}

