'use client';

/**
 * One conversation on `useChat` (AI SDK v7, `@ai-sdk/react`). The server's
 * stored history is the source of truth, so each request carries only the
 * newest message (`ChatTurnRequest`). An approval answer is a newest message
 * too: `addToolApprovalResponse` marks the part and
 * `lastAssistantMessageIsCompleteWithApprovalResponses` sends it back.
 *
 * A new chat has no id yet: the first send creates the conversation
 * (`POST /api/chat`), parks the text, and navigates to it; the conversation
 * page sends the parked text on arrival.
 *
 * Other devices: `conversation:updated` on `conversation-{id}` is a ping; when
 * nothing is streaming here, the conversation is refetched and replaced.
 */
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport, lastAssistantMessageIsCompleteWithApprovalResponses, type UIMessage } from 'ai';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  CHAT_PUSHER_EVENTS, conversationChannelName,
  type CreateConversationResponse, type GetConversationResponse,
} from '@buildd/shared';
import { CHANNEL_PREFIX, subscribeToChannel, unsubscribeFromChannel } from '@/lib/pusher-client';
import type { BuilddObjectRef, ChatMessage } from './chat-contract';
import ChatWorkspace from './ChatWorkspace';
import type { ChatAgent } from './ChatFeed';
import type { ComposerWorkspace } from './ChatComposer';
import ChatSetupCard from './ChatSetupCard';
import { chatErrorLine, parseChatUnavailable } from './chat-errors';
import { ObjectStoreProvider } from './objects/ObjectStoreProvider';
import { parkPending, takePending } from './pending-message';

export { PENDING_KEY } from './pending-message';

export interface ChatConversationProps {
  conversationId: string | null;
  teamId: string;
  teamName: string | null;
  initialMessages: ChatMessage[];
  title: string | null;
  titleSource: 'auto' | 'user';
  tier: string | null;
  agent: ChatAgent;
  workspaces: readonly ComposerWorkspace[];
  workspaceId: string | null;
  viewerName: string | null;
  canManageTeamKeys: boolean;
  aside?: ReactNode;
  emptyState?: ReactNode;
  focusRef?: BuilddObjectRef | null;
}

/** A saved message (DTO) → the UIMessage `useChat` holds. Pure. */
export function dtoToMessage(m: GetConversationResponse['messages'][number], viewerName: string | null): ChatMessage {
  return {
    id: m.id,
    role: m.role,
    parts: m.parts,
    metadata: { createdAt: m.createdAt, ...(m.role === 'user' && viewerName ? { authorName: viewerName } : {}), ...(m.tier ? { tier: m.tier } : {}) },
  };
}

export default function ChatConversation(props: ChatConversationProps) {
  const {
    conversationId, teamId, teamName, initialMessages, tier: initialTier, agent, workspaces, viewerName,
    canManageTeamKeys, aside, emptyState, focusRef,
  } = props;
  const router = useRouter();
  const [title, setTitle] = useState(props.title);
  const [titleSource, setTitleSource] = useState(props.titleSource);
  const [tier, setTier] = useState(initialTier);
  const [workspaceId, setWorkspaceId] = useState(props.workspaceId ?? workspaces[0]?.id ?? null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const transport = useMemo(() => new DefaultChatTransport<UIMessage>({
    api: `/api/chat/${conversationId ?? 'new'}`,
    credentials: 'include',
    prepareSendMessagesRequest: ({ messages }) => ({ body: { message: messages[messages.length - 1] } }),
  }), [conversationId]);

  const { messages, sendMessage, status, error, stop, addToolApprovalResponse, setMessages, clearError } = useChat<UIMessage>({
    id: conversationId ?? undefined,
    messages: initialMessages as UIMessage[],
    transport,
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
  });

  // The first message of a new chat, parked by the list page before it navigated here.
  const sentPending = useRef(false);
  useEffect(() => {
    if (!conversationId || sentPending.current) return;
    sentPending.current = true;
    const text = takePending(conversationId);
    if (text) void sendMessage({ text });
  }, [conversationId, sendMessage]);

  // Other devices: a ping means refetch, never content over Pusher.
  const busyRef = useRef(false);
  busyRef.current = status === 'submitted' || status === 'streaming';
  const refetch = useCallback(async () => {
    if (!conversationId || busyRef.current) return;
    const res = await fetch(`/api/chat/${conversationId}`, { credentials: 'include', cache: 'no-store' }).catch(() => null);
    if (!res?.ok) return;
    const data = (await res.json()) as GetConversationResponse;
    if (busyRef.current) return;
    setMessages(data.messages.map(m => dtoToMessage(m, viewerName)) as UIMessage[]);
    setTitle(data.conversation.titleSource === 'user' || data.conversation.title !== 'New conversation' ? data.conversation.title : null);
    setTitleSource(data.conversation.titleSource);
    const last = [...data.messages].reverse().find(m => m.role === 'assistant' && m.tier);
    if (last?.tier) setTier(last.tier);
  }, [conversationId, setMessages, viewerName]);

  useEffect(() => {
    if (!conversationId) return;
    const name = `${CHANNEL_PREFIX}${conversationChannelName(conversationId)}`;
    const ch = subscribeToChannel(name);
    const fn = () => { void refetch(); };
    ch?.bind(CHAT_PUSHER_EVENTS.CONVERSATION_UPDATED, fn);
    return () => {
      ch?.unbind(CHAT_PUSHER_EVENTS.CONVERSATION_UPDATED, fn);
      unsubscribeFromChannel(name);
    };
  }, [conversationId, refetch]);

  // A finished turn may have renamed the conversation (auto-title after the first exchange).
  const prevStatus = useRef(status);
  useEffect(() => {
    if (prevStatus.current !== 'ready' && status === 'ready' && !title) void refetch();
    prevStatus.current = status;
  }, [status, title, refetch]);

  const onSend = useCallback(async (text: string) => {
    clearError();
    if (conversationId) {
      void sendMessage({ text });
      return;
    }
    setCreating(true);
    setCreateError(null);
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teamId, workspaceId }),
      });
      if (!res.ok) throw new Error(await res.text());
      const { conversation } = (await res.json()) as CreateConversationResponse;
      parkPending(conversation.id, text);
      router.push(`/app/chat/${conversation.id}`);
    } catch (e) {
      setCreateError(chatErrorLine(e));
      setCreating(false);
    }
  }, [clearError, conversationId, sendMessage, teamId, workspaceId, router]);

  const onApproval = useCallback((id: string, approved: boolean, reason?: string) => {
    void addToolApprovalResponse({ id, approved, reason });
  }, [addToolApprovalResponse]);

  const unavailable = parseChatUnavailable(error);
  const setupReason = unavailable && (unavailable.error === 'no_key' || unavailable.error === 'capability_disabled') ? unavailable.error : null;
  const errorLine = createError ?? (error && !setupReason ? chatErrorLine(error) : null);

  return (
    <ObjectStoreProvider>
      <ChatWorkspace
        messages={messages as ChatMessage[]}
        status={creating ? 'submitted' : status}
        error={errorLine}
        notice={setupReason ? <ChatSetupCard reason={setupReason} canManage={unavailable?.canManageTeamKeys ?? canManageTeamKeys} /> : null}
        onSend={onSend}
        onStop={() => { void stop(); }}
        onApproval={onApproval}
        title={title}
        titleSource={titleSource}
        teamName={teamName}
        agent={agent}
        tier={tier ?? 'standard'}
        // An existing conversation's scope was set when it was created.
        workspaces={conversationId ? workspaces.filter(w => w.id === workspaceId) : workspaces}
        workspaceId={workspaceId}
        onWorkspaceChange={setWorkspaceId}
        viewerName={viewerName}
        aside={aside}
        emptyState={emptyState}
        focusRef={focusRef}
      />
    </ObjectStoreProvider>
  );
}
