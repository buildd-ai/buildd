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
 * to key its per-workspace snapshot store (Phase 2, warm repos), and, when the
 * workspace sets one, its warm snapshot cap (lib/warm-snapshot-cap.ts).
 *
 * The checks are the agent-run principal's (lib/agent-capabilities): this route
 * parses the request and shapes the response.
 *
 * Design: docs/design/cloudflare-sandbox-runner.md, Components 4 and open question 1.
 */
import { NextRequest, NextResponse } from 'next/server';
import { authenticateApiKey } from '@/lib/api-auth';
import { resolveDispatchPrincipal } from '@/lib/agent-capabilities/dispatch-principal';
import { authorizeGithubRepoGrant, mintGithubRepoGrant, repoProtectedBranches } from '@/lib/agent-capabilities/github';
import { recordCapabilityDecision } from '@/lib/agent-capabilities/audit';
import { resolveWarmSnapshotMaxBytes } from '@/lib/warm-snapshot-cap';

/** Mirrors DISPATCH_TOKEN_HEADER in apps/cloud-runner/src/outbound.ts. */
const DISPATCH_TOKEN_HEADER = 'x-buildd-dispatch-token';

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const NO_STORE = { 'Cache-Control': 'no-store' };

function fail(status: number, error: string) {
  return NextResponse.json({ error }, { status, headers: NO_STORE });
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

  const resolved = await resolveDispatchPrincipal(account, { taskId, workerId, dispatchToken });
  if (!resolved.ok) {
    void recordCapabilityDecision({ capability: 'github.repo_grant', decision: 'refused', accountId: account.id, principalVia: 'dispatch', resource: `task:${taskId}`, reasonCode: resolved.reasonCode });
    return fail(resolved.status, resolved.error);
  }
  const ws = resolved.workspace;
  const p = resolved.principal;
  const audit = { capability: 'github.repo_grant' as const, workspaceId: p.workspaceId, taskId: p.taskId, workerId: p.workerId, accountId: p.accountId, principalVia: p.via };

  const decision = authorizeGithubRepoGrant(resolved.principal, ws);
  if (!decision.allowed) {
    void recordCapabilityDecision({ ...audit, decision: 'refused', reasonCode: decision.reasonCode });
    return fail(decision.status, decision.error);
  }

  try {
    const minted = await mintGithubRepoGrant(decision);
    // Branches the cloud egress merge guard (apps/cloud-runner/src/outbound.ts
    // pushedProtectedBranch) must refuse a direct `git push` to.
    const protectedBranches = repoProtectedBranches(ws, ws.githubRepo?.defaultBranch);
    void recordCapabilityDecision({ ...audit, decision: 'allowed', resource: `github_repo:${decision.resource.id}`, expiresAt: minted.expiresAt });
    // The workspace's warm snapshot cap (gitConfig.warmSnapshot.maxBytes,
    // bounded here). Absent: the dispatcher's own default applies.
    const warmSnapshotMaxBytes = resolveWarmSnapshotMaxBytes(ws.gitConfig);
    return NextResponse.json({
      token: minted.token,
      expiresAt: minted.expiresAt.toISOString(),
      repository: { owner: decision.repo.owner, name: decision.repo.name, fullName: decision.repo.fullName },
      // Keys the cloud runner's per-workspace snapshot store (warm repos). It
      // comes from here, authenticated by the dispatch token, so neither the
      // container nor the webhook body chooses it.
      workspaceId: ws.id,
      protectedBranches,
      ...(warmSnapshotMaxBytes !== null ? { warmSnapshotMaxBytes } : {}),
    }, { headers: NO_STORE });
  } catch (err) {
    void recordCapabilityDecision({ ...audit, decision: 'refused', resource: `github_repo:${decision.resource.id}`, reasonCode: 'mint_failed' });
    console.error(`[github-token] mint failed for task ${taskId}:`, err instanceof Error ? err.message : String(err));
    return fail(502, 'Could not mint a GitHub token');
  }
}
