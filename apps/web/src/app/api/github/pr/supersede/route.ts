/**
 * POST /api/github/pr/supersede
 *
 * Record that a worker's closed-unmerged PR shipped anyway, under a different,
 * merged PR. Backs the MCP `record_pr_supersession` action — see
 * lib/pr-supersession.ts for the write itself and why it exists.
 *
 * Auth: API key / OAuth bearer (same as the sibling PATCH/PUT/GET handlers on
 * `/api/github/pr`), never a session — this is an agent-callable write.
 * A per-task token may supersede the PR its own run opened or a PR its own
 * task names (never because the PR owner's task names it), and only with a PR
 * in its own workspace's repo (not another repo of the mission). An agent run
 * on its runner's key names itself with workerId (as close_pr and update_pr
 * do) and is held to the same rule: its own worker's PR, a PR its task names,
 * or, for an orchestration task, a PR on its own mission. People keep their
 * team-wide reach. For a PR the workflow kernel owns, the write is T20 (docs/specs/workflow-state-kernel.md
 * §17.1, Slice D).
 */
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workers } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { authenticateTaskScopedCaller, taskScopeAllowsWorkerPr, taskScopeTaskNamesPr } from '@/lib/task-token-auth';
import { resolveWorkerByPrNumber } from '@/lib/pr-resolve';
import { recordPrSupersession } from '@/lib/pr-supersession';
import { canActOnWorkerPr } from '@/lib/worker-pr-access';
import { agentRunMayActOnPr } from '@/lib/agent-capabilities/worker-pr';

// The acting run's task, as agentRunMayActOnPr reads it (same columns close_pr loads).
const ACTING_TASK_COLUMNS = {
  id: true, roleSlug: true, mode: true, context: true, title: true, description: true, missionId: true,
  reviewerRetryPrNumber: true, ciRetryPrNumber: true, conflictRetryPrNumber: true,
} as const;

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;

  const account = await authenticateTaskScopedCaller(apiKey, req);
  if (!account) {
    return NextResponse.json({ error: 'Invalid API key' }, { status: 401 });
  }

  let body: {
    workerId?: string;
    prNumber?: number;
    workspaceId?: string;
    supersedingPrNumber?: number;
    /** owner/name — only when the superseding PR lives in another repo of the workspace or mission. */
    supersedingRepo?: string;
    reason?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { workerId, prNumber, workspaceId, supersedingPrNumber, supersedingRepo, reason } = body;

  if (!workerId && !prNumber) {
    return NextResponse.json({ error: 'workerId or prNumber is required' }, { status: 400 });
  }
  if (supersedingPrNumber == null || typeof supersedingPrNumber !== 'number') {
    return NextResponse.json({ error: 'supersedingPrNumber is required' }, { status: 400 });
  }
  if (!reason || typeof reason !== 'string' || !reason.trim()) {
    return NextResponse.json({ error: 'reason is required' }, { status: 400 });
  }
  if (supersedingRepo != null && typeof supersedingRepo !== 'string') {
    return NextResponse.json({ error: 'supersedingRepo must be owner/name' }, { status: 400 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let resolved: any;
  // The run doing the recording. With both workerId and prNumber, workerId names
  // the caller's own run and prNumber the PR it wants to record.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let acting: any = null;
  if (workerId) {
    acting = await db.query.workers.findFirst({
      where: eq(workers.id, workerId),
      with: { workspace: true, task: { columns: ACTING_TASK_COLUMNS } },
    });
    if (!acting) return NextResponse.json({ error: 'Worker not found' }, { status: 404 });
    if (!(await canActOnWorkerPr(account, acting))) {
      return NextResponse.json({ error: 'Worker belongs to different account' }, { status: 403 });
    }
  }

  if (prNumber != null) {
    // prNumber is explicit — resolve by it. This takes precedence over workerId
    // (which may be implicitly added by the MCP handler). Explicit prNumber means
    // "supersede THIS PR", regardless of which worker initially created it.
    // A task token resolves in its own workspace unless it names one, so a PR
    // number shared with another workspace does not come back as ambiguous.
    const searchWorkspaceId = workspaceId ?? account.taskScope?.workspaceId ?? null;
    resolved = await resolveWorkerByPrNumber(account, prNumber, searchWorkspaceId);
    if (typeof resolved.status === 'number') {
      return NextResponse.json(
        { error: resolved.error, ...(resolved.candidates ? { candidates: resolved.candidates } : {}) },
        { status: resolved.status },
      );
    }
    if (!(await canActOnWorkerPr(account, resolved))) {
      return NextResponse.json({ error: 'Worker belongs to different account' }, { status: 403 });
    }
  } else if (acting) {
    // workerId alone: the PR is that worker's own (team scoping checked above).
    resolved = acting;
  } else {
    return NextResponse.json({ error: 'workerId or prNumber is required' }, { status: 400 });
  }
  const resolvedWorkerId = resolved.id as string;

  // A task token: the PR its own run opened, or a PR its own task names (§17.1 (a), (b)).
  if (account.taskScope) {
    const pr = resolved.prNumber as number | null;
    const allowed = pr != null && (
      taskScopeAllowsWorkerPr(account, resolved, pr)
      || await taskScopeTaskNamesPr(account, { workspaceId: resolved.workspaceId ?? resolved.workspace?.id, prNumber: pr })
    );
    if (!allowed) {
      return NextResponse.json({ error: 'A task token may supersede only its own PR or a PR its own task names' }, { status: 403 });
    }
  }

  // An agent run on its runner's key: the PR must be its task's own, as for
  // close_pr. A per-task token is held to the stricter rule above instead.
  if (!account.taskScope) {
    const pr = resolved.prNumber as number | null;
    if (pr != null && !(await agentRunMayActOnPr(account, acting ?? resolved, pr))) {
      return NextResponse.json({
        error: `An agent run may supersede only its own PR (#${(acting ?? resolved).prNumber ?? 'none'}) or one its task names`,
      }, { status: 403 });
    }
  }

  const result = await recordPrSupersession({
    workerId: resolvedWorkerId,
    supersedingPrNumber,
    supersedingRepo: supersedingRepo ?? null,
    reason,
    // The workflow kernel records this as T20's actor: the caller's own task for a task token.
    recordedBy: account.taskScope ? `agent:${account.taskScope.taskId}` : account.name,
    ...(account.taskScope ? { targetRepoWithinWorkspace: true } : {}),
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  return NextResponse.json({
    ok: true,
    supersededPrNumber: result.supersededPrNumber,
    supersedingPrNumber: result.supersedingPrNumber,
    supersedingPrUrl: result.supersedingPrUrl,
    supersedingRepo: result.supersedingRepo,
  });
}
