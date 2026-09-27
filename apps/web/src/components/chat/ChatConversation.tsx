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
  CHAT_PUSHER_EVENTS, conversationChannelName, type ChatTierName,
  type CreateConversationResponse, type GetConversationResponse,
} from '@buildd/shared';
import { CHANNEL_PREFIX, subscribeToChannel, unsubscribeFromChannel } from '@/lib/pusher-client';
import type { BuilddObjectRef, ChatMessage } from './chat-contract';
import ChatWorkspace, { type ChatWorkspaceProps } from './ChatWorkspace';
import type { ChatAgent } from './ChatFeed';
import { TurnFeedbackProvider } from './TurnFeedback';
import type { ComposerWorkspace } from './ChatComposer';
import ChatSetupCard from './ChatSetupCard';
import { chatErrorLine, parseChatUnavailable } from './chat-errors';
import { ObjectStoreProvider } from './objects/ObjectStoreProvider';
import { parkPending, takePending } from './pending-message';
import { composerHint, conversationHref, EMPTY_CHAT_ENTRY, type ChatEntry } from '@/lib/chat/entry-points';
import type { CanvasPulse } from './canvas-empty';

export { PENDING_KEY } from './pending-message';

export interface ChatConversationProps {
  conversationId: string | null;
  teamId: string;
  teamName: string | null;
  initialMessages: ChatMessage[];
  title: string | null;
  titleSource: 'auto' | 'user';
  tier: string | null;
  /** The conversation's tier pin; null = routed per turn. */
  pinnedTier?: ChatTierName | null;
  agent: ChatAgent;
  workspaces: readonly ComposerWorkspace[];
  workspaceId: string | null;
  viewerName: string | null;
  canManageTeamKeys: boolean;
  aside?: ReactNode;
  emptyState?: ReactNode;
  /** A phone's history view (/app/chat?view=history). */
  historyOpen?: boolean;
  focusRef?: BuilddObjectRef | null;
  /** How the chat was opened (+ Mission, New task, Ask about…). Sent with every turn. */
  entry?: ChatEntry;
  /** "Fill in a form instead", until the first message. */
  formFallbackHref?: string | null;
  /** The empty canvas's mood and picked questions (chat-shell.tsx, canvasPulse). */
  pulse?: CanvasPulse | null;
  /**
   * The summoned canvas (ChatCanvasOverlay): a new conversation stays in place
   * instead of navigating to /app/chat/<id>, and the canvas chrome is passed
   * through to ChatWorkspace.
   */
  onConversationCreated?: (id: string) => void;
  canvas?: Pick<ChatWorkspaceProps, 'variant' | 'onClose' | 'onOpenObject' | 'fullChatHref' | 'crumbs' | 'strip' | 'pinOpenLabel'>;
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
    canManageTeamKeys, aside, emptyState, historyOpen = false, focusRef, entry = EMPTY_CHAT_ENTRY, formFallbackHref = null, pulse = null,
    onConversationCreated, canvas,
  } = props;
  const router = useRouter();
  const [title, setTitle] = useState(props.title);
  const [titleSource, setTitleSource] = useState(props.titleSource);
  const [tier, setTier] = useState(initialTier);
  const [pinnedTier, setPinnedTier] = useState<ChatTierName | null>(props.pinnedTier ?? null);
  const [costKey, setCostKey] = useState(0);
  // Null = all workspaces: each turn is routed to the one the message is about.
  const [workspaceId, setWorkspaceId] = useState<string | null>(props.workspaceId ?? null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const transport = useMemo(() => new DefaultChatTransport<UIMessage>({
    api: `/api/chat/${conversationId ?? 'new'}`,
    credentials: 'include',
    prepareSendMessagesRequest: ({ messages }) => ({
      body: {
        message: messages[messages.length - 1],
        ...(entry.intent || entry.about ? { entry: { intent: entry.intent, about: entry.about } } : {}),
      },
    }),
  }), [conversationId, entry.intent, entry.about]);

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
    setPinnedTier(data.conversation.tier ?? null);
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
    if (prevStatus.current !== 'ready' && status === 'ready') {
      if (!title) void refetch();
      // The turn's cost is saved on end: refresh the running total.
      setCostKey(k => k + 1);
    }
    prevStatus.current = status;
  }, [status, title, refetch]);

  const onWorkspaceChange = useCallback((next: string | null) => {
    const before = workspaceId;
    setWorkspaceId(next);
    if (!conversationId) return; // sent with the create request
    void fetch(`/api/chat/${conversationId}`, {
      method: 'PATCH', credentials: 'include', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId: next }),
    }).then(r => { if (!r.ok) setWorkspaceId(before); }).catch(() => setWorkspaceId(before));
  }, [conversationId, workspaceId]);

  const onTierChange = useCallback((next: ChatTierName | null) => {
    const before = pinnedTier;
    setPinnedTier(next);
    if (!conversationId) return; // sent with the create request
    void fetch(`/api/chat/${conversationId}`, {
      method: 'PATCH', credentials: 'include', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier: next }),
    }).then(r => { if (!r.ok) setPinnedTier(before); }).catch(() => setPinnedTier(before));
  }, [conversationId, pinnedTier]);

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
        body: JSON.stringify({ teamId, workspaceId, tier: pinnedTier }),
      });
      if (!res.ok) throw new Error(await res.text());
      const { conversation } = (await res.json()) as CreateConversationResponse;
      parkPending(conversation.id, text);
      if (onConversationCreated) onConversationCreated(conversation.id);
      else router.push(conversationHref(conversation.id, entry));
    } catch (e) {
      setCreateError(chatErrorLine(e));
      setCreating(false);
    }
  }, [clearError, conversationId, sendMessage, teamId, workspaceId, router, entry, pinnedTier, onConversationCreated]);

  const onApproval = useCallback((id: string, approved: boolean, reason?: string) => {
    void addToolApprovalResponse({ id, approved, reason });
  }, [addToolApprovalResponse]);

  const unavailable = parseChatUnavailable(error);
  const setupReason = unavailable?.error === 'no_key' ? 'no_key' : null;
  const errorLine = createError ?? (error && !setupReason ? chatErrorLine(error) : null);

  // Saved assistant turns can be rated; the one still streaming cannot yet.
  const lastMsg = messages.at(-1);
  const pendingId = status === 'streaming' && lastMsg?.role === 'assistant' ? lastMsg.id : null;
  const assistantIds = messages.filter(m => m.role === 'assistant' && m.id !== pendingId).map(m => m.id);

  return (
    <ObjectStoreProvider>
      <TurnFeedbackProvider messageIds={assistantIds} pendingId={pendingId}>
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
        tier={tier}
        teamId={teamId}
        conversationId={conversationId}
        pinnedTier={pinnedTier}
        onTierChange={onTierChange}
        costRefreshKey={costKey}
        // An existing conversation's scope was set when it was created.
        workspaces={workspaces}
        workspaceId={workspaceId}
        onWorkspaceChange={onWorkspaceChange}
        viewerName={viewerName}
        aside={aside}
        emptyState={emptyState}
        historyOpen={historyOpen}
        focusRef={focusRef}
        focusOpensSheet={!entry.about}
        composerPlaceholder={messages.length === 0 ? composerHint(entry) : undefined}
        autoFocus={!conversationId && (entry.intent !== null || entry.about !== null)}
        formFallbackHref={formFallbackHref}
        entryIntent={entry.intent}
        pulse={pulse}
        {...canvas}
      />
      </TurnFeedbackProvider>
    </ObjectStoreProvider>
  );
}
