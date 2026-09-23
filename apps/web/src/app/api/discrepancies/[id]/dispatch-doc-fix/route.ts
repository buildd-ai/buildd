/**
 * POST /api/discrepancies/[id]/dispatch-doc-fix
 *
 * The "Dispatch doc fix" action on a grouped code-ahead DISCREPANCY card.
 *
 * docs/design/spec-conformance.md §8 says the only valid actions on a
 * `code_ahead` row are "accept, or a docs-only follow-up task". The surface
 * offered accept and nothing else, so a card that named the remedy in its own
 * label had no way to reach it. This is that follow-up task — the FIRST
 * dispatch path for a discrepancy, deliberately sited inside the existing
 * `/api/discrepancies/[id]/*` family next to `adjudicate` and `promote` rather
 * than as a new top-level surface. There is no pre-existing discrepancy
 * dispatch endpoint to widen: `apply-recommendation` is keyed on a PR number
 * and a reviewer note, neither of which a ledger row has.
 *
 * The promotion rule is untouched. This does not mint a mission, and
 * `promote_discrepancy` still refuses `code_ahead` rows exactly as before —
 * the whole point is that a doc fix is not a build.
 *
 * ── Dedupe ──
 * The claim is `spec_discrepancies.doc_fix_task_id`, taken with an atomic
 * `UPDATE ... WHERE doc_fix_task_id IS NULL` (the CLAUDE.md optimistic-lock
 * pattern — neon-http has no interactive transactions). A double-tap, or a
 * sibling row on the same spec path, loses that race and gets the winning
 * task back with `dispatched: false`. The loser's own just-inserted task row
 * is deleted before it is ever dispatched, so no worker is ever started for it.
 *
 * ── Closure ──
 * Nothing here changes a row's `status`. §9 closure stays mechanical: a row
 * resolves when a checker re-run resolves its assertion, never because this
 * task, its PR, or its worker said so.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { specDiscrepancies, tasks, workers, workspaces } from '@buildd/core/db/schema';
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { verifyWorkspaceAccess, verifyAccountWorkspaceAccess } from '@/lib/team-access';
import { dispatchNewTask } from '@/lib/task-dispatch';
import { docFixTaskTitle, buildDocFixTaskDescription } from '@buildd/core/spec-doc-fix';
import { isDocFixInFlight, isDocFixClaimStale } from '@/lib/action-queue';

/** Statuses that release a claim: nothing is coming, so the CTA comes back. */
const DEAD_DOC_FIX_STATUSES = new Set(['failed', 'cancelled']);

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const user = await getCurrentUser();
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const apiAccount = await authenticateApiKey(apiKey);

  if (!user && !apiAccount) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (apiAccount && apiAccount.level !== 'admin') {
    return NextResponse.json({ error: 'Requires admin-level API key' }, { status: 403 });
  }

  const row = await db.query.specDiscrepancies.findFirst({ where: eq(specDiscrepancies.id, id) });
  if (!row) return NextResponse.json({ error: 'Discrepancy not found' }, { status: 404 });

  if (user && !apiAccount) {
    const access = await verifyWorkspaceAccess(user.id, row.workspaceId);
    if (!access) return NextResponse.json({ error: 'Discrepancy not found' }, { status: 404 });
  } else if (apiAccount) {
    const hasAccess = await verifyAccountWorkspaceAccess(apiAccount.id, row.workspaceId);
    if (!hasAccess) return NextResponse.json({ error: 'Discrepancy not found' }, { status: 404 });
  }

  if (row.direction !== 'code_ahead') {
    return NextResponse.json(
      {
        error:
          `A doc fix only applies to a 'code_ahead' row (this row is '${row.direction}') — ` +
          `the code has shipped and the document is what is stale. See docs/design/spec-conformance.md §8.`,
      },
      { status: 400 },
    );
  }
  if (row.status !== 'open') {
    return NextResponse.json(
      { error: `Discrepancy is '${row.status}', not open — there is no live gap to dispatch a fix for.` },
      { status: 409 },
    );
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
  // re-evaluated with the gap still open (isDocFixClaimStale) is refused
  // below: the doc fix already landed, so the row is held open by its
  // assertions, and another docs-only task would reproduce the same result.
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
        columns: { taskId: true, prLifecycleStatus: true, mergedAt: true },
        orderBy: (w, { desc: descOrder }) => [descOrder(w.startedAt)],
      })
    : [];
  const workerByTask = new Map<string, { prLifecycleStatus: string | null; mergedAt: Date | null }>();
  for (const w of claimedWorkers) {
    if (w.taskId && !workerByTask.has(w.taskId)) {
      workerByTask.set(w.taskId, { prLifecycleStatus: w.prLifecycleStatus ?? null, mergedAt: w.mergedAt ?? null });
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
    return NextResponse.json({ ok: true, dispatched: false, taskId: liveClaim.docFixTaskId });
  }

  const mergedClaim = groupRows.find((r) => r.docFixTaskId && isDocFixClaimStale(rowClaimState(r)));
  if (mergedClaim?.docFixTaskId) {
    return NextResponse.json(
      {
        ok: false,
        dispatched: false,
        code: 'doc_fix_already_merged',
        taskId: mergedClaim.docFixTaskId,
        error:
          `A doc fix for ${row.specPath} already merged and the conformance re-run still finds these ` +
          `assertions open, so another docs-only task would reproduce the same result. Accept the ` +
          `rows with a reason, add skip_until to the assertion, or rewrite the assertion.`,
      },
      { status: 409 },
    );
  }

  const staleClaimTaskIds = claimedTaskIds.filter((t) => DEAD_DOC_FIX_STATUSES.has(statusByTask.get(t) ?? ''));

  const assertionIds = groupRows.map((r) => r.assertionId);
  const discrepancyIds = groupRows.map((r) => r.id);

  const [docFixTask] = await db
    .insert(tasks)
    .values({
      workspaceId: row.workspaceId,
      title: docFixTaskTitle(row.specPath),
      description: buildDocFixTaskDescription({
        specPath: row.specPath,
        assertions: groupRows.map((r) => ({
          assertionId: r.assertionId,
          detail: typeof r.evidence?.detail === 'string' ? (r.evidence.detail as string) : null,
        })),
      }),
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
      creationSource: user ? 'dashboard' : 'api',
      context: {
        specDocFix: {
          specPath: row.specPath,
          assertionIds,
          discrepancyIds,
          workspaceId: row.workspaceId,
        },
        // Read by prompt-builder: the plan is a proposal slot, not this task's
        // deliverable, so an empty plan is a valid and expected outcome.
        planOptional: true,
        // Read by shouldAutoApprovePlan: a proposal is NEVER auto-dispatched,
        // whatever BUILDD_REQUIRE_PLAN_APPROVAL says. Spec before code.
        requiresPlanApproval: true,
        dispatchedBy: user?.email ?? 'api',
      },
    })
    .returning();

  // The claim. Atomic, and the only thing that decides who actually dispatches.
  const claimWhere = staleClaimTaskIds.length
    ? and(
        inArray(specDiscrepancies.id, discrepancyIds),
        or(isNull(specDiscrepancies.docFixTaskId), inArray(specDiscrepancies.docFixTaskId, staleClaimTaskIds)),
      )
    : and(inArray(specDiscrepancies.id, discrepancyIds), isNull(specDiscrepancies.docFixTaskId));

  const claimed = await db
    .update(specDiscrepancies)
    .set({ docFixTaskId: docFixTask.id })
    .where(claimWhere)
    .returning({ id: specDiscrepancies.id });

  if (claimed.length === 0) {
    // Lost the race entirely. Delete the task we just inserted — it has not
    // been dispatched, so nothing has started on it — and report the winner.
    await db.delete(tasks).where(eq(tasks.id, docFixTask.id));
    const fresh = await db.query.specDiscrepancies.findFirst({
      where: eq(specDiscrepancies.id, id),
      columns: { docFixTaskId: true },
    });
    return NextResponse.json({ ok: true, dispatched: false, taskId: fresh?.docFixTaskId ?? null });
  }

  const workspace = await db.query.workspaces.findFirst({ where: eq(workspaces.id, row.workspaceId) });
  if (workspace) {
    await dispatchNewTask(docFixTask, workspace);
  }

  return NextResponse.json({
    ok: true,
    dispatched: true,
    taskId: docFixTask.id,
    specPath: row.specPath,
    assertionIds,
    // Rows this task claimed. Fewer than `assertionIds` only when a concurrent
    // caller had already claimed some of them — surfaced rather than hidden.
    claimedDiscrepancyIds: claimed.map((c) => c.id),
  });
}
