/**
 * Who is chatting, in which team, and may they chat at all. Shared by the
 * /api/chat routes.
 */

import type { NextRequest } from 'next/server';
import { and, asc, desc, eq, gte, inArray, max } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { missions, tasks, teams, workspaces } from '@buildd/core/db/schema';
import { resolveTimezone } from '@buildd/core/timezone';
import { isInferenceKeyPolicy } from '@buildd/core/inference-key-policy';
import { requireSessionUser, type CurrentUser } from '@/lib/auth-helpers';
import { getUserTeamIds, getUserTeamRole, resolveActiveTeamId } from '@/lib/team-access';
import type { TurnUser } from './turn';
import { isStandardWorkspace } from './reach';
import { workspaceHint, workspaceTerms, type RoutableWorkspace } from './routing';

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
    columns: { timezone: true, chatDailyBudgetUsd: true, chatUserDailyBudgetUsd: true, inferenceKeyPolicy: true },
  });
  return {
    timezone: team?.timezone ?? null,
    // NULL here means "not set": limits.resolveChatBudgets applies the defaults.
    dailyBudgetUsd: team?.chatDailyBudgetUsd != null ? Number(team.chatDailyBudgetUsd) : null,
    userDailyBudgetUsd: team?.chatUserDailyBudgetUsd != null ? Number(team.chatUserDailyBudgetUsd) : null,
    keyPolicy: isInferenceKeyPolicy(team?.inferenceKeyPolicy) ? team.inferenceKeyPolicy : null,
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
/** The mission this conversation filed most recently (docked when the request docks nothing). */
export async function linkedMissionFor(conversationId: string, teamId: string): Promise<string | null> {
  const [row] = await db.select({ id: missions.id })
    .from(missions)
    .where(and(eq(missions.conversationId, conversationId), eq(missions.teamId, teamId)))
    .orderBy(desc(missions.createdAt))
    .limit(1);
  return row?.id ?? null;
}

export async function linkMissionToConversation(missionId: string, conversationId: string, teamId: string) {
  await db.update(missions)
    .set({ conversationId })
    .where(and(eq(missions.id, missionId), eq(missions.teamId, teamId)));
}

/**
 * The workspaces an unpinned conversation's turn may be routed to: this team's,
 * in reach (never a sensitive one), with a hint of what each is about.
 */
export async function loadRoutableWorkspaces(teamId: string, inReach: ReadonlySet<string>): Promise<RoutableWorkspace[]> {
  if (inReach.size === 0) return [];
  const rows = await db.select({ id: workspaces.id, name: workspaces.name, repo: workspaces.repo, projects: workspaces.projects })
    .from(workspaces)
    .where(and(eq(workspaces.teamId, teamId), inArray(workspaces.id, [...inReach])))
    .orderBy(asc(workspaces.name));
  if (rows.length === 0) return [];
  // Latest task activity per workspace, so spanning reads skip idle ones. Best
  // effort: without it every workspace counts as active.
  const since = new Date(Date.now() - ACTIVITY_LOOKBACK_DAYS * 86_400_000);
  const activity = await db.select({ workspaceId: tasks.workspaceId, at: max(tasks.updatedAt) })
    .from(tasks)
    .where(and(inArray(tasks.workspaceId, rows.map(w => w.id)), gte(tasks.updatedAt, since)))
    .groupBy(tasks.workspaceId)
    .then(r => new Map(r.map(a => [a.workspaceId, a.at])))
    .catch(() => null);
  return rows.map(w => ({
    id: w.id, name: w.name, hint: workspaceHint(w), terms: workspaceTerms(w),
    ...(activity ? { lastActiveAt: activity.get(w.id)?.toISOString() ?? null } : {}),
  }));
}

/** How far back workspace activity is looked up; older reads as "no activity". */
const ACTIVITY_LOOKBACK_DAYS = 60;
