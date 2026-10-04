import ChatConversation from '@/components/chat/ChatConversation';
import ChatPresenceBeat from '@/components/chat/ChatPresenceBeat';
import { formHref, parseChatEntry } from '@/lib/chat/entry-points';
import { canvasPulse, ChatUnavailable, ConversationList, historyPanel, firstName, loadAboutRef, loadChatShell } from './chat-shell';

/**
 * /app/chat — a new conversation, with your recent ones above the composer.
 * The conversation is created on the first send (POST /api/chat).
 *
 * Every create entry point lands here when chat is available
 * (lib/chat/entry-points.ts): `?new=mission|task` from + Mission / New task,
 * `?about=mission:<id>` from "Ask about this mission", `?ws=` for the scope.
 */
export default async function ChatPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [q, data] = await Promise.all([searchParams, loadChatShell()]);
  const entry = parseChatEntry(q);
  if ('unavailable' in data) {
    return <ChatUnavailable reason={data.reason} canManage={data.canManage} policy={data.policy} teamId={data.teamId} formHref={formHref(entry.intent ?? 'mission', entry.workspaceId)} />;
  }
  const wsIds = data.workspaces.map(w => w.id);
  const about = await loadAboutRef(entry.about, { teamId: data.teamId, workspaceIds: wsIds });
  // The object's own workspace, else the one the button (or the app's
  // workspace switcher) was on, else all workspaces: routed per turn.
  const picked = typeof q.workspace === 'string' ? q.workspace : null;
  const workspaceId = [about?.workspaceId, entry.workspaceId, picked].find((id): id is string => !!id && wsIds.includes(id)) ?? null;
  // A phone's HISTORY → (`?view=history`): the conversation list in place of
  // the empty canvas. On desktop HISTORY → opens the right panel, and this
  // deep link opens it there; only the tablet band shows the list above the canvas.
  const historyOpen = q.view === 'history' && !about && !entry.intent;
  const emptyState = data.conversations.length > 0
    ? <ConversationList items={data.conversations} />
    : historyOpen
      ? <p data-testid="conversation-list-empty" className="px-1 font-voice text-[17px] italic text-[var(--chat-muted)] md:hidden">No chats.</p>
      : null;
  return (
    <>
    <ChatPresenceBeat conversationId={null} />
    <ChatConversation
      conversationId={null}
      teamId={data.teamId}
      teamName={data.teamName}
      initialMessages={[]}
      title={null}
      titleSource="auto"
      tier={null}
      agent={data.context.agent}
      workspaces={data.workspaces}
      workspaceId={workspaceId}
      viewerName={firstName(data.user)}
      canManageTeamKeys={data.canManageTeamKeys}
      aside={historyPanel(data)}
      emptyState={emptyState}
      historyOpen={historyOpen}
      pulse={canvasPulse(data.context)}
      focusRef={about}
      entry={{ ...entry, about: about ? entry.about : null }}
    />
    </>
  );
}
