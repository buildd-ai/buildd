/**
 * Automatic conformance re-runs and the one automatic follow-up, for merged
 * doc fixes — docs/design/spec-conformance.md §9/§12.1.
 *
 * A doc-fix card used to sit on "awaiting the conformance re-run" for days:
 * nothing asked for a re-run, and nothing noticed when the one that did run
 * left the row open. Two paths close that loop, both capped and deduped:
 *
 *  1. Re-run. When a doc-fix PR merges (the GitHub webhook) — and again from
 *     the hourly pr-reconcile sweep for any merged fix whose rows were never
 *     rechecked — buildd dispatches the EXISTING ledger workflow
 *     (spec-discrepancy-ledger.yml) with `force: true`, which bypasses the §4
 *     delta gate. Same workflow, same writer: there is no second path that
 *     writes spec_discrepancies. `recheck_requested_at` is the dedupe key; a
 *     forced run already in flight since the merge covers every later ask.
 *     The sweep stops after DOC_FIX_AUTOMATION_BUDGET_MS, and the card then
 *     goes to the owner as a stalled re-run.
 *
 *  2. Follow-up. A merged fix that was rechecked and is STILL open gets one
 *     follow-up doc-fix task (lib/doc-fix-dispatch.ts, mode `follow_up`),
 *     briefed to choose between promoting the status, correcting the
 *     assertion, or suppressing it with skip_until. The cap is the row's
 *     `auto_follow_up_task_id`, taken by the same atomic UPDATE as the claim.
 *
 * Neither path touches a row's status. Rows resolve only when the ledger
 * writer's evaluation is clean (§9).
 */

import { db } from '@buildd/core/db';
import { specDiscrepancies, tasks, workers, workspaces } from '@buildd/core/db/schema';
import { and, eq, inArray, isNotNull, isNull, lt, or } from 'drizzle-orm';
import { githubApi } from '@/lib/github';
import { dispatchDocFix } from '@/lib/doc-fix-dispatch';
import {
  DOC_FIX_RECHECK_IN_FLIGHT_MS,
  DOC_FIX_RECHECK_SWEEP_AFTER_MS,
  deriveDocFixAutomation,
  rowNeedsRecheck,
  type DiscrepancyCandidate,
} from '@/lib/action-queue';

export const LEDGER_WORKFLOW_FILE = 'spec-discrepancy-ledger.yml';

// ─── Forced ledger re-run ───────────────────────────────────────────────────

export type LedgerDispatcher = (workspaceId: string) => Promise<{ ok: boolean; reason?: string }>;

/**
 * POST a `workflow_dispatch` of the ledger workflow with `force: true` on the
 * workspace's default branch, through the workspace's GitHub App installation.
 */
export const dispatchLedgerWorkflow: LedgerDispatcher = async (workspaceId) => {
  const workspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, workspaceId),
    with: { githubInstallation: true },
  });
  const installationId = workspace?.githubInstallation?.installationId;
  const [owner, name] = (workspace?.repo ?? '').split('/');
  if (!workspace || !installationId || !owner || !name) {
    return { ok: false, reason: 'workspace has no GitHub App installation or repo' };
  }
  const ref = (workspace.gitConfig as { defaultBranch?: string } | null)?.defaultBranch || 'dev';
  try {
    await githubApi(installationId, `/repos/${owner}/${name}/actions/workflows/${LEDGER_WORKFLOW_FILE}/dispatches`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref, inputs: { force: 'true' } }),
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
};

export interface RecheckRequestResult {
  dispatched: boolean;
  reason: 'dispatched' | 'in_flight' | 'raced' | 'dispatch_failed' | 'nothing_to_do';
  detail?: string;
}

/**
 * Ask for one forced ledger re-run covering `rowIds`, whose doc fixes merged
 * no later than `mergedBy`. At most one forced run is dispatched per window:
 *
 *  - a forced run requested for this workspace after `mergedBy` and inside
 *    DOC_FIX_RECHECK_IN_FLIGHT_MS already covers these rows (it checks out the
 *    branch after the merge) — the rows are stamped with it, nothing new runs;
 *  - otherwise the rows are claimed with an atomic UPDATE on
 *    recheck_requested_at, and only the caller that wins dispatches. A failed
 *    dispatch releases the stamp so the next sweep retries.
 */
export async function requestLedgerRecheck(
  workspaceId: string,
  rowIds: string[],
  mergedBy: Date,
  now: Date = new Date(),
  dispatcher: LedgerDispatcher = dispatchLedgerWorkflow,
): Promise<RecheckRequestResult> {
  if (rowIds.length === 0) return { dispatched: false, reason: 'nothing_to_do' };

  const windowStart = new Date(now.getTime() - DOC_FIX_RECHECK_IN_FLIGHT_MS);
  const cutoff = new Date(Math.max(windowStart.getTime(), mergedBy.getTime()));

  const recent = await db
    .select({ recheckRequestedAt: specDiscrepancies.recheckRequestedAt })
    .from(specDiscrepancies)
    .where(and(eq(specDiscrepancies.workspaceId, workspaceId), isNotNull(specDiscrepancies.recheckRequestedAt)));
  const covering = recent
    .map((r) => (r.recheckRequestedAt ? new Date(r.recheckRequestedAt).getTime() : 0))
    .filter((t) => t >= cutoff.getTime())
    .sort((a, b) => b - a)[0];
  if (covering) {
    await db
      .update(specDiscrepancies)
      .set({ recheckRequestedAt: new Date(covering) })
      .where(
        and(
          inArray(specDiscrepancies.id, rowIds),
          or(isNull(specDiscrepancies.recheckRequestedAt), lt(specDiscrepancies.recheckRequestedAt, new Date(covering))),
        ),
      );
    return { dispatched: false, reason: 'in_flight' };
  }

  const claimed = await db
    .update(specDiscrepancies)
    .set({ recheckRequestedAt: now })
    .where(
      and(
        inArray(specDiscrepancies.id, rowIds),
        or(isNull(specDiscrepancies.recheckRequestedAt), lt(specDiscrepancies.recheckRequestedAt, cutoff)),
      ),
    )
    .returning({ id: specDiscrepancies.id });
  if (claimed.length === 0) return { dispatched: false, reason: 'raced' };

  const result = await dispatcher(workspaceId);
  if (!result.ok) {
    await db
      .update(specDiscrepancies)
      .set({ recheckRequestedAt: null })
      .where(and(inArray(specDiscrepancies.id, claimed.map((c) => c.id)), eq(specDiscrepancies.recheckRequestedAt, now)));
    console.warn(`[spec-recheck] ledger dispatch failed for workspace ${workspaceId}: ${result.reason}`);
    return { dispatched: false, reason: 'dispatch_failed', detail: result.reason };
  }
  return { dispatched: true, reason: 'dispatched' };
}

// ─── Candidate loading ──────────────────────────────────────────────────────

type CandidateRow = DiscrepancyCandidate & { id: string };

/** Ledger rows as queue candidates, with any doc-fix claim's task and PR state resolved. */
async function loadClaimedCandidates(where: ReturnType<typeof and>): Promise<CandidateRow[]> {
  const rows = await db
    .select({
      id: specDiscrepancies.id,
      workspaceId: specDiscrepancies.workspaceId,
      specPath: specDiscrepancies.specPath,
      assertionId: specDiscrepancies.assertionId,
      direction: specDiscrepancies.direction,
      status: specDiscrepancies.status,
      firstSeenAt: specDiscrepancies.firstSeenAt,
      lastCheckedAt: specDiscrepancies.lastCheckedAt,
      docFixTaskId: specDiscrepancies.docFixTaskId,
      recheckRequestedAt: specDiscrepancies.recheckRequestedAt,
      autoFollowUpTaskId: specDiscrepancies.autoFollowUpTaskId,
      evidence: specDiscrepancies.evidence,
    })
    .from(specDiscrepancies)
    .where(where);
  if (rows.length === 0) return [];

  const taskIds = [...new Set(rows.map((r) => r.docFixTaskId).filter(Boolean) as string[])];
  const taskRows = taskIds.length
    ? await db.query.tasks.findMany({ where: inArray(tasks.id, taskIds), columns: { id: true, status: true } })
    : [];
  const statusById = new Map(taskRows.map((t) => [t.id, t.status]));
  const workerRows = taskIds.length
    ? await db.query.workers.findMany({
        where: inArray(workers.taskId, taskIds),
        columns: { taskId: true, prLifecycleStatus: true, mergedAt: true },
        orderBy: (w, { desc }) => [desc(w.startedAt)],
      })
    : [];
  const workerByTask = new Map<string, { prLifecycleStatus: string | null; mergedAt: Date | null }>();
  for (const w of workerRows) {
    if (w.taskId && !workerByTask.has(w.taskId)) {
      workerByTask.set(w.taskId, { prLifecycleStatus: w.prLifecycleStatus ?? null, mergedAt: w.mergedAt ?? null });
    }
  }

  return rows.map((r) => {
    const w = r.docFixTaskId ? workerByTask.get(r.docFixTaskId) : undefined;
    const declared = (r.evidence as { declaredStatus?: unknown } | null)?.declaredStatus;
    return {
      id: r.id,
      workspaceId: r.workspaceId,
      specPath: r.specPath,
      assertionId: r.assertionId,
      direction: r.direction,
      status: r.status,
      firstSeenAt: r.firstSeenAt,
      lastCheckedAt: r.lastCheckedAt,
      docFixTaskId: r.docFixTaskId,
      docFixTaskStatus: r.docFixTaskId ? statusById.get(r.docFixTaskId) ?? null : null,
      docFixPrLifecycleStatus: w?.prLifecycleStatus ?? null,
      docFixMergedAt: w?.mergedAt ?? null,
      recheckRequestedAt: r.recheckRequestedAt,
      autoFollowUpTaskId: r.autoFollowUpTaskId,
      declaredStatus: typeof declared === 'string' ? declared : null,
    };
  });
}

function latestMerge(rows: DiscrepancyCandidate[], fallback: Date): Date {
  const times = rows.map((r) => (r.docFixMergedAt ? new Date(r.docFixMergedAt).getTime() : 0)).filter(Boolean);
  return times.length ? new Date(Math.max(...times)) : fallback;
}

// ─── Merge webhook ──────────────────────────────────────────────────────────

/**
 * Called when a PR merges. If the merged task is a doc fix holding claims on
 * open ledger rows, dispatch the forced re-run now rather than waiting for the
 * next push to happen to evaluate it. Best-effort: the hourly sweep is the
 * backstop for a lost webhook or a failed dispatch.
 */
export async function requestRecheckForMergedDocFix(
  taskId: string,
  now: Date = new Date(),
  dispatcher: LedgerDispatcher = dispatchLedgerWorkflow,
): Promise<RecheckRequestResult> {
  const candidates = await loadClaimedCandidates(
    and(
      eq(specDiscrepancies.docFixTaskId, taskId),
      eq(specDiscrepancies.status, 'open'),
      eq(specDiscrepancies.direction, 'code_ahead'),
    ),
  );
  const due = candidates.filter((c) => rowNeedsRecheck(c, now, 0));
  if (due.length === 0) return { dispatched: false, reason: 'nothing_to_do' };
  return requestLedgerRecheck(due[0].workspaceId, due.map((c) => c.id), latestMerge(due, now), now, dispatcher);
}

// ─── Hourly sweep ───────────────────────────────────────────────────────────

export interface SpecRecheckSweepResult {
  candidates: number;
  rechecksDispatched: number;
  rechecksCovered: number;
  rechecksFailed: number;
  followUpsDispatched: number;
  followUpsFailed: number;
}

export interface SweepDeps {
  dispatcher?: LedgerDispatcher;
  followUp?: typeof dispatchDocFix;
}

/**
 * Rides pr-reconcile's hourly merge-state pass (the same place the stranded-
 * task sweep lives), so no new cron. Per workspace, at most one forced re-run;
 * per spec path, at most one follow-up — and the dispatch function's own
 * atomic claim makes a second follow-up for a row impossible regardless.
 */
export async function sweepSpecDiscrepancyRechecks(
  now: Date = new Date(),
  deps: SweepDeps = {},
): Promise<SpecRecheckSweepResult> {
  const dispatcher = deps.dispatcher ?? dispatchLedgerWorkflow;
  const followUp = deps.followUp ?? dispatchDocFix;
  const result: SpecRecheckSweepResult = {
    candidates: 0,
    rechecksDispatched: 0,
    rechecksCovered: 0,
    rechecksFailed: 0,
    followUpsDispatched: 0,
    followUpsFailed: 0,
  };

  // Every open code_ahead row, claimed or not: the follow-up decision is made
  // per spec path over the SAME group Home renders, so an unclaimed sibling
  // (still owed an ordinary doc fix) keeps the path out of follow-up exactly as
  // it keeps the card on "Dispatch doc fix".
  const candidates = await loadClaimedCandidates(
    and(eq(specDiscrepancies.status, 'open'), eq(specDiscrepancies.direction, 'code_ahead')),
  );
  result.candidates = candidates.filter((c) => c.docFixTaskId).length;

  // 1. Forced re-runs, one request per workspace.
  const dueByWorkspace = new Map<string, CandidateRow[]>();
  for (const c of candidates) {
    if (!rowNeedsRecheck(c, now, DOC_FIX_RECHECK_SWEEP_AFTER_MS)) continue;
    const bucket = dueByWorkspace.get(c.workspaceId) ?? [];
    bucket.push(c);
    dueByWorkspace.set(c.workspaceId, bucket);
  }
  for (const [workspaceId, due] of dueByWorkspace) {
    const r = await requestLedgerRecheck(workspaceId, due.map((c) => c.id), latestMerge(due, now), now, dispatcher);
    if (r.dispatched) result.rechecksDispatched++;
    else if (r.reason === 'in_flight' || r.reason === 'raced') result.rechecksCovered++;
    else if (r.reason === 'dispatch_failed') result.rechecksFailed++;
  }

  // 2. One follow-up per spec path whose merged fix was rechecked and is still open.
  const groups = new Map<string, CandidateRow[]>();
  for (const c of candidates) {
    const key = `${c.workspaceId}\u0000${c.specPath}`;
    const bucket = groups.get(key) ?? [];
    bucket.push(c);
    groups.set(key, bucket);
  }
  for (const rows of groups.values()) {
    if (deriveDocFixAutomation(rows, now) !== 'follow_up_queued') continue;
    const representative = rows[0];
    try {
      const r = await followUp(
        {
          id: representative.id,
          workspaceId: representative.workspaceId,
          specPath: representative.specPath,
          direction: representative.direction,
          status: representative.status,
        },
        { mode: 'follow_up', dispatchedBy: 'spec-recheck-sweep', creationSource: 'orchestrator' },
      );
      if (r.ok && r.dispatched) result.followUpsDispatched++;
      else if (!r.ok) result.followUpsFailed++;
    } catch (err) {
      result.followUpsFailed++;
      console.warn(`[spec-recheck] follow-up dispatch failed for ${representative.specPath}:`, err);
    }
  }

  return result;
}
