import { NextRequest, NextResponse, after } from 'next/server';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateTaskScopedCaller, taskScopeAllowsWorkspace } from '@/lib/task-token-auth';
import { listReachableWorkspaceIds } from '@/lib/workspace-access';
import { refreshStaleWorkersForWorkspaces } from '@/lib/pr-state-refresh';
import { DEFAULT_MERGED_WINDOW_DAYS, listPrsQuery, parsePrListState } from '@/lib/pr-list';

/**
 * GET /api/prs?workspaceId=&state=open|attention|conflict|ci_failed|merged&sinceDays=&limit=
 *
 * PRs buildd opened or adopted, across the caller's reachable workspaces (or
 * one of them), one row per PR, with what needs a person and what an agent
 * is already on (lib/pr-list.ts prSignals). Default `open`, what needs you
 * first. `attention`: conflicts, red CI and PRs waiting on you. `merged`: the
 * last `sinceDays` (default 7). Closed PRs are never listed. Backs the
 * `list_prs` MCP action and chat tool.
 */
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  // A per-task token lists PRs only in its own task's workspace.
  const apiAccount = await authenticateTaskScopedCaller(authHeader?.replace('Bearer ', '') || null, req);
  const user = apiAccount ? null : await getCurrentUser();
  if (!apiAccount && !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const sp = req.nextUrl.searchParams;
  const parsed = parsePrListState(sp.get('state'));
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });

  // Same reach rule as the task list: an account's team's open workspaces plus
  // its links, or a user's teams' workspaces. A requested workspace outside it
  // lists nothing, without saying whether it exists.
  let workspaceIds = await listReachableWorkspaceIds(apiAccount ? { account: apiAccount } : { userId: user!.id });
  if (apiAccount) workspaceIds = workspaceIds.filter(id => taskScopeAllowsWorkspace(apiAccount, id));
  const requested = sp.get('workspaceId');
  if (requested) workspaceIds = workspaceIds.filter(id => id === requested);

  const sinceDays = Number(sp.get('sinceDays'));
  const days = Number.isFinite(sinceDays) && sinceDays > 0 ? Math.min(sinceDays, 90) : DEFAULT_MERGED_WINDOW_DAYS;
  const since = parsed.state === 'merged' ? new Date(Date.now() - days * 864e5) : undefined;
  const limit = Number(sp.get('limit'));

  const prs = await listPrsQuery({
    workspaceIds,
    state: parsed.state,
    ...(since ? { since } : {}),
    ...(Number.isInteger(limit) && limit > 0 ? { limit } : {}),
  });

  // The webhook is lossy: heal stale PR state so the next read is right.
  if (workspaceIds.length > 0) {
    after(() => refreshStaleWorkersForWorkspaces(workspaceIds).catch(err => console.error('[pr-state-refresh] pr list refresh failed:', err)));
  }

  return NextResponse.json({ state: parsed.state, workspaceCount: workspaceIds.length, ...(since ? { sinceDays: days } : {}), prs });
}
