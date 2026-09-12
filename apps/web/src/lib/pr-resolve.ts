import { db } from '@buildd/core/db';
import { workers, workspaces } from '@buildd/core/db/schema';
import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { getTeamWorkspaceIds, getUserWorkspaceIds } from '@/lib/team-access';

/**
 * Resolve a worker by PR number across the account's accessible workspaces.
 *
 * Extracted from `GET/PUT /api/github/pr` so `get_pr` and `explain` cannot
 * drift: a second resolver would eventually disagree about which workspaces a
 * team can see, about whether a repo name is an acceptable `workspaceId`, and
 * about what an ambiguous PR number means — and the two answers would be
 * rendered with equal confidence, which is the exact failure `explain` exists
 * to stop.
 *
 * Returns the worker row (with its workspace) or an error descriptor.
 * Callers discriminate on `typeof resolved.status === 'number'`: an error
 * descriptor carries a numeric HTTP status, while a Drizzle worker row carries
 * `status` as a text column (`'idle'`, `'running'`, …).
 */
export async function resolveWorkerByPrNumber(
  account: { teamId: string },
  prNumber: number,
  workspaceId: string | null | undefined,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<{ error: string; status: number; candidates?: string[] } | Record<string, any>> {
  const wsIds = await getTeamWorkspaceIds(account.teamId);
  if (wsIds.length === 0) {
    return { error: 'No workspaces found for account', status: 403 };
  }

  // Resolve workspaceId to a UUID — callers may pass a repo name (e.g. "sibling-app")
  // rather than a UUID. wsIds only contains UUIDs, so a direct includes() check
  // misses name-based inputs and silently falls back to searching all workspaces.
  let narrowedWsId: string | null = null;
  if (workspaceId) {
    if (wsIds.includes(workspaceId)) {
      narrowedWsId = workspaceId;
    } else {
      const allWs = await db.query.workspaces.findMany({
        where: inArray(workspaces.id, wsIds),
        columns: { id: true, name: true, repo: true },
      });
      const lower = workspaceId.toLowerCase();
      const match = allWs.find(ws =>
        ws.name.toLowerCase() === lower ||
        ws.repo?.toLowerCase() === lower ||
        ws.repo?.toLowerCase().endsWith('/' + lower)
      );
      if (match) narrowedWsId = match.id;
    }
    // A supplied workspaceId that resolves to nothing (typo, or a workspace the
    // caller can't access) must reject — falling back to wsIds here would silently
    // widen the search back to every accessible workspace instead of disambiguating.
    if (!narrowedWsId) {
      return { error: `Workspace "${workspaceId}" not found or not accessible`, status: 404 };
    }
  }

  const searchIds = narrowedWsId ? [narrowedWsId] : wsIds;

  const matchingWorkers = await db.query.workers.findMany({
    where: and(
      inArray(workers.workspaceId, searchIds),
      eq(workers.prNumber, prNumber),
      isNotNull(workers.prUrl),
    ),
    with: { workspace: true },
  });

  if (matchingWorkers.length === 0) {
    return { error: 'PR not found', status: 404 };
  }

  const distinctWorkspaceIds = new Set(matchingWorkers.map((w) => w.workspaceId));
  if (distinctWorkspaceIds.size > 1) {
    return {
      error: `PR #${prNumber} exists in multiple workspaces — pass workspaceId to disambiguate`,
      status: 409,
      candidates: [...distinctWorkspaceIds],
    };
  }

  return matchingWorkers[0];
}

/**
 * Resolve a still-open (unmerged) worker by PR number, scoped to a web-session
 * user's accessible workspaces — the auth model `/api/prs/[prNumber]/merge`
 * and `/api/prs/[prNumber]/apply-recommendation` both run under (session
 * cookie, `getUserWorkspaceIds`), distinct from `resolveWorkerByPrNumber`
 * above (account/teamId, MCP callers). Same workspaceId-disambiguation and
 * ambiguous-PR handling as that resolver; kept separate rather than
 * parameterizing one function over two different workspace-id sources.
 */
export async function resolveOpenWorkerForUser(
  userId: string,
  prNumber: number,
  workspaceId: string | null | undefined,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<{ error: string; status: number; candidates?: string[] } | Record<string, any>> {
  const wsIds = await getUserWorkspaceIds(userId);
  if (wsIds.length === 0) {
    return { error: 'No workspaces found', status: 403 };
  }

  let narrowedWsId: string | null = null;
  if (workspaceId) {
    if (wsIds.includes(workspaceId)) {
      narrowedWsId = workspaceId;
    } else {
      const allWs = await db.query.workspaces.findMany({
        where: inArray(workspaces.id, wsIds),
        columns: { id: true, name: true, repo: true },
      });
      const lower = workspaceId.toLowerCase();
      const match = allWs.find(ws =>
        ws.name.toLowerCase() === lower ||
        ws.repo?.toLowerCase() === lower ||
        ws.repo?.toLowerCase().endsWith('/' + lower)
      );
      if (match) narrowedWsId = match.id;
    }
    if (!narrowedWsId) {
      return { error: `Workspace "${workspaceId}" not found or not accessible`, status: 403 };
    }
  }

  const searchIds = narrowedWsId ? [narrowedWsId] : wsIds;

  const matchingWorkers = await db.query.workers.findMany({
    where: and(
      inArray(workers.workspaceId, searchIds),
      eq(workers.prNumber, prNumber),
      isNotNull(workers.prUrl),
      isNull(workers.mergedAt),
    ),
    with: { task: true },
  });

  if (matchingWorkers.length === 0) {
    return { error: 'PR not found or already merged', status: 404 };
  }

  const distinctWorkspaceIds = new Set(matchingWorkers.map((w) => w.workspaceId));
  if (distinctWorkspaceIds.size > 1) {
    return {
      error: `PR #${prNumber} exists in multiple workspaces — pass workspaceId to disambiguate`,
      status: 409,
      candidates: [...distinctWorkspaceIds],
    };
  }

  return matchingWorkers[0];
}
