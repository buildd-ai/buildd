'use client';

/**
 * One conversation on the kit's `useKitChat` (@builddai/ai-kit/chat/react,
 * `useChat` from AI SDK v7 underneath). The server's stored history is the
 * source of truth, so each request carries only the newest message
 * (`ChatTurnRequest`) plus how the chat was opened. An approval answer is a
 * newest message too: `respond` marks the part and it goes back once every
 * card in the turn is answered.
 *
 * A new chat has no id yet: the first send creates the conversation
 * (`POST /api/chat`), parks the text, and navigates to it; the conversation
 * page sends the parked text on arrival. Until then its draft, workspace and
 * tier are the shared composer's (composer-store.ts), the same ones the Home
 * card and the canvas show. An existing conversation keeps its own.
 *
 * Other devices: `conversation:updated` on `conversation-{id}` is a ping; when
 * nothing is streaming here, the conversation is refetched and replaced.
 */
import { useKitChat } from '@builddai/ai-kit/chat/react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  CHAT_PUSHER_EVENTS, conversationChannelName, type ChatTierName,
  type CreateConversationResponse, type GetConversationResponse,
} from '@buildd/shared';
import { CHANNEL_PREFIX, subscribeToChannel, unsubscribeFromChannel } from '@/lib/pusher-client';
import { useWatchDelivery } from './use-watch-delivery';
import type { BuilddObjectRef, ChatMessage } from './chat-contract';
import ChatWorkspace, { type ChatWorkspaceProps } from './ChatWorkspace';
import type { ChatAgent } from './ChatFeed';
import { TurnFeedbackProvider } from './TurnFeedback';
import type { ComposerWorkspace } from './ChatComposer';
import ChatSetupCard from './ChatSetupCard';
import { chatErrorLine, parseChatUnavailable } from './chat-errors';
import { ObjectStoreProvider } from './objects/ObjectStoreProvider';
import { parkPending, takePending } from './pending-message';
import { chooseComposerTier, chooseComposerWorkspace, useSharedComposer } from './composer-store';
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
  /** An existing conversation's workspace. A new chat: the page's scope, or null for the remembered one. */
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
  /** The empty canvas's mood and picked questions (chat-shell.tsx, canvasPulse). */
  pulse?: CanvasPulse | null;
  /**
   * The summoned canvas (ChatCanvasOverlay): a new conversation stays in place
   * instead of navigating to /app/chat/<id>, and the canvas chrome is passed
   * through to ChatWorkspace.
   */
  onConversationCreated?: (id: string, created: { tier: ChatTierName | null; workspaceId: string | null }) => void;
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
    canManageTeamKeys, aside, emptyState, historyOpen = false, focusRef, entry = EMPTY_CHAT_ENTRY, pulse = null,
    onConversationCreated, canvas,
  } = props;
  const router = useRouter();
  const [title, setTitle] = useState(props.title);
  const [titleSource, setTitleSource] = useState(props.titleSource);
  const [tier, setTier] = useState(initialTier);
  const [ownTier, setPinnedTier] = useState<ChatTierName | null>(props.pinnedTier ?? null);
  const [costKey, setCostKey] = useState(0);
  // Null = all workspaces: each turn is routed to the one the message is about.
  const [ownWorkspaceId, setWorkspaceId] = useState<string | null>(props.workspaceId ?? null);
  const shared = useSharedComposer(teamId, workspaces, conversationId ? null : props.workspaceId);
  const { setWorkspaceId: setSharedWorkspaceId, setTier: setSharedTier } = shared;
  const isNew = !conversationId;
  const pinnedTier = isNew ? shared.tier : ownTier;
  const workspaceId = isNew ? shared.workspaceId : ownWorkspaceId;
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const entryBody = useMemo(
    () => (entry.intent || entry.about ? { entry: { intent: entry.intent, about: entry.about } } : {}),
    [entry.intent, entry.about],
  );
  const chat = useKitChat({
    api: `/api/chat/${conversationId ?? 'new'}`,
    id: conversationId ?? undefined,
    initialMessages,
    credentials: 'include',
    body: entryBody,
  });
  const { messages, send: sendText, status, error, stop, respond, setMessages, clearError } = chat;

  // The first message of a new chat, parked by the list page before it navigated here.
  const sentPending = useRef(false);
  useEffect(() => {
    if (!conversationId || sentPending.current) return;
    sentPending.current = true;
    const text = takePending(conversationId);
    if (text) void sendText(text);
  }, [conversationId, sendText]);

  // Other devices: a ping means refetch, never content over Pusher.
  const busyRef = useRef(false);
  busyRef.current = status === 'submitted' || status === 'streaming';
  const refetch = useCallback(async () => {
    if (!conversationId || busyRef.current) return;
    const res = await fetch(`/api/chat/${conversationId}`, { credentials: 'include', cache: 'no-store' }).catch(() => null);
    if (!res?.ok) return;
    const data = (await res.json()) as GetConversationResponse;
    if (busyRef.current) return;
    setMessages(data.messages.map(m => dtoToMessage(m, viewerName)));
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

  // Watches set here that fired while the tab was away land in the feed.
  useWatchDelivery(conversationId, () => { void refetch(); });

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
    if (!conversationId) { setSharedWorkspaceId(next); return; } // sent with the create request
    const before = workspaceId;
    setWorkspaceId(next);
    chooseComposerWorkspace(teamId, next);
    void fetch(`/api/chat/${conversationId}`, {
      method: 'PATCH', credentials: 'include', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId: next }),
    }).then(r => { if (!r.ok) setWorkspaceId(before); }).catch(() => setWorkspaceId(before));
  }, [conversationId, workspaceId, teamId, setSharedWorkspaceId]);

  const onTierChange = useCallback((next: ChatTierName | null) => {
    if (!conversationId) { setSharedTier(next); return; } // sent with the create request
    const before = pinnedTier;
    setPinnedTier(next);
    chooseComposerTier(teamId, next);
    void fetch(`/api/chat/${conversationId}`, {
      method: 'PATCH', credentials: 'include', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier: next }),
    }).then(r => { if (!r.ok) setPinnedTier(before); }).catch(() => setPinnedTier(before));
  }, [conversationId, pinnedTier, teamId, setSharedTier]);

  const onSend = useCallback(async (text: string) => {
    clearError();
    if (conversationId) {
      void sendText(text);
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
      if (onConversationCreated) onConversationCreated(conversation.id, { tier: pinnedTier, workspaceId });
      else router.push(conversationHref(conversation.id, entry));
    } catch (e) {
      setCreateError(chatErrorLine(e));
      setCreating(false);
    }
  }, [clearError, conversationId, sendText, teamId, workspaceId, router, entry, pinnedTier, onConversationCreated]);

  const onApproval = respond;

  // A refusal before any model call: the kit reads its body (chat.unavailable);
  // buildd's parse keeps the typed fields its setup card reads.
  const unavailable = parseChatUnavailable(error) ?? (chat.unavailable ? parseChatUnavailable(JSON.stringify(chat.unavailable)) : null);
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
        {...(isNew ? { draft: shared.draft, onDraftChange: shared.setDraft } : {})}
        viewerName={viewerName}
        aside={aside}
        emptyState={emptyState}
        historyOpen={historyOpen}
        focusRef={focusRef}
        focusOpensSheet={!entry.about}
        composerPlaceholder={messages.length === 0 ? composerHint(entry) : undefined}
        autoFocus={!conversationId && (entry.intent !== null || entry.about !== null)}
        entryIntent={entry.intent}
        pulse={pulse}
        {...canvas}
      />
      </TurnFeedbackProvider>
    </ObjectStoreProvider>
  );
}
