/**
 * POST /api/prs/[prNumber]/land
 *
 * "Get this PR landable" on a review escalation: one owner action that files one
 * landing task on the PR branch (merge the base in, fix red CI, address the open
 * findings) and, because a person asked, grants one review of the head that task
 * pushes. A push after an escalation gets no review on its own (the review budget
 * is spent); this is the decision that lifts it, once.
 *
 * One audited kernel command (T23 HumanResolve), bound to the head and delivery
 * version the card showed; the same decision again is answered by the first.
 * Kernel-owned PRs only: a PR the kernel does not run has no escalation to land.
 *
 * Body: { workspaceId?, headSha (the head the person decided on), version? }.
 * Auth: a signed-in person (session) with access to the workspace.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { getCurrentUser } from '@/lib/auth-helpers';
import { resolveOpenWorkerForUser } from '@/lib/pr-resolve';
import { supersedeAncestorEscalations } from '@/lib/escalation-supersession';
import { doorErrorResponse, isDoorError, landEscalatedThroughKernel } from '@/lib/workflow/kernel-client';
import { explainDecisionRefusal, STALE_DECISION_REASONS } from '@buildd/workflow-kernel/decision-refusal';

export async function POST(req: NextRequest, { params }: { params: Promise<{ prNumber: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const prNumber = parseInt((await params).prNumber, 10);
  if (!prNumber || isNaN(prNumber)) return NextResponse.json({ error: 'Invalid PR number' }, { status: 400 });

  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  const decisionHeadSha = typeof body.headSha === 'string' && /^[0-9a-zA-Z]{1,64}$/.test(body.headSha) ? body.headSha : null;
  if (!decisionHeadSha) {
    return NextResponse.json({ error: explainDecisionRefusal('land_pr', 'commit_id_required'), code: 'commit_id_required' }, { status: 400 });
  }
  const expectedVersion = Number.isInteger(body.version) ? (body.version as number) : undefined;

  const resolved = await resolveOpenWorkerForUser(user.id, prNumber, typeof body.workspaceId === 'string' ? body.workspaceId : undefined);
  if (typeof resolved.status === 'number') {
    return NextResponse.json({ error: resolved.error, candidates: resolved.candidates }, { status: resolved.status });
  }
  const { workspaceId, taskId } = resolved as { workspaceId: string; taskId: string | null };

  const out = await landEscalatedThroughKernel({
    workspaceId, prNumber, actor: `human:${user.id}`, expectedVersion, decisionHeadSha,
  }, { principal: { kind: 'user', id: user.id } }).catch((err: unknown) => (isDoorError(err) ? err : Promise.reject(err)));
  if (isDoorError(out)) return doorErrorResponse(out) as NextResponse;
  if (!out) {
    return NextResponse.json({ error: explainDecisionRefusal('land_pr', 'legacy_owns'), code: 'legacy_owns' }, { status: 409 });
  }

  const r = out.result;
  if (r.result === 'stale' || r.result === 'rejected') {
    return NextResponse.json({
      error: explainDecisionRefusal('land_pr', r.reason), code: r.reason, kernel: true, current: out.current,
      ...(r.result === 'stale' || STALE_DECISION_REASONS.has(r.reason) ? { stale: true } : {}),
    }, { status: 409 });
  }
  if (r.result === 'duplicate') {
    // A replay after the PR escalated again ran nothing this time; the new escalation stays.
    if (out.current.state === 'ESCALATED') {
      const code = 'decision_already_answered';
      return NextResponse.json({ error: explainDecisionRefusal('land_pr', code), code, stale: true, kernel: true, current: out.current }, { status: 409 });
    }
    if (taskId) await supersedeAncestorEscalations(db, taskId, prNumber);
    return NextResponse.json({ ok: true, dispatched: false, kernel: true, taskId: out.attempt?.taskId ?? null, current: out.current });
  }

  if (taskId) await supersedeAncestorEscalations(db, taskId, prNumber);
  return NextResponse.json({ ok: true, dispatched: true, kernel: true, taskId: out.attempt?.taskId ?? null, current: out.current });
}
