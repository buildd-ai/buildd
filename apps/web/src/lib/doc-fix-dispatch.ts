/**
 * The doc-fix dispatch — the claim and dedupe behind "Dispatch doc fix"
 * (POST /api/discrepancies/[id]/dispatch-doc-fix) AND the one automatic
 * follow-up the hourly sweep files (lib/spec-recheck.ts). One function, so a
 * human tap and the automation take exactly the same claim and can never both
 * dispatch for the same rows.
 *
 * docs/design/spec-conformance.md §8 says the only valid actions on a
 * `code_ahead` row are "accept, or a docs-only follow-up task". The promotion
 * rule is untouched: this never mints a mission.
 *
 * ── Dedupe ──
 * The claim is `spec_discrepancies.doc_fix_task_id`, taken with an atomic
 * `UPDATE ... WHERE doc_fix_task_id IS NULL` (the CLAUDE.md optimistic-lock
 * pattern — neon-http has no interactive transactions). A double-tap, or a
 * sibling row on the same spec path, loses that race and gets the winning
 * task back with `dispatched: false`. The loser's own just-inserted task row
 * is deleted before it is ever dispatched, so no worker is ever started for it.
 *
 * ── Modes ──
 *  - `initial` — the card's button. Rows held by a merged-and-rechecked fix
 *    are left out; when every row is held that way it refuses with
 *    `doc_fix_already_merged` (another prose reconcile would reproduce the
 *    same result).
 *  - `follow_up` — exactly those merged-and-rechecked rows, once each. The
 *    claim additionally requires `auto_follow_up_task_id IS NULL` and stamps
 *    it, so the cap is enforced by the same atomic UPDATE that takes the claim:
 *    a second follow-up can never be filed for a row, whoever asks.
 *
 * ── Closure ──
 * Nothing here changes a row's `status`. §9 closure stays mechanical: a row
 * resolves when a checker re-run resolves its assertion, never because this
 * task, its PR, or its worker said so.
 */

import { db } from '@buildd/core/db';
import { specDiscrepancies, tasks, workers, workspaces } from '@buildd/core/db/schema';
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { dispatchNewTask } from '@/lib/task-dispatch';
import {
  docFixTaskTitle,
  buildDocFixTaskDescription,
  docFixFollowUpTaskTitle,
  buildDocFixFollowUpDescription,
} from '@buildd/core/spec-doc-fix';
import { isDocFixInFlight, isDocFixClaimStale } from '@/lib/action-queue';

/** Statuses that release a claim: nothing is coming, so the CTA comes back. */
const DEAD_DOC_FIX_STATUSES = new Set(['failed', 'cancelled']);

export type DocFixDispatchMode = 'initial' | 'follow_up';

export interface DocFixDispatchRow {
  id: string;
  workspaceId: string;
  specPath: string;
  direction: string;
  status: string;
}

export type DocFixDispatchResult =
  | {
      ok: true;
      dispatched: true;
      taskId: string;
      specPath: string;
      assertionIds: string[];
      /** Fewer than `assertionIds` only when a concurrent caller claimed some first. */
      claimedDiscrepancyIds: string[];
    }
  | { ok: true; dispatched: false; taskId: string | null }
  | { ok: false; dispatched: false; httpStatus: number; code?: string; error: string; taskId?: string | null };

export async function dispatchDocFix(
  row: DocFixDispatchRow,
  opts: {
    mode: DocFixDispatchMode;
    dispatchedBy: string;
    creationSource: 'dashboard' | 'api' | 'orchestrator';
  },
): Promise<DocFixDispatchResult> {
  if (row.direction !== 'code_ahead') {
    return {
      ok: false,
      dispatched: false,
      httpStatus: 400,
      error:
        `A doc fix only applies to a 'code_ahead' row (this row is '${row.direction}') — ` +
        `the code has shipped and the document is what is stale. See docs/design/spec-conformance.md §8.`,
    };
  }
  if (row.status !== 'open') {
    return {
      ok: false,
      dispatched: false,
      httpStatus: 409,
      error: `Discrepancy is '${row.status}', not open — there is no live gap to dispatch a fix for.`,
    };
  }

  // The card is grouped by spec path, so the dispatch is too: every open
  // code-ahead row on this document is discharged by one docs-only task. The
  // group is re-derived here from the row's own spec path rather than taken
  // from the client, so a stale card cannot widen or narrow what gets claimed.
  const groupRows = await db
    .select({
      id: specDiscrepancies.id,
      assertionId: specDiscrepancies.assertionId,
      evidence: specDiscrepancies.evidence,
      docFixTaskId: specDiscrepancies.docFixTaskId,
      autoFollowUpTaskId: specDiscrepancies.autoFollowUpTaskId,
      firstSeenAt: specDiscrepancies.firstSeenAt,
      lastCheckedAt: specDiscrepancies.lastCheckedAt,
    })
    .from(specDiscrepancies)
    .where(
      and(
        eq(specDiscrepancies.workspaceId, row.workspaceId),
        eq(specDiscrepancies.specPath, row.specPath),
        eq(specDiscrepancies.direction, 'code_ahead'),
        eq(specDiscrepancies.status, 'open'),
      ),
    );
  groupRows.sort((a, b) => new Date(a.firstSeenAt).getTime() - new Date(b.firstSeenAt).getTime());

  // Resolve the status of every task already claimed on this group. A claim
  // held by a live task wins; one held by a failed/cancelled task is dead and
  // may be taken over. One held by a completed task whose PR merged and was
  // re-evaluated with the gap still open (isDocFixClaimStale) is the
  // follow-up's to take, never a fresh initial dispatch's.
  const claimedTaskIds = [...new Set(groupRows.map((r) => r.docFixTaskId).filter(Boolean) as string[])];
  const claimedTasks = claimedTaskIds.length
    ? await db.query.tasks.findMany({
        where: inArray(tasks.id, claimedTaskIds),
        columns: { id: true, status: true },
      })
    : [];
  const statusByTask = new Map(claimedTasks.map((t) => [t.id, t.status]));
  const claimedWorkers = claimedTaskIds.length
    ? await db.query.workers.findMany({
        where: inArray(workers.taskId, claimedTaskIds),
        columns: { taskId: true, prLifecycleStatus: true, mergedAt: true, prUrl: true },
        orderBy: (w, { desc: descOrder }) => [descOrder(w.startedAt)],
      })
    : [];
  const workerByTask = new Map<string, { prLifecycleStatus: string | null; mergedAt: Date | null; prUrl: string | null }>();
  for (const w of claimedWorkers) {
    if (w.taskId && !workerByTask.has(w.taskId)) {
      workerByTask.set(w.taskId, {
        prLifecycleStatus: w.prLifecycleStatus ?? null,
        mergedAt: w.mergedAt ?? null,
        prUrl: w.prUrl ?? null,
      });
    }
  }

  const rowClaimState = (r: (typeof groupRows)[number]) => {
    const taskStatus = r.docFixTaskId ? statusByTask.get(r.docFixTaskId) ?? null : null;
    const worker = r.docFixTaskId ? workerByTask.get(r.docFixTaskId) : undefined;
    return {
      docFixTaskId: r.docFixTaskId,
      docFixTaskStatus: taskStatus,
      docFixPrLifecycleStatus: worker?.prLifecycleStatus ?? null,
      docFixMergedAt: worker?.mergedAt ?? null,
      lastCheckedAt: r.lastCheckedAt,
    };
  };

  const liveClaim = groupRows.find((r) => {
    const state = rowClaimState(r);
    return isDocFixInFlight(state) && !isDocFixClaimStale(state);
  });
  if (liveClaim?.docFixTaskId) {
    // Double-tap, or a sibling row on a path someone is already fixing. Reads
    // as success, with the task to look at — never a second dispatch.
    return { ok: true, dispatched: false, taskId: liveClaim.docFixTaskId };
  }

  const isMergedStale = (r: (typeof groupRows)[number]) =>
    Boolean(r.docFixTaskId) && isDocFixClaimStale(rowClaimState(r));

  const detailOf = (r: (typeof groupRows)[number]) =>
    typeof r.evidence?.detail === 'string' ? (r.evidence.detail as string) : null;

  let dispatchRows: typeof groupRows;
  let title: string;
  let description: string;
  let takeoverTaskIds: string[];
  let priorTaskId: string | null = null;

  if (opts.mode === 'follow_up') {
    // Only rows a merged fix demonstrably failed to close, and only once each.
    dispatchRows = groupRows.filter((r) => isMergedStale(r) && !r.autoFollowUpTaskId);
    if (dispatchRows.length === 0) {
      return {
        ok: false,
        dispatched: false,
        httpStatus: 409,
        code: 'follow_up_not_owed',
        error: `No row on ${row.specPath} is owed an automatic follow-up (none merged-and-still-open, or the one follow-up is spent).`,
      };
    }
    priorTaskId = dispatchRows[0].docFixTaskId;
    const prior = priorTaskId ? workerByTask.get(priorTaskId) : undefined;
    const declared = dispatchRows
      .map((r) => (typeof r.evidence?.declaredStatus === 'string' ? (r.evidence.declaredStatus as string) : null))
      .find(Boolean) ?? null;
    title = docFixFollowUpTaskTitle(row.specPath);
    description = buildDocFixFollowUpDescription({
      specPath: row.specPath,
      assertions: dispatchRows.map((r) => ({ assertionId: r.assertionId, detail: detailOf(r) })),
      priorTaskId,
      priorPrUrl: prior?.prUrl ?? null,
      declaredStatus: declared,
    });
    // The stale claim IS what the follow-up takes over.
    takeoverTaskIds = [...new Set(dispatchRows.map((r) => r.docFixTaskId).filter(Boolean) as string[])];
  } else {
    // Rows held by a merged-and-rechecked fix are the follow-up's (and then
    // the owner's), so they are left out of this dispatch. Only when EVERY
    // open row on the path is held that way is the dispatch refused: a
    // code_ahead row that opened later on the same spec has never been
    // attempted and must stay doc-fixable.
    dispatchRows = groupRows.filter((r) => !isMergedStale(r));
    if (dispatchRows.length === 0) {
      const mergedClaim = groupRows.find(isMergedStale);
      return {
        ok: false,
        dispatched: false,
        httpStatus: 409,
        code: 'doc_fix_already_merged',
        taskId: mergedClaim?.docFixTaskId ?? null,
        error:
          `A doc fix for ${row.specPath} already merged and the conformance re-run still finds these ` +
          `assertions open, so another docs-only task would reproduce the same result. Accept the ` +
          `rows with a reason, add skip_until to the assertion, or rewrite the assertion.`,
      };
    }
    title = docFixTaskTitle(row.specPath);
    description = buildDocFixTaskDescription({
      specPath: row.specPath,
      assertions: dispatchRows.map((r) => ({ assertionId: r.assertionId, detail: detailOf(r) })),
    });
    takeoverTaskIds = [
      ...new Set(
        dispatchRows
          .map((r) => r.docFixTaskId)
          .filter((t): t is string => Boolean(t) && DEAD_DOC_FIX_STATUSES.has(statusByTask.get(t as string) ?? '')),
      ),
    ];
  }

  const assertionIds = dispatchRows.map((r) => r.assertionId);
  const discrepancyIds = dispatchRows.map((r) => r.id);

  const [docFixTask] = await db
    .insert(tasks)
    .values({
      workspaceId: row.workspaceId,
      title,
      description,
      // A planning task whose plan is OPTIONAL. The doc fix itself is the PR;
      // the plan slot is where a net-enhancement proposal lands, so the
      // existing approve_plan / reject_plan gate is the approval path instead
      // of a second approval vocabulary invented for proposals.
      mode: 'planning',
      taskClass: 'work',
      outputRequirement: 'pr_required',
      // Drives the §11 dispatch-time injection (spec-discrepancy-dispatch.ts):
      // the worker opens with the exact claims this ledger row carries.
      pathManifest: [row.specPath],
      category: 'docs',
      priority: 6,
      status: 'pending',
      creationSource: opts.creationSource,
      context: {
        specDocFix: {
          specPath: row.specPath,
          assertionIds,
          discrepancyIds,
          workspaceId: row.workspaceId,
          ...(opts.mode === 'follow_up' ? { followUpOf: priorTaskId } : {}),
        },
        // Read by prompt-builder: the plan is a proposal slot, not this task's
        // deliverable, so an empty plan is a valid and expected outcome.
        planOptional: true,
        // Read by shouldAutoApprovePlan: a proposal is NEVER auto-dispatched,
        // whatever BUILDD_REQUIRE_PLAN_APPROVAL says. Spec before code.
        requiresPlanApproval: true,
        dispatchedBy: opts.dispatchedBy,
      },
    })
    .returning();

  // The claim. Atomic, and the only thing that decides who actually dispatches.
  const unclaimedOrTakeover = takeoverTaskIds.length
    ? or(isNull(specDiscrepancies.docFixTaskId), inArray(specDiscrepancies.docFixTaskId, takeoverTaskIds))
    : isNull(specDiscrepancies.docFixTaskId);
  const claimWhere =
    opts.mode === 'follow_up'
      ? and(
          inArray(specDiscrepancies.id, discrepancyIds),
          inArray(specDiscrepancies.docFixTaskId, takeoverTaskIds),
          isNull(specDiscrepancies.autoFollowUpTaskId),
        )
      : and(inArray(specDiscrepancies.id, discrepancyIds), unclaimedOrTakeover);

  const claimed = await db
    .update(specDiscrepancies)
    .set(
      opts.mode === 'follow_up'
        ? { docFixTaskId: docFixTask.id, autoFollowUpTaskId: docFixTask.id }
        : { docFixTaskId: docFixTask.id },
    )
    .where(claimWhere)
    .returning({ id: specDiscrepancies.id });

  if (claimed.length === 0) {
    // Lost the race entirely. Delete the task we just inserted — it has not
    // been dispatched, so nothing has started on it — and report the winner.
    await db.delete(tasks).where(eq(tasks.id, docFixTask.id));
    const fresh = await db.query.specDiscrepancies.findFirst({
      where: eq(specDiscrepancies.id, row.id),
      columns: { docFixTaskId: true },
    });
    return { ok: true, dispatched: false, taskId: fresh?.docFixTaskId ?? null };
  }

  const workspace = await db.query.workspaces.findFirst({ where: eq(workspaces.id, row.workspaceId) });
  if (workspace) {
    await dispatchNewTask(docFixTask, workspace);
  }

  return {
    ok: true,
    dispatched: true,
    taskId: docFixTask.id,
    specPath: row.specPath,
    assertionIds,
    claimedDiscrepancyIds: claimed.map((c) => c.id),
  };
}
