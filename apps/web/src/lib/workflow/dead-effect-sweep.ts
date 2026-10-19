/**
 * The floor's sweep of dead effects (docs/specs/workflow-kernel-library.md §3). An effect goes `dead`
 * after its retries are spent; nothing drains it again, so a dead row outlives the delivery it was for.
 *
 * - On a finished delivery (merged, superseded, abandoned, failed), or for a head that is no longer
 *   the delivery's current one, the effect is moot: closed as `done` with outcome `superseded: <reason>`.
 *   `last_error` stays, so the failure is still on the row.
 * - On a live delivery with a current head it stays `dead`, and is reported: the floor's span carries
 *   the count and the oldest age, and the Health kernel view lists the rows. Dead is never resolved silently.
 */
import { sql } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import type { Exec } from './kernel';

const dbExec: Exec = (q) => db.execute(q) as unknown as Promise<{ rows?: unknown[] }>;
const rows = (r: { rows?: unknown[] }) => (r.rows ?? []) as Array<Record<string, unknown>>;

export const DEAD_EFFECT_LIST_LIMIT = 50;

export interface DeadEffectsSummary {
  /** Dead effects closed as superseded this pass. */
  closed: number;
  /** Dead effects still dead after it: owed to a live delivery. */
  live: number;
  oldestAgeS: number;
  byKind: Record<string, number>;
}

export interface LiveDeadEffect {
  id: string;
  kind: string;
  deliveryId: string | null;
  deliveryState: string | null;
  repo: string | null;
  prNumber: number | null;
  attempts: number;
  lastError: string | null;
  deadAt: string;
}

export interface LiveDeadEffects { total: number; rows: LiveDeadEffect[] }

/** Closes the moot dead effects; reports the rest. */
export async function sweepDeadEffects(exec: Exec = dbExec): Promise<DeadEffectsSummary> {
  const closed = rows(await exec(sql`-- workflow:supersede_dead_effects
UPDATE workflow_effects e
SET status = 'done', lease_until = NULL, updated_at = now(),
    outcome = CASE WHEN d.state IN ('MERGED', 'SUPERSEDED', 'ABANDONED', 'FAILED')
      THEN 'superseded: delivery ' || lower(d.state) ELSE 'superseded: head no longer current' END
FROM workflow_deliveries d
WHERE e.status = 'dead' AND e.delivery_id = d.id
  AND (d.state IN ('MERGED', 'SUPERSEDED', 'ABANDONED', 'FAILED')
    OR (e.payload->>'headSha' IS NOT NULL AND d.current_head_sha IS NOT NULL AND e.payload->>'headSha' <> d.current_head_sha))
RETURNING e.id`)).length;
  const remaining = rows(await exec(sql`-- workflow:dead_effects_summary
SELECT kind, count(*)::int AS n, COALESCE(EXTRACT(EPOCH FROM now() - min(updated_at)), 0)::float8 AS oldest_s
FROM workflow_effects WHERE status = 'dead' GROUP BY kind`));
  const byKind: Record<string, number> = {};
  let live = 0;
  let oldestAgeS = 0;
  for (const r of remaining) {
    byKind[String(r.kind)] = Number(r.n);
    live += Number(r.n);
    oldestAgeS = Math.max(oldestAgeS, Number(r.oldest_s));
  }
  return { closed, live, oldestAgeS: Math.round(oldestAgeS), byKind };
}

/** The dead effects still owed, oldest first, for the Health kernel view. */
export async function liveDeadEffects(exec: Exec = dbExec): Promise<LiveDeadEffects> {
  const [total, list] = await Promise.all([
    exec(sql`-- kernel_operator:dead_effects_count
SELECT count(*)::int AS n FROM workflow_effects WHERE status = 'dead'`),
    exec(sql`-- kernel_operator:dead_effects
SELECT e.id, e.kind, e.delivery_id, e.attempt_count, e.last_error, e.updated_at, d.state, d.repo_full_name, d.pr_number
FROM workflow_effects e LEFT JOIN workflow_deliveries d ON d.id = e.delivery_id
WHERE e.status = 'dead' ORDER BY e.updated_at LIMIT ${DEAD_EFFECT_LIST_LIMIT}`),
  ]);
  return {
    total: Number(rows(total)[0]?.n ?? 0),
    rows: rows(list).map((r) => ({
      id: String(r.id), kind: String(r.kind), deliveryId: r.delivery_id == null ? null : String(r.delivery_id),
      deliveryState: r.state == null ? null : String(r.state), repo: r.repo_full_name == null ? null : String(r.repo_full_name),
      prNumber: r.pr_number == null ? null : Number(r.pr_number), attempts: Number(r.attempt_count),
      lastError: r.last_error == null ? null : String(r.last_error).slice(0, 200), deadAt: new Date(String(r.updated_at)).toISOString(),
    })),
  };
}
