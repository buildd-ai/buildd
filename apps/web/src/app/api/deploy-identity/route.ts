import { NextResponse } from 'next/server';

/**
 * GET /api/deploy-identity
 *
 * Public endpoint (no auth) — answers what code is actually RUNNING right
 * now, read from the platform's own build-time environment. No database
 * access on this path: it must keep answering while the database is
 * unreachable, since "is the right code deployed" is precisely the question
 * asked when something else is broken.
 *
 * Distinct from /api/version, which reports the default branch's head in the
 * git repository (a different question, with a live consumer in the runner's
 * poll loop) — that endpoint is untouched by this one.
 */
export async function GET() {
  return NextResponse.json({
    sha: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
    environment: process.env.VERCEL_ENV ?? null,
    deploymentId: process.env.VERCEL_DEPLOYMENT_ID ?? null,
  });
}
