import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { verifyWorkspaceAccess, verifyAccountWorkspaceAccess } from '@/lib/team-access';
import { listModelObservations } from '@/lib/model-observation-store';
import { correctnessOf, EMPTY_EVIDENCE } from '@buildd/core/model-observation';

/**
 * GET /api/model-observations?workspaceId=<id>&limit=<n>
 *
 * Per-attempt model observations of one workspace the caller can reach. A
 * workspace the caller cannot access answers 404, exactly like one that does
 * not exist. `correctness` is derived from independent evidence only; a
 * worker-declared completion is never an input.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const workspaceId = url.searchParams.get('workspaceId');
  if (!workspaceId) return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 });

  const apiKey = req.headers.get('authorization')?.replace('Bearer ', '') || null;
  if (apiKey) {
    const account = await authenticateApiKey(apiKey, req);
    if (!account) return NextResponse.json({ error: 'Invalid API key' }, { status: 401 });
    if (!(await verifyAccountWorkspaceAccess(account, workspaceId))) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }
  } else {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (!(await verifyWorkspaceAccess(user.id, workspaceId))) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }
  }

  const limit = Number(url.searchParams.get('limit') ?? 100);
  const rows = await listModelObservations(workspaceId, Number.isFinite(limit) ? limit : 100);
  return NextResponse.json({
    observations: rows.map((r) => ({
      ...r,
      correctness: correctnessOf({
        ...EMPTY_EVIDENCE,
        reviewVerdict: (r.reviewVerdict as 'approved' | 'changes_requested' | null) ?? null,
        ciState: (r.ciState as 'passed' | 'failed' | null) ?? null,
        specVerdict: (r.specVerdict as 'pass' | 'fail' | null) ?? null,
        prOutcome: (r.prOutcome as 'merged' | 'closed' | null) ?? null,
        reworked: r.reworked,
      }),
    })),
  });
}
