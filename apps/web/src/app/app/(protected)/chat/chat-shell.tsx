/**
 * Server pieces both chat pages share: resolve the person, team, chat
 * availability, the context panel and the conversation list in one round,
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
import { loadChatPageContext, type ChatPageContext } from '@/lib/chat/chat-page-data';
import ChatSetupCard from '@/components/chat/ChatSetupCard';
import ConnectOwnKeyCard from '@/components/onboarding/ConnectOwnKeyCard';
import ChatContextPanel, { contextPanelModel } from '@/components/chat/ChatContextPanel';
import { homeAudience } from '../home/home-view';
import { ZonedTime } from '@/components/DisplayTimezone';
import { isUuid } from '@/lib/uuid';
import type { BuilddObjectRef } from '@/components/chat/chat-contract';
import { eq } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { missions, tasks } from '@buildd/core/db/schema';
import type { ChatAbout } from '@/lib/chat/entry-points';

export interface ChatShellData {
  user: { id: string; name: string | null; email: string | null };
  teamId: string;
  teamName: string | null;
  workspaces: Array<{ id: string; name: string }>;
  available: boolean;
  reason: 'capability_disabled' | 'no_key' | 'budget_exhausted' | 'rate_limited' | null;
  canManageTeamKeys: boolean;
  audience: 'member' | 'operator';
  context: ChatPageContext;
  conversations: ConversationListItem[];
}

export async function loadChatShell(): Promise<ChatShellData | { unavailable: true; teamId: string | null; canManage: boolean; reason: 'capability_disabled' | 'no_key'; policy?: 'team' | 'team_or_own' | 'own' }> {
  const user = await getCurrentUser();
  if (!user) redirect('/app/auth/signin');
  const scope = await resolveActiveTeamScope(user.id, (await cookies()).get('buildd-team')?.value);
  const teamId = scope.teamId;
  if (!teamId) return { unavailable: true, teamId: null, canManage: false, reason: 'capability_disabled' };
  const wsIds = scope.workspaces.map(w => w.id);
  const [avail, role, context, conversations] = await Promise.all([
    getChatAvailability(user.id, teamId),
    getUserTeamRole(user.id, teamId).catch(() => null),
    loadChatPageContext({ teamId, wsIds }),
    listConversations(user.id, teamId).catch(() => []),
  ]);
  if (!avail.available) {
    return { unavailable: true, teamId, canManage: avail.canManageTeamKeys, reason: avail.reason === 'no_key' ? 'no_key' : 'capability_disabled', policy: avail.keyPolicy };
  }
  return {
    user: { id: user.id, name: user.name ?? null, email: user.email ?? null },
    teamId,
    teamName: null,
    workspaces: scope.workspaces.map(w => ({ id: w.id, name: w.name })),
    available: true,
    reason: null,
    canManageTeamKeys: avail.canManageTeamKeys,
    audience: homeAudience(role),
    context,
    conversations,
  };
}

export function ChatUnavailable({ reason, canManage, policy, teamId = null, formHref = '/app/missions/new' }: { reason: 'capability_disabled' | 'no_key'; canManage: boolean; policy?: 'team' | 'team_or_own' | 'own'; teamId?: string | null; formHref?: string }) {
  return (
    <div data-testid="chat-unavailable" className="mx-auto grid max-w-xl gap-4 px-4 py-8 md:py-14">
      {/* Everyone brings their own key and this person has none: the connect
          button right here, no settings trip. */}
      {reason === 'no_key' && policy === 'own' && teamId
        ? <ConnectOwnKeyCard teamId={teamId} returnTo="/app/chat" />
        : <ChatSetupCard reason={reason} canManage={canManage} policy={policy} />}
      <Link href={formHref} className="inline-flex min-h-11 items-center justify-center border-2 border-border-strong bg-surface-3 px-4 font-mono text-[13px] font-semibold text-text-primary hover:bg-surface-4">
        {formHref.startsWith('/app/tasks/new') ? 'File a task instead →' : 'File a mission instead →'}
      </Link>
    </div>
  );
}

/** The context panel, or null when it has nothing in it (the chat takes the width). */
export function contextAside(data: ChatShellData) {
  if (contextPanelModel(data.context).empty) return null;
  return (
    <ChatContextPanel
      audience={data.audience}
      needsYou={data.context.needsYou}
      missions={data.context.missions}
      fleet={data.context.fleet}
    />
  );
}

export function firstName(user: { name: string | null; email: string | null }): string | null {
  const n = user.name?.trim();
  if (n) return n.split(/\s+/)[0];
  return user.email?.split('@')[0] ?? null;
}

/** The conversation list: auto titles, newest first. */
export function ConversationList({ items, currentId }: { items: readonly ConversationListItem[]; currentId?: string | null }) {
  if (items.length === 0) return null;
  return (
    <nav data-testid="conversation-list" aria-label="Conversations" className="mb-8">
      <div className="mb-2 font-mono text-[11px] font-semibold uppercase tracking-[2px] text-text-muted">Recent</div>
      <ul className="divide-y divide-border-default border-2 border-border-strong bg-card">
        {items.map(c => (
          <li key={c.id}>
            <Link
              href={`/app/chat/${c.id}`}
              aria-current={c.id === currentId ? 'page' : undefined}
              className="flex min-h-12 items-center gap-3 px-4 py-2 hover:bg-card-hover"
            >
              <span className={`min-w-0 flex-1 truncate font-mono text-[13.5px] ${c.untitled ? 'text-text-muted' : 'font-semibold text-text-primary'}`}>{c.title}</span>
              <ZonedTime value={c.lastMessageAt} format="datetime-short" className="shrink-0 font-mono text-[11.5px] text-text-muted" />
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

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
  return { kind: 'question', id: q.worker, taskId: q.task, workspaceId, fallbackText: 'A question is waiting on you' };
}

