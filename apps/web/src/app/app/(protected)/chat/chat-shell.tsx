/**
 * Server pieces both chat pages share: resolve the person, team, chat
 * availability, the page context and the conversation list in one round,
 * and the fallback when chat isn't available (no Chat entry, the setup card,
 * the mission form one tap away).
 */
import Link from 'next/link';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserTeamRole, resolveActiveTeamScope } from '@/lib/team-access';
import { getChatAvailability } from '@/lib/chat-availability';
import { listConversations, type ConversationListItem } from '@/lib/chat/conversations';
import { loadChatPageContext, NEEDS_YOU_LIMIT, type ChatPageContext } from '@/lib/chat/chat-page-data';
import { pulseNeedsYou, type CanvasPulse } from '@/components/chat/canvas-empty';
import ChatSetupCard from '@/components/chat/ChatSetupCard';
import ConnectOwnKeyCard from '@/components/onboarding/ConnectOwnKeyCard';
import ConversationListView from '@/components/chat/ConversationList';
import { homeAudience } from '../home/home-view';
import { isUuid } from '@/lib/uuid';
import type { BuilddObjectRef } from '@/components/chat/chat-contract';
import { eq } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { missions, tasks } from '@buildd/core/db/schema';
import type { ChatAbout } from '@/lib/chat/entry-points';
import { getTeamPermissionOverrides } from '@/lib/permissions';

export interface ChatShellData {
  user: { id: string; name: string | null; email: string | null };
  teamId: string;
  teamName: string | null;
  workspaces: Array<{ id: string; name: string }>;
  available: boolean;
  reason: 'no_key' | 'budget_exhausted' | 'rate_limited' | null;
  canManageTeamKeys: boolean;
  audience: 'member' | 'operator';
  context: ChatPageContext;
  conversations: ConversationListItem[];
}

export async function loadChatShell(): Promise<ChatShellData | { unavailable: true; teamId: string | null; canManage: boolean; reason: 'no_key'; policy?: 'team' | 'team_or_own' | 'own' }> {
  const user = await getCurrentUser();
  if (!user) redirect('/app/auth/signin');
  const scope = await resolveActiveTeamScope(user.id, (await cookies()).get('buildd-team')?.value);
  const teamId = scope.teamId;
  if (!teamId) return { unavailable: true, teamId: null, canManage: false, reason: 'no_key' };
  const wsIds = scope.workspaces.map(w => w.id);
  const [avail, role, context, conversations] = await Promise.all([
    getChatAvailability(user.id, teamId),
    getUserTeamRole(user.id, teamId).catch(() => null),
    loadChatPageContext({ teamId, wsIds }),
    listConversations(user.id, teamId).catch(() => []),
  ]);
  if (!avail.available) {
    return { unavailable: true, teamId, canManage: avail.canManageTeamKeys, reason: 'no_key', policy: avail.keyPolicy };
  }
  return {
    user: { id: user.id, name: user.name ?? null, email: user.email ?? null },
    teamId,
    teamName: null,
    workspaces: scope.workspaces.map(w => ({ id: w.id, name: w.name })),
    available: true,
    reason: null,
    canManageTeamKeys: avail.canManageTeamKeys,
    audience: homeAudience(role, await getTeamPermissionOverrides(teamId)),
    context,
    conversations,
  };
}

export function ChatUnavailable({ reason, canManage, policy, teamId = null, formHref = '/app/missions/new' }: { reason: 'no_key'; canManage: boolean; policy?: 'team' | 'team_or_own' | 'own'; teamId?: string | null; formHref?: string }) {
  return (
    <div data-testid="chat-unavailable" className="mx-auto grid max-w-xl gap-4 px-4 py-8 md:py-14">
      {/* Everyone brings their own key and this person has none: the connect
          button right here, no settings trip. */}
      {reason === 'no_key' && policy === 'own' && teamId
        ? <ConnectOwnKeyCard teamId={teamId} returnTo="/app/chat" />
        : <ChatSetupCard reason={reason} canManage={canManage} policy={policy} />}
      <Link href={formHref} className="inline-flex min-h-11 items-center justify-center border-2 border-border-strong bg-surface-3 px-4 font-mono text-[13px] font-semibold text-text-primary hover:bg-surface-4">
        File a mission instead →
      </Link>
    </div>
  );
}

/**
 * What HISTORY opens in the desktop right panel: the conversation list. Null
 * when there are none (the panel says so itself).
 */
export function historyPanel(data: ChatShellData, currentId: string | null = null) {
  if (data.conversations.length === 0) return null;
  return <ConversationListView items={data.conversations} currentId={currentId} />;
}

/**
 * The empty canvas's mood and picked questions, from the context panel's own
 * data (no extra query): what waits on the viewer and the agents at work.
 */
export function canvasPulse(context: Pick<ChatPageContext, 'needsYou' | 'fleet'>): CanvasPulse {
  return {
    needsYou: pulseNeedsYou(context.needsYou),
    needsYouCapped: context.needsYou.length >= NEEDS_YOU_LIMIT,
    live: context.fleet?.live ?? 0,
  };
}

export function firstName(user: { name: string | null; email: string | null }): string | null {
  const n = user.name?.trim();
  if (n) return n.split(/\s+/)[0];
  return user.email?.split('@')[0] ?? null;
}

/** The conversation list: auto titles, newest first (components/chat/ConversationList.tsx). */
export { default as ConversationList } from '@/components/chat/ConversationList';

/**
 * "Ask about this mission/task": the object to dock, if it's in this team and
 * one of its workspaces. Anything else docks nothing (the chat still opens).
 */
export async function loadAboutRef(
  about: ChatAbout | null,
  scope: { teamId: string; workspaceIds: readonly string[] },
): Promise<BuilddObjectRef | null> {
  if (!about) return null;
  try {
    if (about.kind === 'mission') {
      const [m] = await db.select({ id: missions.id, title: missions.title, teamId: missions.teamId, workspaceId: missions.workspaceId })
        .from(missions).where(eq(missions.id, about.id)).limit(1);
      if (!m || m.teamId !== scope.teamId || (m.workspaceId && !scope.workspaceIds.includes(m.workspaceId))) return null;
      return { kind: 'mission', id: m.id, workspaceId: m.workspaceId, title: m.title, fallbackText: `Mission: ${m.title}` };
    }
    const [t] = await db.select({ id: tasks.id, title: tasks.title, workspaceId: tasks.workspaceId })
      .from(tasks).where(eq(tasks.id, about.id)).limit(1);
    if (!t || !scope.workspaceIds.includes(t.workspaceId)) return null;
    return { kind: 'task', id: t.id, workspaceId: t.workspaceId, title: t.title, fallbackText: `Task: ${t.title}` };
  } catch {
    return null;
  }
}

/**
 * The deep link's focus: `?focus=question&worker=<id>&task=<id>` opens that
 * question card in the pane (desktop) or the sheet (phone). Pure.
 */
export function focusRefFrom(q: { focus?: string; worker?: string; task?: string }, workspaceId: string | null): BuilddObjectRef | null {
  if (q.focus !== 'question' || !q.worker || !q.task || !isUuid(q.worker) || !isUuid(q.task)) return null;
  return { kind: 'question', id: q.worker, taskId: q.task, workspaceId, fallbackText: 'Question open' };
}

