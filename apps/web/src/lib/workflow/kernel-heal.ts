/**
 * The fast heal for a kernel delivery whose merge or close was seen but not applied
 * (docs/specs/workflow-kernel-library.md §1, S4a). For a delivery-owned task the worker
 * columns move only in T17 / T18, so a merge the kernel did not apply (the webhook's live read
 * failed, a render recorded the fact unapplied, a dependency gate saw it from a page) must
 * reach the reducer in minutes, not on the hourly floor.
 *
 * A Redis due-queue (`buildd:due:kernel-heal`, lib/redis.ts) holds the delivery ids, scored by
 * when to look. The per-minute `/api/cron/dispatch-drain?gate=due` tick asks Redis whether any
 * are due (no Postgres touched when none are) and runs `reconcileKernelDeliveries` for exactly
 * those, with no quiet window: the same floor pass, narrowed to one delivery. A dropped ZADD
 * costs one floor interval, never the heal: the floor puts a delivery with an unapplied
 * terminal fact first (reconcile.ts `floorCandidatesSql`).
 */
import { sql } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { clearDue, countDue, listDue, markDue } from '@/lib/redis';
import type { Exec } from './kernel';
import type { FloorSummary } from './seam';

export const KERNEL_HEAL_QUEUE = 'kernel-heal';
/** Long enough for a transient GitHub failure to clear; short enough that "minutes" holds. */
export const KERNEL_HEAL_DELAY_MS = 60_000;
/** A delivery still owed a heal after a pass is looked at again after this. */
export const KERNEL_HEAL_RETRY_MS = 5 * 60_000;
/** After this long the hourly floor owns it (it orders unapplied terminal facts first). */
export const KERNEL_HEAL_GIVE_UP_MS = 60 * 60_000;
const BATCH = 10;

const dbExec: Exec = (q) => db.execute(q) as unknown as Promise<{ rows?: unknown[] }>;

/** Look at this delivery again in `delayMs`. Never throws: the floor is the backstop. */
export async function scheduleKernelHeal(deliveryId: string, delayMs = KERNEL_HEAL_DELAY_MS, now = Date.now()): Promise<void> {
  await markDue(KERNEL_HEAL_QUEUE, deliveryId, now + delayMs).catch((err) => console.error(`[workflow] kernel heal schedule for ${deliveryId} failed:`, err));
}

/** The kernel-owned delivery of a PR, by a plain SELECT (no release, no write): what a read may ask. */
export async function kernelDeliveryIdOfPr(p: { workspaceId: string; repoFullName: string; prNumber: number }, exec: Exec = dbExec): Promise<string | null> {
  const r = ((await exec(sql`-- workflow:kernel_delivery_of_pr
SELECT d.id FROM workflow_deliveries d
WHERE d.workspace_id = ${p.workspaceId}::uuid AND lower(d.repo_full_name) = lower(${p.repoFullName}::text) AND d.pr_number = ${p.prNumber}::int
  AND d.authority = 'kernel'
LIMIT 1`)).rows ?? [])[0] as { id?: string } | undefined;
  return r?.id ? String(r.id) : null;
}

/** Deliveries among `ids` that still hold a merge or close fact the reducer never applied, recent enough to retry. */
export async function stillOwedHeal(ids: string[], exec: Exec = dbExec, now = Date.now()): Promise<string[]> {
  if (ids.length === 0) return [];
  const since = new Date(now - KERNEL_HEAL_GIVE_UP_MS).toISOString();
  const rows = ((await exec(sql`-- workflow:still_owed_heal
SELECT d.id FROM workflow_deliveries d
WHERE d.id IN (SELECT x::uuid FROM jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb) x)
  AND d.authority = 'kernel' AND d.state NOT IN ('MERGED', 'SUPERSEDED', 'ABANDONED')
  AND EXISTS (SELECT 1 FROM workflow_facts f
    WHERE f.workspace_id = d.workspace_id AND f.repo_full_name = d.repo_full_name AND f.pr_number = d.pr_number
      AND f.kind = 'pr_closed' AND f.applied_transition_id IS NULL
      AND f.observed_at > COALESCE(d.last_transition_at, d.created_at) AND f.observed_at >= ${since}::timestamptz)`)).rows ?? []) as Array<{ id: unknown }>;
  return rows.map((r) => String(r.id));
}

export interface KernelHealDeps {
  reconcile?: (only: string[]) => Promise<FloorSummary>;
  exec?: Exec;
  now?: () => number;
}

export interface KernelHealResult { due: number; healed: FloorSummary | null; rescheduled: number }

/**
 * The gated tick: take what is due, reconcile exactly those deliveries now, and look again
 * later at any that still owe a heal (a GitHub read that failed again). `null` when Redis
 * could not answer: nothing is taken and the floor covers it.
 */
export async function runDueKernelHeals(deps: KernelHealDeps = {}): Promise<KernelHealResult | null> {
  const now = deps.now?.() ?? Date.now();
  const count = await countDue(KERNEL_HEAL_QUEUE, now);
  if (count === null) return null;
  if (count === 0) return { due: 0, healed: null, rescheduled: 0 };
  const ids = await listDue(KERNEL_HEAL_QUEUE, now, BATCH);
  if (ids.length === 0) return { due: 0, healed: null, rescheduled: 0 };
  const reconcile = deps.reconcile ?? (async (only: string[]) => {
    const { reconcileKernelDeliveries } = await import('./seam');
    return reconcileKernelDeliveries({}, { only, minQuietMs: 0, limit: only.length });
  });
  const healed = await reconcile(ids);
  await clearDue(KERNEL_HEAL_QUEUE, ids);
  const again = await stillOwedHeal(ids, deps.exec ?? dbExec, now).catch(() => [] as string[]);
  for (const id of again) await scheduleKernelHeal(id, KERNEL_HEAL_RETRY_MS, now);
  return { due: ids.length, healed, rescheduled: again.length };
}
