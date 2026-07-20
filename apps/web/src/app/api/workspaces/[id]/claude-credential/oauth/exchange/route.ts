import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth-helpers';
import { verifyWorkspaceAccess, getUserTeamIds } from '@/lib/team-access';
import { exchangeClaudeOAuthCode } from '@/lib/claude-oauth-login';
import { storeClaudeCredential, getClaudeStatus, type ClaudeScope } from '@/lib/claude-credential';
import { requeueAuthFailedTasks } from '@/lib/credential-recovery';

type RouteContext = { params: Promise<{ id: string }> };

function buildScope(teamId: string, workspaceId: string, scopeParam: string | null): ClaudeScope {
  return scopeParam === 'workspace' ? { teamId, workspaceId } : { teamId };
}

// POST /api/workspaces/[id]/claude-credential/oauth/exchange
// Body: { code, verifier, state, scope?: 'team' | 'workspace' }
// Exchanges the pasted authorization code, stores the buildd-owned claude_credential,
// and requeues auth-failed tasks.
export async function POST(req: NextRequest, { params }: RouteContext) {
  const { id } = await params;

  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const access = await verifyWorkspaceAccess(user.id, id);
  if (!access) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const { code, verifier, state, scope: scopeParam } = body as { code?: string; verifier?: string; state?: string; scope?: string };
  if (!code || !verifier) {
    return NextResponse.json({ error: 'code and verifier are required' }, { status: 400 });
  }

  const result = await exchangeClaudeOAuthCode(code, verifier, typeof state === 'string' ? state : '');
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  // All-teams fan-out: one approval → store the same credential team-wide to every
  // team the caller manages (parity with the paste flow's "All my teams").
  if (scopeParam === 'all_teams') {
    const teamIds = await getUserTeamIds(user.id);
    let stored = 0;
    for (const tid of teamIds) {
      try {
        await storeClaudeCredential({ teamId: tid }, result.credential);
        await requeueAuthFailedTasks(tid).catch(() => {});
        stored++;
      } catch (err) {
        console.warn(`[claude-oauth] fan-out store failed for team ${tid}:`, err);
      }
    }
    return NextResponse.json({ status: 'connected', teams: stored, totalTeams: teamIds.length });
  }

  const scope = buildScope(access.teamId, id, typeof scopeParam === 'string' ? scopeParam : null);
  await storeClaudeCredential(scope, result.credential);
  try {
    await requeueAuthFailedTasks(access.teamId);
  } catch (err) {
    console.warn('[claude-oauth] requeue-on-recovery failed (non-fatal):', err);
  }
  const status = await getClaudeStatus(scope);
  return NextResponse.json({ status: 'connected', ...status });
}
