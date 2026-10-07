/**
 * POST /api/github/pr/supersede
 *
 * Record that a worker's closed-unmerged PR shipped anyway, under a different,
 * merged PR. Backs the MCP `record_pr_supersession` action — see
 * lib/pr-supersession.ts for the write itself and why it exists.
 *
 * Auth: API key / OAuth bearer (same as the sibling PATCH/PUT/GET handlers on
 * `/api/github/pr`), never a session — this is an agent-callable write.
 * A per-task token may supersede only the PR its own run opened, and only
 * with a PR in its own workspace's repo (not another repo of the mission).
 */
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workers } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { authenticateTaskScopedCaller, taskScopeAllowsWorkerPr } from '@/lib/task-token-auth';
import { resolveWorkerByPrNumber } from '@/lib/pr-resolve';
import { recordPrSupersession } from '@/lib/pr-supersession';
import { canActOnWorkerPr } from '@/lib/worker-pr-access';

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
  } else if (workerId) {
    // workerId supplied directly — still must belong to the caller's team.
    resolved = await db.query.workers.findFirst({
      where: eq(workers.id, workerId),
      with: { workspace: true },
    });
    if (!resolved) return NextResponse.json({ error: 'Worker not found' }, { status: 404 });
    if (!(await canActOnWorkerPr(account, resolved))) {
      return NextResponse.json({ error: 'Worker belongs to different account' }, { status: 403 });
    }
  } else {
    return NextResponse.json({ error: 'workerId or prNumber is required' }, { status: 400 });
  }
  const resolvedWorkerId = resolved.id as string;

  if (account.taskScope && (resolved.prNumber == null || !taskScopeAllowsWorkerPr(account, resolved, resolved.prNumber))) {
    return NextResponse.json({ error: 'A task token may supersede only its own PR' }, { status: 403 });
  }

  const result = await recordPrSupersession({
    workerId: resolvedWorkerId,
    supersedingPrNumber,
    supersedingRepo: supersedingRepo ?? null,
    reason,
    recordedBy: account.name,
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
