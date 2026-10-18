/**
 * Lost claim responses: worker rows the claim route minted for a runner that
 * never received them.
 *
 * The handoff has two sides. CLAIMED is the claim route's INSERT (status
 * 'idle', started_at NULL, `runner` = the claiming runner's localUiUrl).
 * SESSION_STARTED is the runner's first `running` PATCH, which stamps
 * started_at. Between the two the only party that knows the worker exists is
 * whoever read the claim response, and when the runner's request times out
 * (BuilddClient aborts at 30s) or the connection drops after the server
 * commits, nobody did: the row sits idle until the 5-minute reap books it
 * `never_started`, and the task then waits out the infra backoff on top.
 * Observed on a host runner on 2026-10-10: two claim polls timed out right after
 * a self-update restart, and the worker one of them minted was reaped exactly
 * five minutes later.
 *
 * The runner's 60s liveness heartbeat is the acknowledgement. A runner that
 * reports `claimHandoff` lists every worker it holds, including ones it has
 * received but not yet started, and says whether a claim request is still in
 * flight. A row minted for that runner longer than CLAIM_ACK_GRACE_MS ago,
 * still unstarted, absent from the list, with no claim in flight, was lost:
 * release it now under its own error text and resolve the task by the same
 * rules the reaper uses (infra backoff, MAX_INFRA_RETRIES, kernel hook).
 *
 * The release is a compare-and-swap on `status = 'idle' AND started_at IS
 * NULL`: a runner whose `running` PATCH lands first keeps its worker, so a late
 * acknowledgement can never race a release into two sessions.
 *
 * The same report also keeps the rows it lists alive. A runner starts the
 * workers of one claim one after another (fetch, worktree, provisioning), so
 * the last of a large batch can wait more than five minutes for its
 * `running` PATCH. The idle and never-started reap rules judge by `updated_at`,
 * and before this they failed such a worker while the runner was listing it as
 * held on every heartbeat. A listed
 * row's `updated_at` now advances on each heartbeat, for at most
 * CLAIM_ACK_MAX_HOLD_MS after minting, so a start that never finishes is still
 * reaped.
 *
 * A released row's task goes back to pending without charging the infra retry
 * budget (resolveTasksOfReapedWorkers, `undelivered`): nothing ran, so a run of
 * lost responses says nothing about the task and must never stall it.
 */
import { db } from '@buildd/core/db';
import { workers } from '@buildd/core/db/schema';
import { and, eq, gt, inArray, isNull, lt, notInArray, sql } from 'drizzle-orm';
import { CLAIM_RESPONSE_LOST_ERROR } from '@/lib/worker-exit-taxonomy';
import { releaseConcurrencySeats } from '@/lib/interactive-detach';
import { resolveTasksOfReapedWorkers } from '@/lib/stale-workers';
import { sqlWhere } from '@buildd/core/db/relational-sql';

/**
 * How old an unstarted row must be before a heartbeat may release it. Above
 * the runner's 90s claim timeout (CLAIM_TIMEOUT_MS in apps/runner/src/buildd.ts,
 * raised from 30s), so a response still on the wire is never mistaken for a
 * lost one even if `claimInFlight` was misreported.
 */
export const CLAIM_ACK_GRACE_MS = 120_000;

/**
 * How long after minting a runner's acknowledgement keeps an unstarted row
 * alive. A batch's serial start takes minutes, not this long; past it the row
 * is left to the never-started reap.
 */
export const CLAIM_ACK_MAX_HOLD_MS = 30 * 60_000;

/** What a runner reports on its heartbeat about the claim → session handoff. */
export interface ClaimHandoffReport {
  /** Workers received in a claim response and not yet started (or started and live). */
  pendingStartIds: string[];
  /** A claim request is outstanding: its workers may exist server-side already. */
  claimInFlight: boolean;
}

/** Read `claimHandoff` off a heartbeat body. Null when absent or malformed (older runner). */
export function parseClaimHandoff(raw: unknown): ClaimHandoffReport | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.pendingStartIds) || typeof r.claimInFlight !== 'boolean') return null;
  return {
    pendingStartIds: r.pendingStartIds.filter((id): id is string => typeof id === 'string'),
    claimInFlight: r.claimInFlight,
  };
}

export interface LostClaimCandidate {
  id: string;
  taskId: string | null;
  accountId: string | null;
  createdAt: Date;
  prUrl: string | null;
  prNumber: number | null;
  commitCount: number | null;
  branch: string | null;
  error: string | null;
}

export interface LostClaimDeps {
  /** Unstarted idle rows this account minted for `runner` before `mintedBefore`, excluding `held`. */
  findCandidates(input: { accountId: string; runner: string; mintedBefore: Date; held: string[] }): Promise<LostClaimCandidate[]>;
  /** Advance `updated_at` on `ids` still idle and unstarted, minted for `runner` after `mintedAfter`. */
  renewHeld(input: { accountId: string; runner: string; ids: string[]; mintedAfter: Date; now: Date }): Promise<number>;
  /** CAS: fail the rows still idle and unstarted; returns the ids actually released. */
  release(ids: string[], now: Date): Promise<string[]>;
  releaseSeats(accountIds: Array<string | null>): Promise<unknown>;
  resolveTasks(released: LostClaimCandidate[]): Promise<void>;
  log(line: string): void;
}

const defaultDeps: LostClaimDeps = {
  async findCandidates({ accountId, runner, mintedBefore, held }) {
    return db.query.workers.findMany({
      where: sqlWhere(and(
        eq(workers.accountId, accountId),
        eq(workers.runner, runner),
        eq(workers.status, 'idle'),
        isNull(workers.startedAt),
        lt(workers.createdAt, mintedBefore),
        ...(held.length > 0 ? [notInArray(workers.id, held)] : []),
      )),
      columns: {
        id: true, taskId: true, accountId: true, createdAt: true,
        prUrl: true, prNumber: true, commitCount: true, branch: true, error: true,
      },
      limit: 50,
    });
  },
  async renewHeld({ accountId, runner, ids, mintedAfter, now }) {
    if (ids.length === 0) return 0;
    const rows = await db
      .update(workers)
      .set({ updatedAt: now })
      .where(and(
        inArray(workers.id, ids),
        eq(workers.accountId, accountId),
        eq(workers.runner, runner),
        eq(workers.status, 'idle'),
        isNull(workers.startedAt),
        gt(workers.createdAt, mintedAfter),
      ))
      .returning({ id: workers.id });
    return rows.length;
  },
  async release(ids, now) {
    if (ids.length === 0) return [];
    const rows = await db
      .update(workers)
      .set({
        status: 'failed',
        exitCause: 'never_started',
        error: CLAIM_RESPONSE_LOST_ERROR,
        completedAt: now,
        updatedAt: now,
      })
      .where(and(
        inArray(workers.id, ids),
        eq(workers.status, 'idle'),
        sql`${workers.startedAt} IS NULL`,
      ))
      .returning({ id: workers.id });
    return rows.map(r => r.id);
  },
  releaseSeats: releaseConcurrencySeats,
  resolveTasks: released => resolveTasksOfReapedWorkers(released, 'never_started', { undelivered: true }),
  log: line => console.warn(line),
};

/**
 * Release the workers `runner` was handed but says it does not hold. Returns
 * the number released. Does nothing while a claim is in flight.
 */
export async function releaseUnacknowledgedClaims(
  input: { accountId: string; runner: string; report: ClaimHandoffReport; heldWorkerIds?: string[]; now?: Date },
  deps: LostClaimDeps = defaultDeps,
): Promise<number> {
  const { accountId, runner, report } = input;
  const now = input.now ?? new Date();
  const held = [...new Set([...report.pendingStartIds, ...(input.heldWorkerIds ?? [])])];
  // Held is held whether or not another claim is in flight.
  await deps.renewHeld({ accountId, runner, ids: held, mintedAfter: new Date(now.getTime() - CLAIM_ACK_MAX_HOLD_MS), now });
  if (report.claimInFlight) return 0;
  const candidates = await deps.findCandidates({
    accountId,
    runner,
    mintedBefore: new Date(now.getTime() - CLAIM_ACK_GRACE_MS),
    held,
  });
  if (candidates.length === 0) return 0;

  const releasedIds = new Set(await deps.release(candidates.map(c => c.id), now));
  const released = candidates.filter(c => releasedIds.has(c.id));
  if (released.length === 0) return 0;

  for (const w of released) {
    // One structured line per transition: the CLAIMED → (no SESSION_STARTED)
    // → RELEASED edge, with what is needed to correlate it to the runner's
    // claims.log (`claim_rejected` with status 0 at about mintedAt).
    deps.log(`[claim-handoff] ${JSON.stringify({
      event: 'claim_unacknowledged_released',
      workerId: w.id,
      taskId: w.taskId,
      accountId: w.accountId,
      runner,
      mintedAt: w.createdAt.toISOString(),
      ageMs: now.getTime() - w.createdAt.getTime(),
    })}`);
  }
  await deps.releaseSeats(released.map(w => w.accountId));
  await deps.resolveTasks(released);
  return released.length;
}
