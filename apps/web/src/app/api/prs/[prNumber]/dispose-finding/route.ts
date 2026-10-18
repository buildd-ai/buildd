/**
 * POST /api/prs/[prNumber]/dispose-finding
 *
 * A person waives one finding on a PR the workflow kernel owns, or defers it to a named task
 * (docs/specs/workflow-state-kernel.md §5). Closes that finding and nothing else; recorded with
 * who and why. Body: { workspaceId?, findingId, disposition: 'waived' | 'deferred', reason,
 * deferredToTaskId? (a full task id, required for a deferral), headSha?, version? (the decision
 * head the card showed: the disposal is one decision bound to it) }.
 *
 * Session users only. The kernel door refuses any principal that is not a signed-in person, so an
 * API key or agent cannot reach it; the landing override is no longer the only way past a finding.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { tasks } from '@buildd/core/db/schema';
import { and, eq } from 'drizzle-orm';
import { sqlWhere } from '@buildd/core/db/relational-sql';
import { getCurrentUser } from '@/lib/auth-helpers';
import { resolveOpenWorkerForUser } from '@/lib/pr-resolve';
import { doorErrorResponse, disposeFinding, isDoorError } from '@/lib/workflow/kernel-client';
import { workspaceRepo } from '@/lib/workflow/github-facts';
import { explainDecisionRefusal, STALE_DECISION_REASONS } from '@buildd/workflow-kernel/decision-refusal';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const bad = (error: string, status: number, extra: Record<string, unknown> = {}) => NextResponse.json({ error, ...extra }, { status });

export async function POST(req: NextRequest, { params }: { params: Promise<{ prNumber: string }> }) {
  const user = await getCurrentUser();
  if (!user) return bad('Unauthorized', 401);

  const prNumber = parseInt((await params).prNumber, 10);
  if (!prNumber || isNaN(prNumber)) return bad('Invalid PR number', 400);

  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  const findingId = typeof body.findingId === 'string' ? body.findingId : '';
  const disposition = body.disposition;
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  const deferredToTaskId = typeof body.deferredToTaskId === 'string' ? body.deferredToTaskId.trim() : '';
  const decision = typeof body.headSha === 'string' && /^[0-9a-zA-Z]{1,64}$/.test(body.headSha) && Number.isInteger(body.version)
    ? { headSha: body.headSha, version: body.version as number } : undefined;
  if (!findingId) return bad('findingId is required', 400);
  if (disposition !== 'waived' && disposition !== 'deferred') return bad('disposition must be "waived" or "deferred"', 400);
  if (!reason) return bad('A reason is required to waive or defer a finding', 400, { code: 'reason_required' });
  if (disposition === 'deferred' && !UUID.test(deferredToTaskId)) {
    return bad('Deferring a finding needs the full id of the task that takes it', 400, { code: 'deferral_needs_task' });
  }

  const resolved = await resolveOpenWorkerForUser(user.id, prNumber, typeof body.workspaceId === 'string' ? body.workspaceId : undefined);
  if (typeof resolved.status === 'number') return bad(resolved.error, resolved.status, { candidates: resolved.candidates });
  const workspaceId = (resolved as { workspaceId: string }).workspaceId;

  if (disposition === 'deferred') {
    const target = await db.query.tasks.findFirst({
      where: sqlWhere(and(eq(tasks.id, deferredToTaskId), eq(tasks.workspaceId, workspaceId))),
      columns: { id: true },
    });
    if (!target) return bad('That task is not in this workspace', 400, { code: 'deferral_task_unresolved' });
  }

  const repo = await workspaceRepo(workspaceId).catch(() => null);
  if (!repo) return bad('Workspace has no GitHub repo', 422);

  let outcome;
  try {
    outcome = await disposeFinding({
      workspaceId, repoFullName: repo.repoFullName, prNumber, actor: `human:${user.id}`,
      findingId, disposition, reason, deferredToTaskId: disposition === 'deferred' ? deferredToTaskId : null,
      ...(decision ? { decision } : {}),
    }, { principal: { kind: 'user', id: user.id } });
  } catch (err) {
    if (isDoorError(err)) return doorErrorResponse(err) as NextResponse;
    throw err;
  }
  if (!outcome.handled) return bad('This PR is not managed by the delivery workflow, so it has no findings to close', 409, { code: 'not_kernel_pr' });
  const r = outcome.result;
  if (r.result === 'applied') return NextResponse.json({ ok: true, kernel: true });
  // A duplicate is success only while the finding is closed the way asked: a restated finding is
  // open again, and the earlier disposal's key must not report it closed.
  if (r.result === 'duplicate' && outcome.findingStatus === disposition) return NextResponse.json({ ok: true, replayed: true, kernel: true });
  const code = r.result === 'duplicate' ? 'state_moved' : r.reason;
  return NextResponse.json(
    { error: explainDecisionRefusal('dispose_finding', code), code, kernel: true, ...(STALE_DECISION_REASONS.has(code) ? { stale: true } : {}) },
    { status: 409 },
  );
}
