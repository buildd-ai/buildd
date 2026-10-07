/**
 * /api/workspaces/[id]/quality-scout
 *
 * GET  — the Quality Scout readout: last exercised ref/SHA and whether newer
 *        work made it stale (per ref and per probe family), recent runs with
 *        their metrics, and where the findings stand. Read-only.
 * POST — a manual Scout run on `{ ref?, sha? }` (default: the default
 *        branch's head). Bounded by the workspace budget and the server cap;
 *        answers with the run's outcome. Refused only by `mode: off`, which
 *        is reported, not an error. A double tap inside a few minutes is the
 *        same run (`skipped: duplicate`); beyond that, a workspace gets at most
 *        MANUAL_SCOUT_RUNS_PER_HOUR manual runs an hour (429 + Retry-After).
 *
 * Advisory only: nothing here blocks a merge or release.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workspaces } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { verifyWorkspaceAccess } from '@/lib/team-access';
import { loadScoutReadout } from '@/lib/quality-scout-readout';
import {
  checkManualScoutRateLimit,
  loadScoutWorkspace,
  resolveScoutTriggerConfig,
  serverHeadSha,
  triggerQualityScout,
} from '@/lib/quality-scout-trigger';

// A server-hosted run is capped below this (SERVER_SCOUT_MAX_DURATION_MS).
export const maxDuration = 300;

const SHA_RE = /^[0-9a-f]{40}$/i;

async function authorize(req: NextRequest, id: string): Promise<NextResponse | null> {
  const apiKey = req.headers.get('authorization')?.replace('Bearer ', '') || null;
  const apiAccount = await authenticateApiKey(apiKey, req);
  const user = await getCurrentUser();
  if (!apiAccount && !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  // Same rule as readiness: an API key reaches its own team's workspaces only,
  // and a workspace elsewhere is indistinguishable from one that does not exist.
  if (apiAccount) {
    const owner = await db.query.workspaces.findFirst({ where: eq(workspaces.id, id), columns: { teamId: true } });
    if (!owner || owner.teamId !== apiAccount.teamId) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  } else if (user && !(await verifyWorkspaceAccess(user.id, id))) {
    return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  }
  return null;
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const denied = await authorize(req, id);
  if (denied) return denied;
  const ws = await loadScoutWorkspace(id);
  if (!ws) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  try {
    const readout = await loadScoutReadout(id, {
      mode: resolveScoutTriggerConfig(ws.gitConfig?.qualityScout).mode,
      headSha: (ref) => serverHeadSha(ws, ref),
    });
    return NextResponse.json(readout);
  } catch (err) {
    console.error('[quality-scout] readout failed:', err);
    return NextResponse.json({ error: 'Failed to read the Quality Scout readout' }, { status: 500 });
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const denied = await authorize(req, id);
  if (denied) return denied;

  let body: { ref?: unknown; sha?: unknown } = {};
  try {
    body = (await req.json()) ?? {};
  } catch {
    // An empty body means "the default branch head".
  }
  const ref = typeof body.ref === 'string' && body.ref.trim() ? body.ref.trim() : null;
  if (body.sha !== undefined && (typeof body.sha !== 'string' || !SHA_RE.test(body.sha))) {
    return NextResponse.json({ error: 'sha must be a full 40-character commit SHA' }, { status: 400 });
  }
  const sha = typeof body.sha === 'string' ? body.sha.toLowerCase() : null;

  const rate = await checkManualScoutRateLimit(id, new Date());
  if (!rate.allowed) {
    return NextResponse.json(
      { error: 'Too many manual Quality Scout runs for this workspace; try again later', retryAfterSec: rate.retryAfterSec },
      { status: 429, headers: { 'Retry-After': String(rate.retryAfterSec) } },
    );
  }

  const outcome = await triggerQualityScout({ workspaceId: id, trigger: 'manual', ref, sha });
  return NextResponse.json(outcome, { status: outcome.status === 'failed' ? 502 : 200 });
}
