import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { isGitHubAppConfigured } from '@/lib/github';
import { resolveReleaseStrategy } from '@buildd/core/release-strategy';
import { resolveReleaseTarget } from '@/lib/release/target';
import { releasePreflight } from '@/lib/release/dispatch';

/**
 * Release preflight (read-only): what would ship, whether the source ref is
 * green, and whether a release is already in flight. Lets an agent fire an
 * informed trigger instead of a blind one.
 *
 * Query: ?workspaceId=… | ?repo=owner/name  [&ref=…&prodBranch=…]
 * Auth: admin-level token (same gate as the trigger).
 */

async function isAdmin(req: NextRequest): Promise<boolean> {
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  if (apiKey) {
    const account = await authenticateApiKey(apiKey);
    return account?.level === 'admin';
  }
  const user = await getCurrentUser();
  return Boolean(user);
}

export async function GET(req: NextRequest) {
  if (!isGitHubAppConfigured()) {
    return NextResponse.json({ error: 'GitHub App not configured on this buildd instance' }, { status: 500 });
  }
  if (!(await isAdmin(req))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const sp = req.nextUrl.searchParams;
  const workspaceId = sp.get('workspaceId') ?? undefined;
  const repo = sp.get('repo') ?? undefined;
  if (!workspaceId && !repo) {
    return NextResponse.json({ error: 'workspaceId or repo is required' }, { status: 400 });
  }

  const targetResult = await resolveReleaseTarget({ workspaceId, repo });
  if (!targetResult.ok) {
    return NextResponse.json({ error: targetResult.error }, { status: targetResult.status });
  }
  const target = targetResult.target;

  const resolution = resolveReleaseStrategy(target.releaseConfig);
  const strategy = resolution.ok ? resolution.strategy : null;

  // Choose sensible source/target refs for the compare, overridable via query.
  // Resolution order: explicit param → releaseConfig field → gitConfig.defaultBranch.
  // Deliberately does not use the resolved strategy shape — a workflow_dispatch
  // workspace may also carry prodBranch for preflight comparison purposes.
  const refParam = sp.get('ref');
  const prodBranchParam = sp.get('prodBranch');
  const ref = refParam ?? target.releaseConfig?.ref ?? target.defaultBranch;
  const prodBranch = prodBranchParam ?? target.releaseConfig?.prodBranch ?? target.defaultBranch;

  // Comparing a branch to itself is always 0 commits ahead — a silent false negative
  // that makes it look like nothing needs shipping when the config is wrong.
  if (ref === prodBranch) {
    const refSource = refParam
      ? 'explicit param'
      : target.releaseConfig?.ref
        ? 'releaseConfig.ref'
        : 'gitConfig.defaultBranch';
    const prodBranchSource = prodBranchParam
      ? 'explicit param'
      : target.releaseConfig?.prodBranch
        ? 'releaseConfig.prodBranch'
        : 'gitConfig.defaultBranch';
    return NextResponse.json(
      {
        ok: false,
        error:
          `ref and prodBranch both resolved to "${ref}" ` +
          `(ref from ${refSource}, prodBranch from ${prodBranchSource}). ` +
          `This comparison is meaningless and would always show nothing to ship — ` +
          `update releaseConfig.prodBranch to the production branch (e.g., "main").`,
        ref,
        prodBranch,
        repo: target.repoFullName,
      },
      { status: 422 },
    );
  }

  try {
    const preflight = await releasePreflight(target.installationId, target.owner, target.name, {
      ref,
      prodBranch,
    });
    return NextResponse.json({
      ok: true,
      repo: target.repoFullName,
      strategy: strategy?.kind ?? null,
      configured: resolution.ok,
      ...preflight,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}
