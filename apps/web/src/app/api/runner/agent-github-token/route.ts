/**
 * POST /api/runner/agent-github-token
 *
 * A short-lived GitHub App installation token scoped to ONE task's
 * repository, for an agent on a self-hosted runner
 * (@buildd/core/agent-github-credentials). The runner calls it when the claim
 * carries `githubCredentials.mode = 'scoped'`, writes the token where the
 * agent's git and gh read it, and calls again before it expires.
 *
 *   Authorization: Bearer <runner API key>   the account that claimed the worker
 *   Body: { workerId }
 *
 * Refused unless the worker exists, was claimed by the calling account, is
 * still live, and its workspace is one the account may still claim from. Repo
 * identity comes from the workspace's github_repos link, never from the
 * request: anything else in the body is ignored.
 *
 * The cloud runner's counterpart is /api/runner/github-token, which also
 * requires the dispatch token because the container holds the API key.
 */
import { NextRequest, NextResponse } from 'next/server';
import { authenticateApiKey } from '@/lib/api-auth';
import { resolveWorkerPrincipal } from '@/lib/agent-capabilities/worker-principal';
import { authorizeGithubRepoGrant, mintGithubRepoGrant } from '@/lib/agent-capabilities/github';

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const NO_STORE = { 'Cache-Control': 'no-store' };

/** `code` lets the runner tell the operator what to fix without parsing prose. */
function fail(status: number, error: string, code?: string) {
  return NextResponse.json(code ? { error, code } : { error }, { status, headers: NO_STORE });
}

export async function POST(req: NextRequest) {
  const apiKey = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? null;
  const account = await authenticateApiKey(apiKey, req);
  if (!account) return fail(401, 'Unauthorized');
  if (account.level === 'trigger') return fail(403, 'Trigger tokens cannot request GitHub tokens');

  let body: { workerId?: unknown };
  try {
    body = await req.json();
  } catch {
    return fail(400, 'Invalid JSON body');
  }
  const workerId = body?.workerId;
  if (typeof workerId !== 'string' || !ID_RE.test(workerId)) return fail(400, 'workerId is required');

  // Claim authority is re-checked, not assumed from the claim: access revoked
  // mid-session stops the next refresh.
  const resolved = await resolveWorkerPrincipal(account, { workerId });
  if (!resolved.ok) return fail(resolved.status, resolved.error, resolved.status === 409 ? resolved.reasonCode : undefined);

  const decision = authorizeGithubRepoGrant(resolved.principal, resolved.workspace);
  if (!decision.allowed) return fail(decision.status, decision.error, decision.reasonCode);

  try {
    const minted = await mintGithubRepoGrant(decision);
    return NextResponse.json({
      token: minted.token,
      expiresAt: minted.expiresAt.toISOString(),
      repository: { owner: decision.repo.owner, name: decision.repo.name, fullName: decision.repo.fullName },
    }, { headers: NO_STORE });
  } catch (err) {
    console.error(`[agent-github-token] mint failed for worker ${workerId}:`, err instanceof Error ? err.message : String(err));
    return fail(502, 'Could not mint a GitHub token', 'mint_failed');
  }
}
