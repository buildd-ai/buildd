import { notFound } from 'next/navigation';
import ChatConversation from '@/components/chat/ChatConversation';
import { loadConversation } from '@/lib/chat/conversations';
import { isUuid } from '@/lib/uuid';
import { ChatUnavailable, contextAside, firstName, focusRefFrom, loadChatShell } from '../chat-shell';

export default async function ConversationPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ focus?: string; worker?: string; task?: string }>;
}) {
  const [{ id }, q] = await Promise.all([params, searchParams]);
  if (!isUuid(id)) notFound();
  const data = await loadChatShell();
  if ('unavailable' in data) return <ChatUnavailable reason={data.reason} canManage={data.canManage} />;
  const viewer = firstName(data.user);
  const conv = await loadConversation(id, data.user.id, viewer);
  if (!conv) notFound();
  return (
    <ChatConversation
      key={conv.id}
      conversationId={conv.id}
      teamId={conv.teamId}
      teamName={data.teamName}
      initialMessages={conv.messages}
      title={conv.title}
      titleSource={conv.titleSource}
      tier={conv.tier}
      agent={data.context.agent}
      workspaces={data.workspaces}
      workspaceId={conv.workspaceId}
      viewerName={viewer}
      canManageTeamKeys={data.canManageTeamKeys}
      aside={contextAside(data)}
      focusRef={focusRefFrom(q, conv.workspaceId)}
    />
  );
}
