/**
 * The recheck queue for trunk incidents (workflow-kernel-library.md §3, T26): an incident whose base
 * went green is resolved within a minute or two, not at the next hourly floor.
 *
 * A Redis due-queue (`buildd:due:trunk-incidents`, lib/redis.ts) holds unresolved incident ids,
 * scored by when each is next rechecked. Opening or joining an incident queues it at the fallback
 * (`TRUNK_RECHECK_FALLBACK_MS`); a completed check suite on a branch with unresolved incidents makes
 * them due now (`requestTrunkRecheckForBranch`, from the GitHub webhook). The control plane's
 * per-minute tick reads the queue and rechecks only the due incidents, each read of the base the
 * floor's own (seam `recheckTrunkIncidents`); one left unresolved is queued again at the fallback.
 * An idle tick reads Redis only. The hourly floor still sweeps every incident and re-queues the ones
 * it leaves unresolved, so a lost write costs at most one fallback period, a lost queue one floor.
 *
 * Order matters for a suite finishing mid-recheck: the tick clears a member before it reads the base,
 * and re-queues it earliest-wins after. A suite that completed before the clear is in that read; one
 * after it marks the member due now, which the re-queue cannot push back.
 */
import { sql, type SQL } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { clearDue, countDue, listDue, markDueEarliest } from '@/lib/redis';
import type { Exec } from './kernel';

export const TRUNK_RECHECK_QUEUE = 'trunk-incidents';
/** An unresolved incident is rechecked at least this often while it is on the queue. */
export const TRUNK_RECHECK_FALLBACK_MS = 5 * 60_000;
/** Incidents one tick rechecks at most: each costs a base-head and a check-runs read. */
export const TRUNK_RECHECK_BATCH = 10;
/** Unresolved incidents one branch's completed suite makes due at most. */
const BRANCH_INCIDENTS_CAP = 50;

const dbExec: Exec = (q) => db.execute(q) as unknown as Promise<{ rows?: unknown[] }>;

/** Queue an incident's recheck for `at` (default: one fallback from now); earliest wins. Never throws. */
export async function scheduleTrunkRecheck(incidentId: string, at: number = Date.now() + TRUNK_RECHECK_FALLBACK_MS): Promise<void> {
  try {
    await markDueEarliest(TRUNK_RECHECK_QUEUE, incidentId, at);
  } catch (err) {
    console.error(`[workflow] trunk recheck schedule for ${incidentId} failed:`, err);
  }
}

/** Unresolved incidents on one repo's branch, in any workspace: what a completed check suite there may resolve. */
export function unresolvedIncidentsOnBranchSql(repoFullName: string, branch: string): SQL {
  return sql`-- workflow:trunk_unresolved_on_branch
SELECT id FROM trunk_incidents
WHERE repo_full_name = ${repoFullName}::text AND base_ref = ${branch}::text AND status <> 'resolved'
LIMIT ${BRANCH_INCIDENTS_CAP}::int`;
}

/**
 * A check suite completed on `branch`: every unresolved incident on that base is due now, for the next
 * tick to read the base. It only marks the queue (no GitHub read, no kernel command), so any host may
 * call it. Returns how many were queued; never throws, since the fallback and the floor back it.
 */
export async function requestTrunkRecheckForBranch(p: { repoFullName: string; branch: string }, o: { exec?: Exec; now?: number } = {}): Promise<number> {
  try {
    const rows = ((await (o.exec ?? dbExec)(unresolvedIncidentsOnBranchSql(p.repoFullName, p.branch))).rows ?? []) as Array<{ id: string }>;
    const now = o.now ?? Date.now();
    for (const r of rows) await scheduleTrunkRecheck(String(r.id), now);
    return rows.length;
  } catch (err) {
    console.error(`[workflow] trunk recheck request for ${p.repoFullName}@${p.branch} failed:`, err);
    return 0;
  }
}

export interface TrunkRecheckOutcome {
  /** Incidents still unresolved after the recheck: they go back on the queue at the fallback. */
  unresolved: string[];
}

export interface TrunkRecheckTickDeps {
  /** Rechecks the named incidents where the kernel is hosted (seam `recheckTrunkIncidents`). */
  recheck: (incidentIds: string[]) => Promise<TrunkRecheckOutcome>;
  now?: () => number;
  batch?: number;
}

export interface TrunkRecheckTickResult { due: number; rechecked: number; requeued: number; failed: number }

/** The tick: recheck the incidents that came due. Null when Redis could not answer. */
export async function runDueTrunkRechecks(deps: TrunkRecheckTickDeps): Promise<TrunkRecheckTickResult | null> {
  const now = deps.now?.() ?? Date.now();
  const out: TrunkRecheckTickResult = { due: 0, rechecked: 0, requeued: 0, failed: 0 };
  const count = await countDue(TRUNK_RECHECK_QUEUE, now);
  if (count === null) return null;
  if (count === 0) return out;
  const ids = await listDue(TRUNK_RECHECK_QUEUE, now, deps.batch ?? TRUNK_RECHECK_BATCH);
  out.due = ids.length;
  if (ids.length === 0) return out;
  // Claimed before the read (see the header): a suite completing during it re-marks the member now.
  await clearDue(TRUNK_RECHECK_QUEUE, ids);
  try {
    const r = await deps.recheck(ids);
    out.rechecked = ids.length;
    for (const id of r.unresolved) await scheduleTrunkRecheck(id, now + TRUNK_RECHECK_FALLBACK_MS);
    out.requeued = r.unresolved.length;
  } catch (err) {
    out.failed = ids.length;
    console.error('[workflow] trunk recheck tick failed:', err);
    for (const id of ids) await scheduleTrunkRecheck(id, now + TRUNK_RECHECK_FALLBACK_MS);
  }
  return out;
}
