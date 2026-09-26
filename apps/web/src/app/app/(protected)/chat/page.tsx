import ChatConversation from '@/components/chat/ChatConversation';
import { ChatUnavailable, ConversationList, contextAside, firstName, loadChatShell } from './chat-shell';

/**
 * /app/chat — a new conversation, with your recent ones above the composer.
 * The conversation is created on the first send (POST /api/chat).
 */
export default async function ChatPage() {
  const data = await loadChatShell();
  if ('unavailable' in data) return <ChatUnavailable reason={data.reason} canManage={data.canManage} />;
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
      workspaceId={data.workspaces[0]?.id ?? null}
      viewerName={firstName(data.user)}
      canManageTeamKeys={data.canManageTeamKeys}
      aside={contextAside(data)}
      emptyState={<ConversationList items={data.conversations} />}
    />
  );
}
