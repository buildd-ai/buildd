/**
 * POST /api/prs/[prNumber]/approve-override
 *
 * "Approve and override" on a review escalation (Living Spec r7 AC-45/AC-46;
 * docs/specs/workflow-kernel-library.md §7): a person approves the PR's current
 * head past the required findings still open or awaiting verification. One
 * audited kernel command (T23 HumanResolve approve), bound to the head and
 * delivery version the card showed. The findings stay listed; `Buildd / Review
 * approval` turns success for that head, saying it was a person's approval over
 * them, and the merge then follows the workspace policy.
 *
 * Body: { workspaceId?, headSha (the head the person decided on), version? (the delivery
 * version the card showed; absent = the version read now), reason? }.
 *
 * Who: a signed-in person only, from a dashboard session or their own OAuth
 * session (MCP). An API key, a per-task token or an agent grant is refused. The
 * person needs the merge policy to allow it, an owner or admin team role, and
 * merge permission on the repo on GitHub (lib/review-override-permission.ts),
 * read at the click. Refusals are a plain sentence; the escalation note clears
 * only when the kernel took the decision.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateTaskScopedCaller } from '@/lib/task-token-auth';
import { requestingPerson } from '@/lib/request-person';
import { constrainToGranted, type GrantScopedAccount } from '@/lib/grant-scope';
import { resolveOpenWorkerForUser } from '@/lib/pr-resolve';
import { reviewOverridePermission, reviewOverrideRefusalSentence } from '@/lib/review-override-permission';
import { supersedeAncestorEscalations } from '@/lib/escalation-supersession';
import { approveOverride, doorErrorResponse, isDoorError } from '@/lib/workflow/kernel-client';
import { explainDecisionRefusal, STALE_DECISION_REASONS } from '@buildd/workflow-kernel/decision-refusal';

const refuse = (code: string, status: number, extra: Record<string, unknown> = {}) =>
  NextResponse.json({ error: explainDecisionRefusal('approve_override', code), code, ...extra }, { status });

export async function POST(req: NextRequest, { params }: { params: Promise<{ prNumber: string }> }) {
  // A bearer decides when one is sent: only a person's own OAuth session is a person.
  const bearer = req.headers.get('authorization')?.replace('Bearer ', '') || null;
  const account = bearer ? await authenticateTaskScopedCaller(bearer, req) : null;
  const person = account ? requestingPerson(null, account) : (await getCurrentUser())?.id ?? null;
  if (!person) {
    if (account) return refuse('human_required', 403);
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const prNumber = parseInt((await params).prNumber, 10);
  if (!prNumber || isNaN(prNumber)) return NextResponse.json({ error: 'Invalid PR number' }, { status: 400 });

  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  // The head is what the decision is about; the version the card saw, when it sends one, binds it further.
  if (!(typeof body.headSha === 'string' && /^[0-9a-zA-Z]{1,64}$/.test(body.headSha))) return refuse('commit_id_required', 400);
  const decision = { headSha: body.headSha, ...(Number.isInteger(body.version) ? { version: body.version as number } : {}) };
  const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim().slice(0, 500) : null;

  const resolved = await resolveOpenWorkerForUser(person, prNumber, typeof body.workspaceId === 'string' ? body.workspaceId : undefined);
  if (typeof resolved.status === 'number') {
    return NextResponse.json({ error: resolved.error, candidates: resolved.candidates }, { status: resolved.status });
  }
  const { workspaceId, taskId } = resolved as { workspaceId: string; taskId: string | null };
  // An OAuth session on a workspace-restricted grant acts only where it was granted.
  if (account && constrainToGranted(account as GrantScopedAccount, [workspaceId], 'write').length === 0) {
    return NextResponse.json({ error: 'This session has no write access to that workspace' }, { status: 403 });
  }

  const perm = await reviewOverridePermission(person, workspaceId, { fresh: true });
  if (perm.refusal) {
    return NextResponse.json({ error: `The approval was not recorded. ${reviewOverrideRefusalSentence(perm.refusal)}`, code: perm.refusal }, { status: 403 });
  }

  let outcome;
  try {
    outcome = await approveOverride({
      workspaceId, prNumber, actor: `human:${person}`, decision, reason,
      hasMergePermission: perm.hasMergePermission, overridePermitted: perm.overridePermitted,
    }, { principal: { kind: 'user', id: person } });
  } catch (err) {
    if (isDoorError(err)) return doorErrorResponse(err) as NextResponse;
    throw err;
  }
  if (!outcome) return refuse('legacy_owns', 409);

  const r = outcome.result;
  if (r.result === 'applied' || (r.result === 'duplicate' && outcome.current.state !== 'ESCALATED')) {
    if (taskId) await supersedeAncestorEscalations(db, taskId, prNumber);
    return NextResponse.json({ ok: true, kernel: true, ...(r.result === 'duplicate' ? { replayed: true } : {}), current: outcome.current });
  }
  // A replayed decision on a PR that came back to a person: nothing ran, the new note stays.
  const code = r.result === 'duplicate' ? 'decision_already_answered' : r.reason;
  return refuse(code, 409, { kernel: true, current: outcome.current, ...(STALE_DECISION_REASONS.has(code) ? { stale: true } : {}) });
}
