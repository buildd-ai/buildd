/**
 * What the chat pages load besides the conversation: who the agent is (the
 * Organizer role's own name and colour), and the context panel — what needs
 * this person and the team's live missions. One parallel round.
 */
import { and, desc, eq, inArray, or } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { missions, tasks, workers, workspaceSkills } from '@buildd/core/db/schema';
import { loadFleetCapacity } from '@/lib/home-fleet';
import type { ChatAgent } from '@/components/chat/ChatFeed';
import type { ContextMission, ContextNeedsYou } from '@/components/chat/ChatContextPanel';

export interface ChatPageContext {
  agent: ChatAgent;
  needsYou: ContextNeedsYou[];
  missions: ContextMission[];
  fleet: { live: number; capacity: number } | null;
}

const LIVE = ['running', 'starting', 'waiting_input'];

/** A mission row → the panel's words. Pure. */
export function contextMission(m: { id: string; title: string; status: string; conversationId?: string | null }): ContextMission {
  const tone: ContextMission['tone'] = m.status === 'paused' ? 'attention' : m.status === 'active' ? 'live' : 'idle';
  return {
    id: m.id,
    title: m.title,
    state: m.status === 'paused' ? 'held' : m.status,
    meta: m.conversationId ? 'filed from chat' : null,
    tone,
  };
}

export async function loadChatPageContext(input: { teamId: string; wsIds: string[]; now?: number }): Promise<ChatPageContext> {
  const { teamId, wsIds } = input;
  const now = input.now ?? Date.now();
  if (wsIds.length === 0) {
    return { agent: { name: 'Organizer', color: null }, needsYou: [], missions: [], fleet: null };
  }
  const [role, missionRows, waiting, liveRows, capacity] = await Promise.all([
    db.query.workspaceSkills.findFirst({
      // Roles are team-level (seedDefaultRolesForTeam) or per workspace.
      where: and(or(eq(workspaceSkills.teamId, teamId), inArray(workspaceSkills.workspaceId, wsIds)), eq(workspaceSkills.slug, 'organizer')),
      columns: { name: true, color: true },
    }).catch(() => null),
    db.query.missions.findMany({
      where: and(eq(missions.teamId, teamId), inArray(missions.status, ['active', 'paused'])),
      columns: { id: true, title: true, status: true, conversationId: true },
      orderBy: [desc(missions.updatedAt)],
      limit: 4,
    }).catch(() => []),
    db
      .select({ workerId: workers.id, taskId: tasks.id, title: tasks.title, missionTitle: missions.title })
      .from(workers)
      .innerJoin(tasks, eq(tasks.id, workers.taskId))
      .leftJoin(missions, eq(missions.id, tasks.missionId))
      .where(and(inArray(workers.workspaceId, wsIds), eq(workers.status, 'waiting_input')))
      .orderBy(desc(workers.updatedAt))
      .limit(5)
      .catch(() => []),
    db.select({ id: workers.id }).from(workers)
      .where(and(inArray(workers.workspaceId, wsIds), inArray(workers.status, LIVE)))
      .limit(200)
      .catch(() => []),
    loadFleetCapacity({ teamId, wsIds, now }).catch(() => 0),
  ]);
  return {
    agent: { name: role?.name || 'Organizer', color: role?.color ?? null },
    needsYou: waiting.map(w => ({
      id: w.workerId,
      title: w.title,
      href: `/app/tasks/${w.taskId}/respond`,
      meta: w.missionTitle ?? null,
    })),
    missions: missionRows.map(contextMission),
    fleet: capacity > 0 ? { live: liveRows.length, capacity } : null,
  };
}
