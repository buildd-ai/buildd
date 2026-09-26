import ChatConversation from '@/components/chat/ChatConversation';
import { formHref, parseChatEntry } from '@/lib/chat/entry-points';
import { ChatUnavailable, ConversationList, contextAside, firstName, loadAboutRef, loadChatShell } from './chat-shell';

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
    return <ChatUnavailable reason={data.reason} canManage={data.canManage} policy={data.policy} formHref={formHref(entry.intent ?? 'mission', entry.workspaceId)} />;
  }
  const wsIds = data.workspaces.map(w => w.id);
  const about = await loadAboutRef(entry.about, { teamId: data.teamId, workspaceIds: wsIds });
  // The object's own workspace, else the one the button was in, else the first.
  const workspaceId = [about?.workspaceId, entry.workspaceId].find((id): id is string => !!id && wsIds.includes(id))
    ?? data.workspaces[0]?.id ?? null;
  return (
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
      aside={contextAside(data)}
      emptyState={<ConversationList items={data.conversations} />}
      focusRef={about}
      entry={{ ...entry, about: about ? entry.about : null }}
      formFallbackHref={about ? null : formHref(entry.intent ?? 'mission', workspaceId)}
    />
  );
}
