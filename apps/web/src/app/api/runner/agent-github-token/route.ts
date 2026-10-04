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
import { db } from '@buildd/core/db';
import { workers } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { authenticateApiKey } from '@/lib/api-auth';
import { tokenWorkspaceAllowed } from '@buildd/core/token-scopes';
import { getAccountWorkspacePermissions } from '@/lib/account-workspace-cache';
import { LIVE_WORKER_STATUSES } from '@/lib/task-presentation';
import { isOpenWithinTeams } from '@/lib/open-workspaces';
import { mintRepoScopedInstallationToken } from '@/lib/github-scoped-token';

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const NO_STORE = { 'Cache-Control': 'no-store' };
const LIVE = new Set<string>(LIVE_WORKER_STATUSES);

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

  const worker = await db.query.workers.findFirst({
    where: eq(workers.id, workerId),
    columns: { id: true, taskId: true, workspaceId: true, accountId: true, status: true },
    with: {
      workspace: {
        columns: { id: true, teamId: true, accessMode: true, githubRepoId: true },
        with: {
          githubRepo: {
            columns: { id: true, repoId: true, owner: true, name: true, fullName: true },
            with: {
              installation: { columns: { installationId: true, suspendedAt: true, permissions: true } },
            },
          },
        },
      },
    },
  });
  const ws = worker?.workspace;
  // Every "not yours" answer is the same 404, so the route does not confirm
  // which worker ids exist for other accounts.
  if (!worker || !ws || worker.workspaceId !== ws.id || worker.accountId !== account.id) {
    return fail(404, 'Worker not found');
  }

  // Claim authority is re-checked, not assumed from the claim: access revoked
  // mid-session stops the next refresh.
  if (!tokenWorkspaceAllowed(account.workspaceIds, ws.id)) return fail(404, 'Worker not found');
  const ownOpen = !!account.teamId && isOpenWithinTeams(ws, [account.teamId]);
  if (!ownOpen) {
    const perms = await getAccountWorkspacePermissions(account.id);
    if (!perms.some(p => p.workspaceId === ws.id && p.canClaim)) return fail(404, 'Worker not found');
  }

  if (!worker.taskId || !LIVE.has(worker.status)) return fail(409, 'Worker is not live', 'worker_not_live');

  const repo = ws.githubRepo;
  if (!ws.githubRepoId || !repo || repo.id !== ws.githubRepoId || !repo.installation) {
    return fail(409, 'Workspace has no linked GitHub repository', 'no_linked_repo');
  }
  if (repo.installation.suspendedAt) return fail(409, 'GitHub App installation is suspended', 'installation_suspended');

  try {
    const minted = await mintRepoScopedInstallationToken({
      installationId: repo.installation.installationId,
      repoId: repo.repoId,
      installedPermissions: repo.installation.permissions,
    });
    return NextResponse.json({
      token: minted.token,
      expiresAt: minted.expiresAt.toISOString(),
      repository: { owner: repo.owner, name: repo.name, fullName: repo.fullName },
    }, { headers: NO_STORE });
  } catch (err) {
    console.error(`[agent-github-token] mint failed for worker ${workerId}:`, err instanceof Error ? err.message : String(err));
    return fail(502, 'Could not mint a GitHub token', 'mint_failed');
  }
}
