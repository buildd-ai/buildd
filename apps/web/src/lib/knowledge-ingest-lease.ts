/**
 * Lease + reclaim for `knowledge_ingest_jobs`.
 *
 * Why this exists (two confirmed durability holes):
 *
 * C12 — the partial unique index `knowledge_ingest_jobs_active_full_idx` counts
 *   `running` as active, so a job whose executor died held the per-workspace
 *   full-ingest slot forever. There was no lease, no heartbeat, no attempt
 *   counter and nothing that reclaimed the row, while the enqueue route kept
 *   answering `already_queued` with a 200 — a success shape — indefinitely.
 *
 * C13 — a `diff` job is only ever executed by a fire-and-forget call in the
 *   GitHub webhook. If that background call is lost (function killed after the
 *   response), the row stays `queued`/`running` forever; the runner claim path
 *   filters `scope='full'` so nobody else picks it up, and the `!= 'error'`
 *   idempotency predicate blocks the redelivery that would recreate it.
 *
 * Shape: select candidates, decide in plain JS (`classifyIngestJobLiveness`),
 * then one atomic `UPDATE … WHERE id AND status AND attempts RETURNING` per row.
 * No `db.transaction()` — the neon-http driver has no interactive transactions,
 * and the CAS guard is what makes concurrent reclaimers safe (losers see zero
 * rows back and fall through), matching the claim path used elsewhere.
 *
 * Reclaim runs inline on live paths rather than from a cron: the runner claim
 * poll, the manual enqueue route, and the webhook enqueue path all call it. A
 * dedicated cron would be one more trigger that can silently never fire.
 */
import { db } from '@buildd/core/db';
import { knowledgeIngestJobs } from '@buildd/core/db/schema';
import { and, asc, eq, inArray } from 'drizzle-orm';

/** Lease TTL granted to a runner claiming a full job. Renewed by /files batches. */
export const FULL_LEASE_MS = 60 * 60 * 1000;
/** Lease TTL for the serverless diff executor — Vercel kills the function well inside this. */
export const DIFF_LEASE_MS = 15 * 60 * 1000;
/** Legacy (NULL-lease) `running` rows are judged stale this long after started_at. */
export const RUNNING_NO_LEASE_STALL_MS = 60 * 60 * 1000;
/**
 * A `queued` diff job this old was never started: the webhook's after() hook
 * either ran within seconds or was lost with the function.
 */
export const QUEUED_DIFF_STALL_MS = 15 * 60 * 1000;
/** A `queued` full job this old is wedged — no runner is offering its repo. */
export const QUEUED_FULL_STALL_MS = 60 * 60 * 1000;
/** Reclaim ceiling. Beyond this the job is parked in `error` instead of requeued. */
export const MAX_INGEST_ATTEMPTS = 3;
/** Upper bound on rows examined per reclaim pass. */
export const MAX_RECLAIM_SCAN = 200;

export type IngestJobLiveness = 'terminal' | 'live' | 'reclaimable' | 'exhausted' | 'stalled';

export interface IngestJobLivenessInput {
  status: 'queued' | 'running' | 'done' | 'error' | string;
  scope: 'diff' | 'full' | string;
  attempts?: number | null;
  leaseExpiresAt?: Date | string | null;
  heartbeatAt?: Date | string | null;
  startedAt?: Date | string | null;
  createdAt?: Date | string | null;
}

function ms(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  const t = d.getTime();
  return Number.isNaN(t) ? null : t;
}

/**
 * Decide what a job row is: still alive, recoverable, past saving, or wedged.
 * Pure — every reclaim decision is testable without a database.
 */
export function classifyIngestJobLiveness(
  job: IngestJobLivenessInput,
  now: Date = new Date(),
): IngestJobLiveness {
  if (job.status === 'done' || job.status === 'error') return 'terminal';
  const nowMs = now.getTime();
  const attempts = job.attempts ?? 0;
  const overCeiling = attempts >= MAX_INGEST_ATTEMPTS ? 'exhausted' : 'reclaimable';

  if (job.status === 'running') {
    const leaseMs = ms(job.leaseExpiresAt);
    if (leaseMs !== null) {
      return leaseMs > nowMs ? 'live' : overCeiling;
    }
    // Legacy row written before leases existed: never treat a NULL lease as
    // "leased forever", but don't reclaim it the instant it starts either.
    const startMs = ms(job.startedAt) ?? ms(job.createdAt);
    if (startMs === null) return 'live';
    return nowMs - startMs > RUNNING_NO_LEASE_STALL_MS ? overCeiling : 'live';
  }

  if (job.status === 'queued') {
    // Age from the last liveness transition, so a requeue resets the clock.
    const sinceMs = ms(job.heartbeatAt) ?? ms(job.createdAt);
    if (sinceMs === null) return 'live';
    const window = job.scope === 'diff' ? QUEUED_DIFF_STALL_MS : QUEUED_FULL_STALL_MS;
    return nowMs - sinceMs > window ? 'stalled' : 'live';
  }

  return 'live';
}

export function queuedAgeMs(job: IngestJobLivenessInput, now: Date = new Date()): number {
  const sinceMs = ms(job.heartbeatAt) ?? ms(job.createdAt);
  return sinceMs === null ? 0 : now.getTime() - sinceMs;
}

export interface ReclaimSummary {
  scanned: number;
  /** Ids requeued for another attempt. */
  requeued: string[];
  /** Ids parked in `error` (attempt ceiling, or an unrecoverable lost diff). */
  parked: string[];
  /** Ids whose loss triggered a full-scope recovery job. */
  escalated: string[];
  /** Queued jobs nothing will pick up — reported, not mutated. */
  stalled: Array<{ id: string; workspaceId: string; repo: string; scope: string; ageMs: number }>;
  /** CAS losses — another reclaimer/executor got there first. */
  raceLost: number;
}

type JobRow = typeof knowledgeIngestJobs.$inferSelect;

function emptySummary(): ReclaimSummary {
  return { scanned: 0, requeued: [], parked: [], escalated: [], stalled: [], raceLost: 0 };
}

/**
 * Requeue a wedged row. CAS on (id, status, attempts) so a concurrent reclaimer
 * or a late-arriving executor can't be clobbered.
 */
async function requeue(job: JobRow, now: Date): Promise<boolean> {
  const updated = await db
    .update(knowledgeIngestJobs)
    .set({
      status: 'queued',
      attempts: (job.attempts ?? 0) + 1,
      leaseOwner: null,
      leaseExpiresAt: null,
      startedAt: null,
      // Bump the heartbeat so the requeued row isn't instantly re-judged stalled.
      heartbeatAt: now,
    })
    .where(
      and(
        eq(knowledgeIngestJobs.id, job.id),
        eq(knowledgeIngestJobs.status, job.status),
        eq(knowledgeIngestJobs.attempts, job.attempts ?? 0),
      ),
    )
    .returning({ id: knowledgeIngestJobs.id });
  return updated.length > 0;
}

/** Park a row in `error` — terminal, and excluded by the idempotency predicate. */
async function park(job: JobRow, reason: string, now: Date): Promise<boolean> {
  const updated = await db
    .update(knowledgeIngestJobs)
    .set({
      status: 'error',
      error: reason,
      finishedAt: now,
      leaseOwner: null,
      leaseExpiresAt: null,
    })
    .where(
      and(
        eq(knowledgeIngestJobs.id, job.id),
        eq(knowledgeIngestJobs.status, job.status),
      ),
    )
    .returning({ id: knowledgeIngestJobs.id });
  return updated.length > 0;
}

/**
 * A lost `diff` job's own patch chunks can't be recovered, but the file contents
 * at that sha can: enqueue a full-scope job, which the existing runner claim
 * path already picks up. `onConflictDoNothing` leans on
 * `knowledge_ingest_jobs_active_full_idx`, so overlapping losses collapse into
 * one full run instead of stacking.
 */
async function enqueueFullRecovery(job: JobRow): Promise<boolean> {
  const inserted = await db
    .insert(knowledgeIngestJobs)
    .values({
      workspaceId: job.workspaceId,
      repo: job.repo,
      trigger: 'backfill',
      sha: job.sha,
      prNumber: job.prNumber,
      scope: 'full',
      status: 'queued',
    })
    .onConflictDoNothing()
    .returning({ id: knowledgeIngestJobs.id });
  return inserted.length > 0;
}

async function applyReclaim(
  job: JobRow,
  verdict: IngestJobLiveness,
  now: Date,
  out: ReclaimSummary,
): Promise<void> {
  if (verdict === 'reclaimable') {
    if (await requeue(job, now)) out.requeued.push(job.id);
    else out.raceLost++;
    return;
  }

  if (verdict === 'exhausted') {
    const reason =
      `ingest lease expired ${job.attempts ?? 0}x without completion ` +
      `(last owner: ${job.leaseOwner ?? 'none'}) — parked so a redelivery can re-enqueue`;
    if (await park(job, reason, now)) {
      out.parked.push(job.id);
      if (job.scope === 'diff' && (await enqueueFullRecovery(job))) out.escalated.push(job.id);
    } else {
      out.raceLost++;
    }
    return;
  }

  if (verdict === 'stalled') {
    if (job.scope === 'diff') {
      // Nothing else executes diff jobs, so a queued-too-long diff row is lost
      // for good: park it (unblocking the idempotency index) and escalate.
      const reason =
        'diff ingest job was never executed (webhook background run lost) — ' +
        'escalated to a full ingest; parked so a redelivery can re-enqueue';
      if (await park(job, reason, now)) {
        out.parked.push(job.id);
        if (await enqueueFullRecovery(job)) out.escalated.push(job.id);
      } else {
        out.raceLost++;
      }
      return;
    }
    // Full jobs are claimed by the runner fleet — a runner offering this repo may
    // still show up, so report the stall instead of destroying the job.
    out.stalled.push({
      id: job.id,
      workspaceId: job.workspaceId,
      repo: job.repo,
      scope: job.scope,
      ageMs: queuedAgeMs(job, now),
    });
  }
}

/**
 * Reclaim every wedged ingest job (optionally scoped to one workspace).
 * Never throws: a reclaim failure must not fail the caller's request.
 */
export async function reclaimStaleIngestJobs(opts?: {
  workspaceId?: string;
  now?: Date;
}): Promise<ReclaimSummary> {
  const now = opts?.now ?? new Date();
  const out = emptySummary();

  try {
    const where = opts?.workspaceId
      ? and(
          inArray(knowledgeIngestJobs.status, ['queued', 'running']),
          eq(knowledgeIngestJobs.workspaceId, opts.workspaceId),
        )
      : inArray(knowledgeIngestJobs.status, ['queued', 'running']);

    const candidates = (await db
      .select()
      .from(knowledgeIngestJobs)
      .where(where)
      .orderBy(asc(knowledgeIngestJobs.createdAt))
      .limit(MAX_RECLAIM_SCAN)) as JobRow[];

    out.scanned = candidates.length;

    for (const job of candidates) {
      const verdict = classifyIngestJobLiveness(job, now);
      if (verdict === 'live' || verdict === 'terminal') continue;
      await applyReclaim(job, verdict, now, out);
    }
  } catch (err) {
    console.error('[knowledge-ingest] reclaim pass failed (non-fatal):', err);
  }

  if (out.requeued.length || out.parked.length || out.escalated.length) {
    console.log(
      `[knowledge-ingest] reclaim: scanned=${out.scanned} requeued=${out.requeued.length} ` +
      `parked=${out.parked.length} escalated=${out.escalated.length} raceLost=${out.raceLost}`,
    );
  }
  return out;
}

/**
 * A duplicate `diff` enqueue hit the idempotency index. Decide whether the row
 * that blocked it is actually alive.
 *
 * Returns the existing job's id when it was wedged and has just been requeued —
 * the caller (the merged-PR webhook) then re-runs it, which is what makes a
 * GitHub redelivery of a lost job do something. Returns null when the blocking
 * row is genuinely in flight, or when it was past saving and got escalated.
 */
export async function recoverBlockedDiffJob(
  params: { workspaceId: string; repo: string; sha: string },
  now: Date = new Date(),
): Promise<string | null> {
  try {
    const rows = (await db
      .select()
      .from(knowledgeIngestJobs)
      .where(
        and(
          eq(knowledgeIngestJobs.workspaceId, params.workspaceId),
          eq(knowledgeIngestJobs.sha, params.sha),
          eq(knowledgeIngestJobs.scope, 'diff'),
          inArray(knowledgeIngestJobs.status, ['queued', 'running']),
        ),
      )
      .orderBy(asc(knowledgeIngestJobs.createdAt))
      .limit(1)) as JobRow[];

    const job = rows[0];
    if (!job) return null;

    const verdict = classifyIngestJobLiveness(job, now);
    if (verdict === 'live' || verdict === 'terminal') return null;

    const out = emptySummary();
    await applyReclaim(job, verdict, now, out);
    return out.requeued.includes(job.id) ? job.id : null;
  } catch (err) {
    console.error('[knowledge-ingest] recoverBlockedDiffJob failed (non-fatal):', err);
    return null;
  }
}
