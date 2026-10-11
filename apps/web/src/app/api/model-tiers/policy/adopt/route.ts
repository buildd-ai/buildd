/**
 * POST /api/model-tiers/policy/adopt  { workspaceId? | teamId? }
 *
 * Under the manual upgrade policy, take every model certified so far: moves
 * the policy's adoption line to now, at the level the policy is set on (the
 * workspace's own policy, else the team's). Catalog-resolved tiers move on the
 * next claim; pinned tiers do not. Other modes adopt by themselves, so they get
 * a 400 that says how.
 */
import { NextRequest, NextResponse } from 'next/server';
import { authenticate, resolveTeam } from '@/lib/model-tier-access';
import { adoptPolicy } from '@buildd/core/model-upgrade-policy';
import { loadUpgradePolicy, writeUpgradePolicy, invalidateUpgradePolicyCache } from '@buildd/core/model-upgrade-policy-store';

export async function POST(req: NextRequest) {
  const auth = await authenticate(req);
  if ('error' in auth) return auth.error;
  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    // An empty body adopts for the active team.
  }
  const workspaceId = typeof body.workspaceId === 'string' && body.workspaceId ? body.workspaceId : null;
  try {
    const resolved = await resolveTeam(req, auth.user, auth.apiAccount, {
      workspaceId,
      teamId: typeof body.teamId === 'string' ? body.teamId : null,
      write: true,
    });
    if ('error' in resolved) return resolved.error;

    invalidateUpgradePolicyCache();
    const effective = await loadUpgradePolicy(resolved.teamId, workspaceId);
    if (effective.policy.mode !== 'manual') {
      const how = effective.policy.mode === 'soak'
        ? 'The soak policy adopts certified models once they have soaked; set the policy to latest-compatible to adopt now.'
        : 'latest-compatible already adopts every certified model.';
      return NextResponse.json({ error: `Nothing to adopt under the ${effective.policy.mode} policy. ${how}` }, { status: 400 });
    }
    const actor = auth.user?.id ?? auth.apiAccount?.id ?? null;
    const next = adoptPolicy(effective.policy, actor, Date.now());
    const scope = effective.source === 'workspace' && workspaceId ? { workspaceId } : { teamId: resolved.teamId };
    await writeUpgradePolicy(scope, next);
    console.log(`[model-upgrade-policy] manual adoption line moved to ${next.adoptedThrough} by ${actor}`);
    return NextResponse.json({ ok: true, policy: next, scope: 'workspaceId' in scope ? 'workspace' : 'team' });
  } catch (error) {
    console.error('POST /api/model-tiers/policy/adopt error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
