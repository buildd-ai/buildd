import { NextRequest, NextResponse } from 'next/server';
import { authenticateTaskScopedCaller, taskScopeAllowsMission } from '@/lib/task-token-auth';
import { getCurrentUser } from '@/lib/auth-helpers';
import { readMissionSpecOutcomes, recordMissionSpecVerdict } from '@/lib/specs/mission-outcome';
import type { SpecCaller } from '@/lib/specs/store';

type Ctx = { params: Promise<{ missionId: string }> };

/**
 * An API key or per-task token first, else the dashboard session. A task token
 * is confined to its own task's mission; within it lib/specs/mission-outcome.ts
 * lets only the mission's final verification task record.
 */
async function caller(req: NextRequest, missionId: string): Promise<SpecCaller | NextResponse> {
  const apiKey = req.headers.get('authorization')?.replace('Bearer ', '') || null;
  const account = await authenticateTaskScopedCaller(apiKey, req);
  if (account) {
    if (!(await taskScopeAllowsMission(account, missionId))) return NextResponse.json({ error: 'Mission not found' }, { status: 404 });
    return { kind: 'account', account };
  }
  const user = await getCurrentUser();
  return user ? { kind: 'user', userId: user.id } : NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}

/**
 * GET /api/specs/mission-outcomes/[missionId]: each selected outcome spec's
 * standing on the mission's integrated target (Living Specs Slice 12), per
 * criterion: pass, fail, inconclusive, unsupported, missing, stale or waived.
 */
export async function GET(req: NextRequest, { params }: Ctx) {
  const { missionId } = await params;
  const c = await caller(req, missionId);
  if (c instanceof NextResponse) return c;
  const r = await readMissionSpecOutcomes(c, missionId);
  if (r.ok) return NextResponse.json({ outcomes: r.outcomes });
  return NextResponse.json({ error: r.error }, { status: r.status });
}

/**
 * POST /api/specs/mission-outcomes/[missionId] { specId?, criterionId, verdict, headSha, evidenceRefs?, readIds?, observed?, reaffirms? }:
 * record one mission-level verdict at the integrated target. A person or the
 * mission's final verification task only (403 otherwise); a commit that is not
 * the current target is refused (409).
 */
export async function POST(req: NextRequest, { params }: Ctx) {
  const { missionId } = await params;
  const c = await caller(req, missionId);
  if (c instanceof NextResponse) return c;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const r = await recordMissionSpecVerdict(c, missionId, {
    specId: body?.specId, criterionId: body?.criterionId, verdict: body?.verdict, headSha: body?.headSha,
    evidenceRefs: body?.evidenceRefs, readIds: body?.readIds, observed: body?.observed, reaffirms: body?.reaffirms,
  });
  if (r.ok) return NextResponse.json({ verdictId: r.verdictId, standing: { verdict: r.standing.verdict, evidence: r.standing.evidence, targetSha: r.standing.targetSha, standings: r.standing.standings } });
  return NextResponse.json({ error: r.error }, { status: r.status });
}
