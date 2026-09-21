/**
 * POST /api/github/pr/supersede
 *
 * Record that a worker's closed-unmerged PR shipped anyway, under a different,
 * merged PR. Backs the MCP `record_pr_supersession` action — see
 * lib/pr-supersession.ts for the write itself and why it exists.
 *
 * Auth: API key / OAuth bearer (same as the sibling PATCH/PUT/GET handlers on
 * `/api/github/pr`), never a session — this is an agent-callable write.
 */
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workers } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { authenticateApiKey } from '@/lib/api-auth';
import { resolveWorkerByPrNumber } from '@/lib/pr-resolve';
import { recordPrSupersession } from '@/lib/pr-supersession';

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;

  const account = await authenticateApiKey(apiKey);
  if (!account) {
    return NextResponse.json({ error: 'Invalid API key' }, { status: 401 });
  }

  let body: {
    workerId?: string;
    prNumber?: number;
    workspaceId?: string;
    supersedingPrNumber?: number;
    reason?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { workerId, prNumber, workspaceId, supersedingPrNumber, reason } = body;

  if (!workerId && !prNumber) {
    return NextResponse.json({ error: 'workerId or prNumber is required' }, { status: 400 });
  }
  if (supersedingPrNumber == null || typeof supersedingPrNumber !== 'number') {
    return NextResponse.json({ error: 'supersedingPrNumber is required' }, { status: 400 });
  }
  if (!reason || typeof reason !== 'string' || !reason.trim()) {
    return NextResponse.json({ error: 'reason is required' }, { status: 400 });
  }

  let resolvedWorkerId: string;

  if (prNumber != null) {
    // prNumber is explicit — resolve by it. This takes precedence over workerId
    // (which may be implicitly added by the MCP handler). Explicit prNumber means
    // "supersede THIS PR", regardless of which worker initially created it.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resolved: any = await resolveWorkerByPrNumber(account, prNumber, workspaceId ?? null);
    if (typeof resolved.status === 'number') {
      return NextResponse.json(
        { error: resolved.error, ...(resolved.candidates ? { candidates: resolved.candidates } : {}) },
        { status: resolved.status },
      );
    }
    if (resolved.workspace?.teamId !== account.teamId) {
      return NextResponse.json({ error: 'Worker belongs to different account' }, { status: 403 });
    }
    resolvedWorkerId = resolved.id as string;
  } else if (workerId) {
    // workerId supplied directly — still must belong to the caller's team.
    const worker = await db.query.workers.findFirst({
      where: eq(workers.id, workerId),
      with: { workspace: true },
    });
    if (!worker) return NextResponse.json({ error: 'Worker not found' }, { status: 404 });
    if (worker.workspace?.teamId !== account.teamId) {
      return NextResponse.json({ error: 'Worker belongs to different account' }, { status: 403 });
    }
    resolvedWorkerId = workerId;
  } else {
    return NextResponse.json({ error: 'workerId or prNumber is required' }, { status: 400 });
  }

  const result = await recordPrSupersession({
    workerId: resolvedWorkerId,
    supersedingPrNumber,
    reason,
    recordedBy: account.name,
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  return NextResponse.json({
    ok: true,
    supersededPrNumber: result.supersededPrNumber,
    supersedingPrNumber: result.supersedingPrNumber,
    supersedingPrUrl: result.supersedingPrUrl,
  });
}
