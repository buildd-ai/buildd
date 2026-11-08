import { NextRequest, NextResponse } from 'next/server';
import { authenticateApiKey } from '@/lib/api-auth';
import { verifyAccountWorkspaceAccess } from '@/lib/team-access';
import { ingestReplayRuns } from '@/lib/model-observation-store';

const MAX_RUNS = 200;

/**
 * POST /api/model-observations/replay { workspaceId, runs: RunRecord[] }
 *
 * Ingests controlled replay runs written by `scripts/local-eval` as model
 * observations with case/config attribution (packages/core/local-eval.ts).
 * API-key only: the evaluator is a script, not a browser session. A workspace
 * the key cannot reach answers 404. Never changes routing.
 */
export async function POST(req: NextRequest) {
  const apiKey = req.headers.get('authorization')?.replace('Bearer ', '') || null;
  if (!apiKey) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const account = await authenticateApiKey(apiKey, req);
  if (!account) return NextResponse.json({ error: 'Invalid API key' }, { status: 401 });

  const body = (await req.json().catch(() => null)) as { workspaceId?: unknown; runs?: unknown } | null;
  if (!body || typeof body.workspaceId !== 'string') return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 });
  if (!Array.isArray(body.runs) || !body.runs.length || body.runs.length > MAX_RUNS) {
    return NextResponse.json({ error: `runs must be an array of 1 to ${MAX_RUNS} run records` }, { status: 400 });
  }
  if (!(await verifyAccountWorkspaceAccess(account, body.workspaceId))) {
    return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  }
  const result = await ingestReplayRuns(body.workspaceId, body.runs);
  return NextResponse.json(result, { status: result.rejected.length && !result.ingested.length ? 422 : 200 });
}
