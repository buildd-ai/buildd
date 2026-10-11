import { NextResponse } from 'next/server';
import { can } from '@/lib/permissions';

export const TEAM_CREDENTIALS_FORBIDDEN = 'You do not have permission to manage team or workspace credentials.';

/**
 * Connecting, replacing or removing a workspace's team-wide or workspace-wide
 * agent credential (Claude, Codex) takes `manage_team_credentials` in the
 * workspace's team. Returns the 403 to send, or null when the user may proceed.
 * Call it after workspace access is verified, so a stranger still gets 404.
 */
export async function refuseWithoutTeamCredentialAccess(userId: string, teamId: string): Promise<NextResponse | null> {
  if (await can({ kind: 'user', userId }, 'manage_team_credentials', teamId)) return null;
  return NextResponse.json({ error: TEAM_CREDENTIALS_FORBIDDEN }, { status: 403 });
}
