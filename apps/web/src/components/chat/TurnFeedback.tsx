'use client';

/**
 * Thumbs on an assistant turn (docs/design/tier-model-pools.md §9 "Chat").
 * The thumbs, the one optional reason (a popover on desktop, a bottom sheet on
 * a phone) and the vote state are the kit's (`TurnFeedbackProvider` /
 * `TurnFeedback` from @builddai/ai-kit/chat/react). buildd owns the transport,
 * `/api/feedback` (one row per vote; the route toggles an identical vote
 * off, as the kit does), and the reason list from `@buildd/core/tier-pool`.
 * Only labels are sent, never text.
 */
import { useCallback, type ReactNode } from 'react';
import {
  TurnFeedback as KitTurnFeedback,
  TurnFeedbackProvider as KitTurnFeedbackProvider,
  type FeedbackReason,
  type TurnFeedbackEvent,
} from '@builddai/ai-kit/chat/react';
import type { TurnSignal, TurnVote as KitTurnVote } from '@builddai/ai-kit/chat/contract';
import { CHAT_FEEDBACK_REASONS, CHAT_FEEDBACK_REASON_LABELS, isChatFeedbackReason, type ChatFeedbackReason } from '@buildd/core/tier-pool';

export type { TurnSignal };
export type TurnVote = KitTurnVote<ChatFeedbackReason>;

/** buildd's reasons, in the kit's shape. */
export const FEEDBACK_REASONS: readonly FeedbackReason<ChatFeedbackReason>[] = CHAT_FEEDBACK_REASONS.map(key => ({ key, label: CHAT_FEEDBACK_REASON_LABELS[key] }));

/** Send one vote. The route toggles an identical vote off. */
export async function postTurnVote(messageId: string, signal: TurnSignal, reason?: ChatFeedbackReason | null): Promise<boolean> {
  const res = await fetch('/api/feedback', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entityType: 'conversation_message', entityId: messageId, signal, ...(reason ? { reason } : {}) }),
  }).catch(() => null);
  return !!res?.ok;
}

/** This viewer's votes on these saved turns. */
export async function loadTurnVotes(messageIds: readonly string[]): Promise<Record<string, TurnVote>> {
  const res = await fetch(`/api/feedback?entityType=conversation_message&entityIds=${encodeURIComponent(messageIds.join(','))}`, { credentials: 'include', cache: 'no-store' });
  if (!res.ok) return {};
  const d = (await res.json()) as { feedback?: Record<string, string>; reasons?: Record<string, string> } | null;
  const out: Record<string, TurnVote> = {};
  for (const [id, s] of Object.entries(d?.feedback ?? {})) {
    const r = d?.reasons?.[id];
    if (s === 'up' || s === 'down') out[id] = { signal: s, reason: r && isChatFeedbackReason(r) ? r : null };
  }
  return out;
}

/**
 * Holds this viewer's votes for the conversation. `messageIds` are the saved
 * assistant turns; their current votes load once per set.
 */
export function TurnFeedbackProvider({ messageIds, pendingId, children, initial }: {
  messageIds: readonly string[];
  pendingId: string | null;
  children: ReactNode;
  /** Fixtures and tests: skip the fetch. */
  initial?: Record<string, TurnVote>;
}) {
  const onFeedback = useCallback((e: TurnFeedbackEvent<ChatFeedbackReason>) => postTurnVote(e.messageId, e.signal, e.reason), []);
  return (
    <KitTurnFeedbackProvider<ChatFeedbackReason>
      onFeedback={onFeedback}
      loadVotes={loadTurnVotes}
      initial={initial}
      messageIds={messageIds}
      pendingId={pendingId}
      reasons={FEEDBACK_REASONS}
    >
      {children}
    </KitTurnFeedbackProvider>
  );
}

/** The thumbs row under one assistant turn. Renders nothing without a provider. */
export default function TurnFeedback({ messageId }: { messageId: string }) {
  return <KitTurnFeedback messageId={messageId} className="buildd-feedback" />;
}
