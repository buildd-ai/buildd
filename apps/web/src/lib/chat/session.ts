/**
 * Who is chatting, in which team, and may they chat at all. Shared by the
 * /api/chat routes.
 */

import type { NextRequest } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { missions, teams, workspaces } from '@buildd/core/db/schema';
import { isInferenceEnabled } from '@buildd/core/inference-policy';
import { resolveTimezone } from '@buildd/core/timezone';
import type { ChatAvailabilityResponse } from '@buildd/shared';
import { requireSessionUser, type CurrentUser } from '@/lib/auth-helpers';
import { getUserTeamIds, getUserTeamRole, resolveActiveTeamId } from '@/lib/team-access';
import { resolveChatModel } from './models';
import { FALLBACK_TIER } from './routing';
import type { TurnUser } from './turn';
import { isStandardWorkspace } from './reach';

export type ChatCaller = { user: CurrentUser; teamIds: string[] };

export async function requireChatCaller(req: NextRequest): Promise<{ caller: ChatCaller } | { response: Response }> {
  const s = await requireSessionUser(req);
  if (s.response) return { response: s.response };
  const teamIds = await getUserTeamIds(s.user.id);
  if (teamIds.length === 0) return { response: Response.json({ error: 'No team found' }, { status: 403 }) };
  return { caller: { user: s.user, teamIds } };
}

export async function resolveChatTeam(req: NextRequest, caller: ChatCaller, requested?: string | null): Promise<string | null> {
  const teamId = requested || await resolveActiveTeamId(caller.user.id, req.cookies.get('buildd-team')?.value ?? null);
  return teamId && caller.teamIds.includes(teamId) ? teamId : null;
}

export async function loadTeamChatSettings(teamId: string) {
  const team = await db.query.teams.findFirst({
    where: eq(teams.id, teamId),
    columns: { enabledInferenceCapabilities: true, timezone: true, chatDailyBudgetUsd: true },
  });
  return {
    chatEnabled: isInferenceEnabled('chat', team?.enabledInferenceCapabilities ?? null),
    timezone: team?.timezone ?? null,
    dailyBudgetUsd: team?.chatDailyBudgetUsd != null ? Number(team.chatDailyBudgetUsd) : null,
  };
}

export async function turnUserFor(user: CurrentUser, teamId: string, teamTimezone: string | null): Promise<TurnUser> {
  const role = (await getUserTeamRole(user.id, teamId)) ?? 'member';
  return {
    id: user.id,
    name: user.name,
    teamRole: role,
    timeZone: resolveTimezone(user.timezone, teamTimezone),
  };
}

/**
 * Should the UI show a Chat entry point for this user in this team? Only when
 * the capability is on AND a key resolves for the default tier — so a team
 * with chat off, or with no key, sees nothing change.
 */
export async function chatAvailability(teamId: string, userId: string, role: string | null): Promise<ChatAvailabilityResponse> {
  const canManageTeamKeys = role === 'owner' || role === 'admin';
  const settings = await loadTeamChatSettings(teamId);
  if (!settings.chatEnabled) return { available: false, reason: 'capability_disabled', canManageTeamKeys };
  const model = await resolveChatModel({ tier: FALLBACK_TIER, teamId, workspaceId: null, userId });
  if (!model.ok) return { available: false, reason: 'no_key', canManageTeamKeys };
  return { available: true, reason: null, canManageTeamKeys };
}

/**
 * A sensitive workspace's task text never leaves the platform (the same rule
 * the decision shadow follows), and a chat turn sends tool output to a model
 * provider. So such a workspace can't be a conversation's default scope.
 * Fails closed.
 */
export async function isSensitiveWorkspace(workspaceId: string): Promise<boolean> {
  try {
    const ws = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, workspaceId),
      columns: { dataClass: true, gitConfig: true },
    });
    return !ws || !isStandardWorkspace(ws);
  } catch {
    return true;
  }
}

export async function workspaceForConversation(workspaceId: string | null, teamId: string) {
  if (!workspaceId) return null;
  const ws = await db.query.workspaces.findFirst({
    where: and(eq(workspaces.id, workspaceId), eq(workspaces.teamId, teamId)),
    columns: { id: true, name: true },
  });
  return ws ?? null;
}

/** Record which conversation a mission was filed from, within the team. */
export async function linkMissionToConversation(missionId: string, conversationId: string, teamId: string) {
  await db.update(missions)
    .set({ conversationId })
    .where(and(eq(missions.id, missionId), eq(missions.teamId, teamId)));
}
