/**
 * The PR landing marker — `tasks.context.landing`.
 *
 * It names the head SHA whose green lands a PR after the platform pushed to the
 * branch, so a refused "behind base" is a wait with an owner instead of a
 * refusal nobody follows up (docs/design/pr-landing-guarantee.md §C). Stored on
 * the PR's owning worker task, next to the keys conflict/CI retry keep there,
 * so no schema change: one live value per PR.
 *
 * No `db.transaction()` (neon-http): writes are a single atomic UPDATE, and a
 * caller that read `refreshCount` passes it back as a compare-and-set so two
 * concurrent landings cannot both claim the same refresh slot.
 */

import { db } from '@buildd/core/db';
import { tasks } from '@buildd/core/db/schema';
import { eq, and, sql } from 'drizzle-orm';

export interface LandingMarker {
  prNumber: number;
  /** The SHA whose green lands this PR. */
  pendingHeadSha: string;
  /** Base tip the last update merged in. */
  baseShaAtUpdate: string | null;
  /** Refreshes in this landing cycle; bounded by the treadmill rule. */
  refreshCount: number;
  /** Start of the landing clock (ISO). Kept across refreshes. */
  firstApprovedGreenAt: string | null;
  lastOutcome: string;
  /** Alert dedupe keys (owned by the alerting layer; preserved on every write here). */
  pagedKeys?: string[];
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** The marker for `prNumber` out of a task context, or null (absent, malformed, or for another PR). */
export function parseLandingMarker(context: unknown, prNumber: number): LandingMarker | null {
  if (!isObj(context) || !isObj(context.landing)) return null;
  const raw = context.landing;
  if (raw.prNumber !== prNumber) return null;
  if (typeof raw.pendingHeadSha !== 'string' || !raw.pendingHeadSha) return null;
  return {
    prNumber,
    pendingHeadSha: raw.pendingHeadSha,
    baseShaAtUpdate: typeof raw.baseShaAtUpdate === 'string' ? raw.baseShaAtUpdate : null,
    refreshCount: typeof raw.refreshCount === 'number' && raw.refreshCount >= 0 ? raw.refreshCount : 0,
    firstApprovedGreenAt: typeof raw.firstApprovedGreenAt === 'string' ? raw.firstApprovedGreenAt : null,
    lastOutcome: typeof raw.lastOutcome === 'string' ? raw.lastOutcome : 'updating_branch',
    pagedKeys: Array.isArray(raw.pagedKeys) ? raw.pagedKeys.filter((k): k is string => typeof k === 'string') : undefined,
  };
}

export async function readLandingMarker(taskId: string, prNumber: number): Promise<LandingMarker | null> {
  const task = await db.query.tasks.findFirst({
    where: eq(tasks.id, taskId),
    columns: { context: true },
  });
  return parseLandingMarker(task?.context, prNumber);
}

/**
 * Write the marker. `expectedRefreshCount` is the `refreshCount` the caller
 * read (0 when it read no marker): the write only lands if the stored count
 * still equals it, and returns false when another landing got there first.
 * `pagedKeys` is never overwritten — the `||` merge keeps the stored list.
 */
export async function writeLandingMarker(
  taskId: string,
  marker: Omit<LandingMarker, 'pagedKeys'>,
  expectedRefreshCount: number,
): Promise<boolean> {
  const json = JSON.stringify(marker);
  const rows = await db
    .update(tasks)
    .set({
      context: sql`jsonb_set(COALESCE(${tasks.context}, '{}'::jsonb), '{landing}', COALESCE(${tasks.context}->'landing', '{}'::jsonb) || ${json}::jsonb, true)`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(tasks.id, taskId),
        sql`COALESCE((${tasks.context}->'landing'->>'refreshCount')::int, 0) = ${expectedRefreshCount}`,
      ),
    )
    .returning({ id: tasks.id });
  return rows.length > 0;
}

/** Drop the marker once the PR has merged (the landing cycle is over). */
export async function clearLandingMarker(taskId: string): Promise<void> {
  await db
    .update(tasks)
    .set({
      context: sql`COALESCE(${tasks.context}, '{}'::jsonb) - 'landing'`,
      updatedAt: new Date(),
    })
    .where(eq(tasks.id, taskId));
}
