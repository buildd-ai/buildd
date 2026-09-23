import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { isGitHubAppConfigured } from '@/lib/github';
import { resolveReleaseStrategy } from '@buildd/core/release-strategy';
import { resolveReleaseTarget } from '@/lib/release/target';
import { releasePreflight, deploymentOnlyPreflight } from '@/lib/release/dispatch';
import { getCallerAdminTeamIds } from '@/lib/team-access';

/**
 * Release preflight (read-only): what would ship, whether the source ref is
 * green, and whether a release is already in flight. Lets an agent fire an
 * informed trigger instead of a blind one.
 *
 * Query: ?workspaceId=… | ?repo=owner/name  [&ref=…&prodBranch=…]
 * Auth: same gate as the trigger — admin/owner in the target workspace's team
 * (or an admin-level key of that team); the target resolves only among those.
 */

/** null = unauthenticated; otherwise the teams the caller administers. */
async function resolveAdminTeamIds(req: NextRequest): Promise<string[] | null> {
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  if (apiKey) {
    const account = await authenticateApiKey(apiKey);
    if (!account) return null;
    return getCallerAdminTeamIds({
      kind: 'account', accountId: account.id, teamId: account.teamId, level: account.level,
    });
  }
  const user = await getCurrentUser();
  if (!user) return null;
  return getCallerAdminTeamIds({ kind: 'user', userId: user.id });
}

export async function GET(req: NextRequest) {
  if (!isGitHubAppConfigured()) {
    return NextResponse.json({ error: 'GitHub App not configured on this buildd instance' }, { status: 500 });
  }
  const adminTeamIds = await resolveAdminTeamIds(req);
  if (!adminTeamIds) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (adminTeamIds.length === 0) {
    return NextResponse.json(
      { error: 'Forbidden: requires admin or owner role in the workspace team (or an admin-level API key)' },
      { status: 403 },
    );
  }

  const sp = req.nextUrl.searchParams;
  const workspaceId = sp.get('workspaceId') ?? undefined;
  const repo = sp.get('repo') ?? undefined;
  if (!workspaceId && !repo) {
    return NextResponse.json({ error: 'workspaceId or repo is required' }, { status: 400 });
  }

  const targetResult = await resolveReleaseTarget({ workspaceId, repo, scope: { teamIds: adminTeamIds } });
  if (!targetResult.ok) {
    return NextResponse.json({ error: targetResult.error }, { status: targetResult.status });
  }
  const target = targetResult.target;

  const resolution = resolveReleaseStrategy(target.releaseConfig);
  const strategy = resolution.ok ? resolution.strategy : null;

  // Choose sensible source/target refs for the compare, overridable via query.
  // Prefer the resolved strategy's fields first, then releaseConfig fields, then defaultBranch.
  // branch_merge's source ref lives in releaseConfig.releaseBranch (the field
  // executeRelease already merges from) — NOT releaseConfig.ref, which only
  // ever applies to workflow_dispatch/script.
  const ref =
    sp.get('ref') ??
    (strategy?.kind === 'workflow_dispatch'
      ? strategy.ref
      : strategy?.kind === 'script'
        ? strategy.ref ?? target.releaseConfig?.ref ?? target.defaultBranch
        : target.releaseConfig?.releaseBranch ?? target.defaultBranch);
  const prodBranch =
    sp.get('prodBranch') ??
    (strategy?.kind === 'branch_merge'
      ? strategy.prodBranch
      : target.releaseConfig?.prodBranch ?? target.defaultBranch);

  try {
    // No distinct source ref to compare (unconfigured workspace, or ref and
    // prodBranch otherwise collapse to the same branch): a self-compare always
    // shows zero commits ahead and is never a meaningful preflight. Report
    // deploy-only status instead of refusing the call outright.
    if (ref === prodBranch) {
      const preflight = await deploymentOnlyPreflight(target.installationId, target.owner, target.name, prodBranch);
      return NextResponse.json({
        ok: true,
        repo: target.repoFullName,
        strategy: strategy?.kind ?? null,
        configured: resolution.ok,
        comparable: false,
        note: `No distinct source ref configured — ref and prodBranch both resolve to "${prodBranch}". Showing deploy-only status (CI on ${prodBranch}'s HEAD); nothing to compare.`,
        ...preflight,
      });
    }

    const preflight = await releasePreflight(target.installationId, target.owner, target.name, {
      ref,
      prodBranch,
    });
    return NextResponse.json({
      ok: true,
      repo: target.repoFullName,
      strategy: strategy?.kind ?? null,
      configured: resolution.ok,
      comparable: true,
      ...preflight,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}
