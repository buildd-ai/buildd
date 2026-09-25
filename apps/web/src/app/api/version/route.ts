import { NextRequest, NextResponse } from 'next/server';
import { getLatestVersion, resolveVersionBranch } from '@/lib/version-cache';
import { getDeployIdentity, DEPLOYED_VERSION } from '@/lib/deploy-identity';
import { trackEvent } from '@/lib/axiom';

/**
 * GET /api/version?branch=<main|dev>
 *
 * Public endpoint (no auth) — answers two DIFFERENT questions, kept in
 * separate, unambiguously-named blocks so neither can be mistaken for the
 * other:
 *
 * - `deployed`: what code THIS server is actually running, read from
 *   build-time env (see `@/lib/deploy-identity`) — never a GitHub lookup, so
 *   it is correct even seconds after a release before GitHub's view of the
 *   branch has been re-fetched.
 * - `latestAvailable`: the head of the GitHub branch the caller tracks
 *   (`?branch=`, allowlisted — see `resolveVersionBranch`), used by runners to
 *   decide whether to self-update. A GitHub failure degrades this block to
 *   `commit: null, error: <message>` rather than 502ing the whole response or
 *   silently serving a stale cache — `tolerateStale: false` is what enforces
 *   the latter.
 *
 * `Cache-Control: no-store` so no CDN can serve a previous deploy's answer.
 */
export async function GET(req: NextRequest) {
  trackEvent('api.version.request', {
    userAgent: req.headers.get('user-agent'),
  });

  const branchParam = req.nextUrl.searchParams.get('branch');
  const deployed = { ...getDeployIdentity(), version: DEPLOYED_VERSION };

  let latestAvailable: {
    branch: string;
    commit: string | null;
    tag: string | null;
    checkedAt: string | null;
    error: string | null;
  };
  try {
    const info = await getLatestVersion(branchParam, { tolerateStale: false });
    latestAvailable = {
      branch: info.branch,
      commit: info.latestCommit,
      tag: info.latestTag,
      checkedAt: info.updatedAt,
      error: null,
    };
  } catch (err: any) {
    latestAvailable = {
      branch: resolveVersionBranch(branchParam),
      commit: null,
      tag: null,
      checkedAt: null,
      error: err?.message || 'Failed to fetch latest version',
    };
  }

  return NextResponse.json(
    { deployed, latestAvailable },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
