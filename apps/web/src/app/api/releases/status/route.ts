import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { accounts } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { hashApiKey } from '@/lib/api-auth';
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
    const account = await db.query.accounts.findFirst({
      where: eq(accounts.apiKey, hashApiKey(apiKey)),
    });
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
  const ref =
    sp.get('ref') ??
    (strategy?.kind === 'workflow_dispatch'
      ? strategy.ref
      : strategy?.kind === 'script'
        ? strategy.ref ?? target.defaultBranch
        : target.defaultBranch);
  const prodBranch =
    sp.get('prodBranch') ??
    (strategy?.kind === 'branch_merge' ? strategy.prodBranch : target.defaultBranch);

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
