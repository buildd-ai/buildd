import { notFound } from 'next/navigation';
import ChatConversation from '@/components/chat/ChatConversation';
import ChatPresenceBeat from '@/components/chat/ChatPresenceBeat';
import { loadConversation } from '@/lib/chat/conversations';
import { isUuid } from '@/lib/uuid';
import { getUserTeamIds } from '@/lib/team-access';
import { parseChatEntry } from '@/lib/chat/entry-points';
import { ChatUnavailable, contextAside, firstName, focusRefFrom, loadAboutRef, loadChatShell } from '../chat-shell';

export default async function ConversationPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ focus?: string; worker?: string; task?: string; new?: string; about?: string }>;
}) {
  const [{ id }, q] = await Promise.all([params, searchParams]);
  if (!isUuid(id)) notFound();
  const data = await loadChatShell();
  if ('unavailable' in data) return <ChatUnavailable reason={data.reason} canManage={data.canManage} policy={data.policy} teamId={data.teamId} />;
  const viewer = firstName(data.user);
  // Carried over from the first send (+ Mission, New task, Ask about...).
  const entry = parseChatEntry(q);
  const [conv, teamIds, about] = await Promise.all([
    loadConversation(id, data.user.id, viewer),
    getUserTeamIds(data.user.id),
    loadAboutRef(entry.about, { teamId: data.teamId, workspaceIds: data.workspaces.map(w => w.id) }),
  ]);
  // A conversation lives in its team: leaving the team ends access to it.
  if (!conv || !teamIds.includes(conv.teamId)) notFound();
  return (
    <>
    <ChatPresenceBeat conversationId={conv.id} />
    <ChatConversation
      key={conv.id}
      conversationId={conv.id}
      teamId={conv.teamId}
      teamName={data.teamName}
      initialMessages={conv.messages}
      title={conv.title}
      titleSource={conv.titleSource}
      tier={conv.tier}
      pinnedTier={conv.pinnedTier}
      agent={data.context.agent}
      workspaces={data.workspaces}
      workspaceId={conv.workspaceId}
      viewerName={viewer}
      canManageTeamKeys={data.canManageTeamKeys}
      aside={contextAside(data)}
      focusRef={focusRefFrom(q, conv.workspaceId) ?? about}
      entry={{ ...entry, about: about ? entry.about : null }}
    />
    </>
  );
}
