/**
 * Runner-health detector — pages (critical) when tasks start failing
 * systematically, so an "all tasks failing on the runner" outage is caught
 * immediately instead of discovered a day later (cf. the diagnostic that found
 * every task failing well after the fact).
 *
 * Tracks a consecutive-failure streak in `system_cache` (atomic jsonb counter,
 * survives stateless serverless invocations). A completed task resets the
 * streak; the Nth consecutive failure fires ONE critical ops alert — reportOps
 * dedups the rest within its window via a fixed dedupeKey, so a sustained outage
 * pages once, not once per failed task.
 *
 * Best-effort: never throws, never blocks the caller. Call alongside
 * recordTaskOutcome on the terminal (non-retry) completion path.
 *
 * Gated by OPS_ALERTS_ENABLED (same flag as reportOps): when ops alerting is
 * dark, the detector can never page, so it does no DB work at all.
 *
 * Env:
 *   OPS_ALERTS_ENABLED             — must be truthy, else this is a no-op
 *   RUNNER_HEALTH_FAILURE_THRESHOLD — consecutive failures before paging (default 3)
 */

import { sql } from 'drizzle-orm';
import { db } from './db';
import { systemCache } from './db/schema';
import { reportOps } from './report-ops';

const STREAK_KEY = 'runner-health:consecutive-failures';
const DEFAULT_THRESHOLD = 3;

function opsEnabled(): boolean {
  const v = process.env.OPS_ALERTS_ENABLED;
  return v === '1' || v === 'true' || v === 'yes';
}

function failureThreshold(): number {
  const n = Number(process.env.RUNNER_HEALTH_FAILURE_THRESHOLD);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_THRESHOLD;
}

/**
 * Record a terminal task outcome for systemic-failure detection.
 * - `completed` → reset the streak to 0.
 * - `failed`    → atomically bump the streak; page critical once it hits the
 *                 threshold.
 */
export async function recordRunnerOutcome(outcome: 'completed' | 'failed'): Promise<void> {
  try {
    if (!opsEnabled()) return;
    const now = new Date();

    if (outcome === 'completed') {
      await db
        .insert(systemCache)
        .values({ key: STREAK_KEY, value: { count: 0 }, updatedAt: now })
        .onConflictDoUpdate({
          target: systemCache.key,
          set: { value: { count: 0 }, updatedAt: now },
        });
      return;
    }

    // Failure: atomically increment the counter and read back the new value, so
    // concurrent completions can't lose an increment.
    const [row] = await db
      .insert(systemCache)
      .values({ key: STREAK_KEY, value: { count: 1 }, updatedAt: now })
      .onConflictDoUpdate({
        target: systemCache.key,
        set: {
          value: sql`jsonb_set(${systemCache.value}, '{count}', (COALESCE((${systemCache.value}->>'count')::int, 0) + 1)::text::jsonb)`,
          updatedAt: now,
        },
      })
      .returning({ value: systemCache.value });

    const count = Number((row?.value as { count?: number } | undefined)?.count ?? 1);
    if (count >= failureThreshold()) {
      // Fixed dedupeKey → one page per reportOps window for a sustained outage.
      await reportOps({
        source: 'runner-health',
        severity: 'critical',
        message: `${count} consecutive task failures`,
        detail: 'Tasks are failing systematically on the runner — check the runner logs / claim path.',
        dedupeKey: 'runner-health',
      });
    }
  } catch {
    // Never let health tracking break the completion path.
  }
}
