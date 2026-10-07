/**
 * The team's model-upgrade policy (packages/core/model-upgrade-policy.ts).
 *
 * GET    ?workspaceId | ?teamId   effective policy + source, what is stored at
 *                                 each level, and per tier: model, why, newer
 *                                 certified model, why it is withheld, deprecation
 * PUT    { mode, soakHours?, workspaceId? | teamId? }   set at that level
 * DELETE ?workspaceId | ?teamId   clear that level (inherit the next one)
 *
 * Writes need manage_model_tiers, exactly like registry rows: the policy sets
 * which model every catalog-resolved tier runs. The actor is stamped on the
 * stored value (setBy/setAt) and logged.
 */
import { NextRequest, NextResponse } from 'next/server';
import { authenticate, resolveTeam } from '@/lib/model-tier-access';
import { buildUpgradePolicy } from '@buildd/core/model-upgrade-policy';
import { readStoredUpgradePolicy, writeUpgradePolicy } from '@buildd/core/model-upgrade-policy-store';
import { readUpgradePolicy } from '@buildd/core/model-upgrade-policy';
import { buildAdoptionReport } from '@buildd/core/model-adoption-report';

function scopeOf(teamId: string, workspaceId: string | null) {
  return workspaceId ? { workspaceId } : { teamId };
}

export async function GET(req: NextRequest) {
  const auth = await authenticate(req);
  if ('error' in auth) return auth.error;
  const { searchParams } = new URL(req.url);
  const workspaceId = searchParams.get('workspaceId') || null;
  try {
    const resolved = await resolveTeam(req, auth.user, auth.apiAccount, {
      workspaceId,
      teamId: searchParams.get('teamId') || null,
      write: false,
    });
    if ('error' in resolved) return resolved.error;
    const [report, team, workspace] = await Promise.all([
      buildAdoptionReport(resolved.teamId, workspaceId),
      readStoredUpgradePolicy({ teamId: resolved.teamId }),
      workspaceId ? readStoredUpgradePolicy({ workspaceId }) : Promise.resolve(null),
    ]);
    return NextResponse.json({
      policy: report.policy.policy,
      source: report.policy.source,
      stored: { team: readUpgradePolicy(team), workspace: readUpgradePolicy(workspace) },
      tiers: report.tiers,
    });
  } catch (error) {
    console.error('GET /api/model-tiers/policy error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  const auth = await authenticate(req);
  if ('error' in auth) return auth.error;
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const workspaceId = typeof body.workspaceId === 'string' && body.workspaceId ? body.workspaceId : null;
  try {
    const resolved = await resolveTeam(req, auth.user, auth.apiAccount, {
      workspaceId,
      teamId: typeof body.teamId === 'string' ? body.teamId : null,
      write: true,
    });
    if ('error' in resolved) return resolved.error;
    const actor = auth.user?.id ?? auth.apiAccount?.id ?? null;
    const built = buildUpgradePolicy({ mode: body.mode, soakHours: body.soakHours }, actor, Date.now());
    if ('error' in built) return NextResponse.json({ error: built.error }, { status: 400 });
    await writeUpgradePolicy(scopeOf(resolved.teamId, workspaceId), built.policy);
    console.log(`[model-upgrade-policy] ${workspaceId ? 'workspace' : 'team'} policy set to ${built.policy.mode} by ${actor}`);
    return NextResponse.json({ ok: true, policy: built.policy, scope: workspaceId ? 'workspace' : 'team' });
  } catch (error) {
    console.error('PUT /api/model-tiers/policy error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const auth = await authenticate(req);
  if ('error' in auth) return auth.error;
  const { searchParams } = new URL(req.url);
  const workspaceId = searchParams.get('workspaceId') || null;
  try {
    const resolved = await resolveTeam(req, auth.user, auth.apiAccount, {
      workspaceId,
      teamId: searchParams.get('teamId') || null,
      write: true,
    });
    if ('error' in resolved) return resolved.error;
    await writeUpgradePolicy(scopeOf(resolved.teamId, workspaceId), null);
    console.log(`[model-upgrade-policy] ${workspaceId ? 'workspace' : 'team'} policy cleared by ${auth.user?.id ?? auth.apiAccount?.id}`);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('DELETE /api/model-tiers/policy error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
