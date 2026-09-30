/**
 * POST /api/runner/github-token
 *
 * A short-lived GitHub App installation token scoped to ONE task's
 * repository, for the cloud runner's dispatcher (apps/cloud-runner). The
 * dispatcher's egress handler attaches it to the container's GitHub requests;
 * the container itself never receives it.
 *
 * Two credentials, both required:
 *   Authorization: Bearer <runner API key>   the account that claimed the task
 *   X-Buildd-Dispatch-Token: <token>         the workspace's webhookConfig.token
 * The container holds the API key (it needs it to claim and report) but never
 * the dispatch token, so the container cannot call this route for itself.
 *
 * Body: { taskId, workerId? }. Refused unless the task's workspace is one the
 * account may claim from, the dispatch token matches that workspace's enabled
 * webhook, and the task has a live worker owned by the calling account (and,
 * when workerId is given, it is that worker). Repo identity comes from the
 * workspace's github_repos link, never from the free-text workspaces.repo.
 *
 * The response also carries the task's workspaceId, which the dispatcher uses
 * to key its per-workspace snapshot store (Phase 2, warm repos).
 *
 * Design: docs/design/cloudflare-sandbox-runner.md, Components 4 and open question 1.
 */
import { NextRequest, NextResponse } from 'next/server';
import { createHash, timingSafeEqual } from 'crypto';
import { db } from '@buildd/core/db';
import { tasks, workers } from '@buildd/core/db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import { authenticateApiKey } from '@/lib/api-auth';
import { getAccountWorkspacePermissions } from '@/lib/account-workspace-cache';
import { LIVE_WORKER_STATUSES } from '@/lib/task-presentation';
import { isOpenWithinTeams } from '@/lib/open-workspaces';
import { mintRepoScopedInstallationToken } from '@/lib/github-scoped-token';

/** Mirrors DISPATCH_TOKEN_HEADER in apps/cloud-runner/src/outbound.ts. */
const DISPATCH_TOKEN_HEADER = 'x-buildd-dispatch-token';

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const NO_STORE = { 'Cache-Control': 'no-store' };

function fail(status: number, error: string) {
  return NextResponse.json({ error }, { status, headers: NO_STORE });
}

/** Constant-time over fixed-length digests, so neither length nor prefix leaks. */
function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

export async function POST(req: NextRequest) {
  const apiKey = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? null;
  const account = await authenticateApiKey(apiKey, req);
  if (!account) return fail(401, 'Unauthorized');
  if (account.level === 'trigger') return fail(403, 'Trigger tokens cannot request GitHub tokens');

  const dispatchToken = req.headers.get(DISPATCH_TOKEN_HEADER);
  if (!dispatchToken) return fail(401, 'Dispatch token required');

  let body: { taskId?: unknown; workerId?: unknown };
  try {
    body = await req.json();
  } catch {
    return fail(400, 'Invalid JSON body');
  }
  const { taskId, workerId } = body ?? {};
  if (typeof taskId !== 'string' || !ID_RE.test(taskId)) return fail(400, 'taskId is required');
  if (workerId !== undefined && (typeof workerId !== 'string' || !ID_RE.test(workerId))) {
    return fail(400, 'workerId must be an id');
  }

  const task = await db.query.tasks.findFirst({
    where: eq(tasks.id, taskId),
    columns: { id: true, workspaceId: true },
    with: {
      workspace: {
        columns: { id: true, teamId: true, accessMode: true, webhookConfig: true, githubRepoId: true },
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
  const ws = task?.workspace;
  // Every "not yours" answer is the same 404, so the route does not confirm
  // which task ids exist in other teams.
  if (!task || !ws || task.workspaceId !== ws.id) return fail(404, 'Task not found');

  // Same claim authority the claim route applies: an open workspace of the
  // account's own team, or an explicit canClaim link.
  const ownOpen = !!account.teamId && isOpenWithinTeams(ws, [account.teamId]);
  if (!ownOpen) {
    const perms = await getAccountWorkspacePermissions(account.id);
    if (!perms.some(p => p.workspaceId === ws.id && p.canClaim)) return fail(404, 'Task not found');
  }

  const hook = ws.webhookConfig;
  if (!hook || !hook.enabled || typeof hook.token !== 'string' || hook.token.length === 0 || !safeEqual(hook.token, dispatchToken)) {
    return fail(403, 'Dispatch token does not match this workspace');
  }

  const liveWorkers = await db.query.workers.findMany({
    where: and(eq(workers.taskId, taskId), inArray(workers.status, [...LIVE_WORKER_STATUSES])),
    columns: { id: true, accountId: true, workspaceId: true, status: true, taskId: true },
  });
  // Re-checked here rather than trusted to the query, so the rule is visible
  // and tested: live, on this task and workspace, claimed by THIS account.
  const live = new Set<string>(LIVE_WORKER_STATUSES);
  const mine = liveWorkers.filter(w =>
    w.taskId === taskId &&
    w.workspaceId === ws.id &&
    w.accountId === account.id &&
    live.has(w.status) &&
    (workerId === undefined || w.id === workerId));
  if (mine.length === 0) return fail(409, 'Task has no live worker claimed by this account');

  const repo = ws.githubRepo;
  if (!ws.githubRepoId || !repo || repo.id !== ws.githubRepoId || !repo.installation) {
    return fail(409, 'Workspace has no linked GitHub repository');
  }
  if (repo.installation.suspendedAt) return fail(409, 'GitHub App installation is suspended');

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
      // Keys the cloud runner's per-workspace snapshot store (warm repos). It
      // comes from here, authenticated by the dispatch token, so neither the
      // container nor the webhook body chooses it.
      workspaceId: ws.id,
    }, { headers: NO_STORE });
  } catch (err) {
    console.error(`[github-token] mint failed for task ${taskId}:`, err instanceof Error ? err.message : String(err));
    return fail(502, 'Could not mint a GitHub token');
  }
}
