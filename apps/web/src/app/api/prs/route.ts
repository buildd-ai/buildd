import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateTaskScopedCaller, taskScopeAllowsWorkspace } from '@/lib/task-token-auth';
import { listReachableWorkspaceIds } from '@/lib/workspace-access';
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

  // Task-token reach comes from its bound workspace, as in explain/get_pr,
  // without depending on an account-wide listing that may omit it or fail.
  // Other callers use their team's open workspaces plus links, or user teams.
  // A requested workspace outside reach lists nothing.
  let workspaceIds = apiAccount?.taskScope
    ? [apiAccount.taskScope.workspaceId]
    : await listReachableWorkspaceIds(apiAccount ? { account: apiAccount } : { userId: user!.id });
  if (apiAccount) workspaceIds = workspaceIds.filter(id => taskScopeAllowsWorkspace(apiAccount, id));
  const requested = sp.get('workspaceId');
  if (requested) workspaceIds = workspaceIds.filter(id => id === requested);

  const sinceDays = Number(sp.get('sinceDays'));
  const days = Number.isFinite(sinceDays) && sinceDays > 0 ? Math.min(sinceDays, 90) : DEFAULT_MERGED_WINDOW_DAYS;
  const since = parsed.state === 'merged' ? new Date(Date.now() - days * 864e5) : undefined;
  const limit = Number(sp.get('limit'));

  let prs;
  try {
    prs = await listPrsQuery({
      workspaceIds,
      state: parsed.state,
      ...(since ? { since } : {}),
      ...(Number.isInteger(limit) && limit > 0 ? { limit } : {}),
    });
  } catch (err) {
    // An unhandled throw reaches the MCP client as `API error: 500 -`, an empty body.
    const message = err instanceof Error ? err.message : String(err);
    console.error('[api/prs] list failed:', err);
    return NextResponse.json({ error: `list_prs failed: ${message}`, state: parsed.state }, { status: 500 });
  }

  return NextResponse.json({ state: parsed.state, workspaceCount: workspaceIds.length, ...(since ? { sinceDays: days } : {}), prs });
}
