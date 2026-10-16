import { NextRequest, NextResponse } from 'next/server';
import { authenticateTaskScopedCaller, taskScopeAllowsWorkspace } from '@/lib/task-token-auth';
import { getCurrentUser } from '@/lib/auth-helpers';
import { governedTaskWorkspace, readGovernedOutcome, recordSpecVerdict } from '@/lib/specs/outcome';
import { VISUAL_SPEC_VERDICT } from '@/modules';
import type { SpecCaller } from '@/lib/specs/store';

type Ctx = { params: Promise<{ taskId: string }> };

/**
 * An API key or per-task token first, else the dashboard session. A task token
 * is confined to its own task's workspace here (taskScopeAllowsWorkspace), and
 * within it lib/specs/outcome.ts lets it read its own task's outcome and
 * record verdicts only on its parent (the task it reviews): never its own.
 */
async function caller(req: NextRequest, taskId: string): Promise<SpecCaller | NextResponse> {
  const apiKey = req.headers.get('authorization')?.replace('Bearer ', '') || null;
  const account = await authenticateTaskScopedCaller(apiKey, req);
  if (account) {
    if (!taskScopeAllowsWorkspace(account, await governedTaskWorkspace(taskId))) return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    return { kind: 'account', account };
  }
  const user = await getCurrentUser();
  return user ? { kind: 'user', userId: user.id } : NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}

/**
 * GET /api/specs/outcomes/[taskId]: the task's governed outcome against the
 * approved spec revision it is pinned to (verified | fail | unverified), per
 * criterion (lib/specs/outcome.ts). Distinct from the task's status and its PR.
 */
export async function GET(req: NextRequest, { params }: Ctx) {
  const { taskId } = await params;
  const c = await caller(req, taskId);
  if (c instanceof NextResponse) return c;
  const r = await readGovernedOutcome(c, taskId);
  if (r.ok) return NextResponse.json({ outcome: r.outcome });
  return NextResponse.json({ error: r.error }, { status: r.status });
}

/**
 * POST /api/specs/outcomes/[taskId] { criterionId, verdict, headSha, evidenceRefs?, readIds?, observed? }:
 * record one verdict on one criterion, bound to the PR head it judged. A task's
 * own token cannot record on it (403); its reviewer's can.
 *
 * With `checker: 'visual'` { criterionId, verdict, capturedSha, screenshotIds?, observed? }:
 * the mission's visual audit records what it saw (lib/visual-audit-spec-verdict.ts, through the visual-qa module slot).
 * The server binds it to the PR head when the captured commit contains it.
 */
export async function POST(req: NextRequest, { params }: Ctx) {
  const { taskId } = await params;
  const c = await caller(req, taskId);
  if (c instanceof NextResponse) return c;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (body?.checker === 'visual') {
    const v = await VISUAL_SPEC_VERDICT(c, taskId, {
      criterionId: body.criterionId, verdict: body.verdict, capturedSha: body.capturedSha,
      screenshotIds: body.screenshotIds, designShotIds: body.designShotIds, observed: body.observed,
    });
    if (v.ok) return NextResponse.json({ verdictId: v.verdictId, outcome: v.outcome });
    return NextResponse.json({ error: v.error }, { status: v.status });
  }
  const r = await recordSpecVerdict(c, taskId, {
    criterionId: body?.criterionId, verdict: body?.verdict, headSha: body?.headSha,
    evidenceRefs: body?.evidenceRefs, readIds: body?.readIds, observed: body?.observed,
  });
  if (r.ok) return NextResponse.json({ verdictId: r.verdictId, outcome: r.outcome });
  return NextResponse.json({ error: r.error }, { status: r.status });
}
