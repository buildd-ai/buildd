/**
 * Fired watches in the conversation they were set from
 * (docs/design/subscriptions-and-notifications.md → Delivery routing).
 *
 * Two separate things, on purpose:
 *
 *   THE RECORD (step 3, "person, always"). Every fired watch with an origin
 *   conversation is posted there as a `role: 'event'` message, whether or not
 *   the person is looking and whichever route delivers it. Posting does NOT
 *   consume the ledger row. The message id IS the ledger row id, inserted
 *   ON CONFLICT DO NOTHING, so a reload, a second tab or two paths posting the
 *   same row land it once.
 *
 *   THE DELIVERY (step 4, "in the conversation: stop"). Only when the person
 *   is present right now is the row closed with markDelivered(route:
 *   'conversation'). Otherwise it stays pending for the away job (Pushover,
 *   lib/away-delivery.ts in the presence PR), which marks it 'pushover'.
 *   A one-shot marks only its oldest pending row; the claim inside
 *   markDelivered coalesces the rest.
 *
 * WHERE THIS RUNS. The open conversation pulls: on open, when the tab comes
 * back, and every 30s while it is visible (`POST /api/chat/[id]/deliveries`,
 * components/chat/use-watch-delivery.ts). The emit sites stay as the
 * foundation left them (recordEvent writes the ledger and returns), and the
 * request already carries the owner and the conversation. A row Pushover
 * delivered while the person was away still gets its record here the next
 * time the conversation is open (listUnpostedForConversation reads delivered
 * rows too).
 *
 * COST. A visible tab polls every 30s, so the drain first reads a Redis
 * flag (lib/watch-pending.ts) that recordEvent sets for the owner. Flag clear
 * and not opening: no Postgres at all. Opening the conversation always
 * drains. No Redis: drain every time, but the tab polls at the slower
 * UNKNOWN_POLL_MS (returned as `pollMs`).
 *
 * PRESENCE. `getPresence(userId)` (lib/presence.ts): a missing beat, no
 * Redis, or an error reads as away, the fail-toward-delivering state: the
 * record is posted, nothing is marked, and the away job owns delivery.
 */

import { eq } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { conversationMessages, conversations } from '@buildd/core/db/schema';
import { CHAT_EVENT_PART_TYPE, type ChatEventData, type ChatMessagePart } from '@buildd/shared';
import { listUndelivered, listUnpostedForConversation, markDelivered, type UndeliveredRow } from '@/lib/subscriptions';
import { watchNotice } from '@/lib/watch-notice';
import { getPresence, type Presence } from '@/lib/presence';
import { clearWatchPending, POLL_MS, UNKNOWN_POLL_MS, watchPendingState, type PendingState } from '@/lib/watch-pending';
import { pingConversation } from './store';

/** The stored parts for one fired watch: a single event part. */
export function watchEventParts(row: Pick<UndeliveredRow, 'eventType' | 'payload' | 'subjectRef'>): ChatMessagePart[] {
  const n = watchNotice(row);
  const data: ChatEventData = { event: 'watch', objects: [], text: n.text, watch: n.watch };
  return [{ type: CHAT_EVENT_PART_TYPE, data }];
}

/** Insert the event message with a fixed id; false when it is already there. */
async function insertEventOnce(conversationId: string, id: string, parts: ChatMessagePart[], createdAt: Date): Promise<boolean> {
  const rows = await db.insert(conversationMessages)
    .values({ id, conversationId, role: 'event', parts, createdAt })
    .onConflictDoNothing()
    .returning({ id: conversationMessages.id });
  if (rows.length === 0) return false;
  await db.update(conversations).set({ lastMessageAt: new Date() }).where(eq(conversations.id, conversationId));
  return true;
}

export interface WatchDeliveryDeps {
  listUnposted: typeof listUnpostedForConversation;
  listUndelivered: typeof listUndelivered;
  markDelivered: typeof markDelivered;
  getPresence: (userId: string) => Promise<Presence>;
  insertEvent: (conversationId: string, id: string, parts: ChatMessagePart[], createdAt: Date) => Promise<boolean>;
  ping: (conversationId: string, messageId?: string) => Promise<void>;
  pendingState: (userId: string) => Promise<PendingState>;
  clearPending: (userId: string) => Promise<void>;
}

export interface WatchDrainResult {
  delivered: number;
  marked: number;
  /** The Redis flag said there was nothing to pull: Postgres was not asked. */
  skipped?: true;
  /** When the tab should ask again. */
  pollMs: number;
}

const DEFAULT_DEPS: WatchDeliveryDeps = {
  listUnposted: listUnpostedForConversation,
  listUndelivered,
  markDelivered,
  getPresence: userId => getPresence(userId),
  insertEvent: insertEventOnce,
  ping: (id, messageId) => pingConversation(id, 'event', messageId),
  pendingState: watchPendingState,
  clearPending: clearWatchPending,
};

/**
 * Post one fired watch into a conversation. Idempotent on the row id, and it
 * never touches the ledger, so any route may call it (the away job included).
 * The message keeps the event's own time, so a late post sorts where it happened.
 */
export async function postWatchEvent(
  conversationId: string,
  row: Pick<UndeliveredRow, 'id' | 'eventType' | 'payload' | 'subjectRef' | 'createdAt'>,
  deps: Pick<WatchDeliveryDeps, 'insertEvent'> = DEFAULT_DEPS,
): Promise<boolean> {
  const at = new Date(row.createdAt);
  return deps.insertEvent(conversationId, row.id, watchEventParts(row), Number.isFinite(at.getTime()) ? at : new Date());
}

/**
 * Post this conversation's unposted records, then, only if the owner is
 * present, mark its pending rows delivered via the conversation. Never
 * throws: an error reads as nothing posted, and rows stay as they were.
 */
export async function deliverWatchesToConversation(
  target: { userId: string; conversationId: string; open?: boolean },
  deps: Partial<WatchDeliveryDeps> = {},
): Promise<WatchDrainResult> {
  const d = { ...DEFAULT_DEPS, ...deps };
  const owner = { userId: target.userId };
  const state = await d.pendingState(target.userId).catch((): PendingState => 'unknown');
  const pollMs = state === 'unknown' ? UNKNOWN_POLL_MS : POLL_MS;
  if (state === 'clear' && !target.open) return { delivered: 0, marked: 0, skipped: true, pollMs };
  let posted = 0;
  let marked = 0;
  let lastId: string | undefined;
  try {
    for (const r of await d.listUnposted(owner, target.conversationId, { limit: 50 })) {
      if (await postWatchEvent(target.conversationId, r, d)) { posted += 1; lastId = r.id; }
    }
    const presence = await d.getPresence(target.userId).catch((): Presence => ({ state: 'away', reason: 'unavailable' }));
    if (presence.state === 'present') {
      const all = await d.listUndelivered(owner, { limit: 50 });
      const pending = all.filter(r => r.conversationId === target.conversationId);
      const oneShot = new Set<string>();
      let handled = 0;
      for (const r of pending) {
        if (r.lifetime === 'one_shot') {
          // A sibling of a claimed one-shot is coalesced by that claim.
          if (oneShot.has(r.subscriptionId)) { handled += 1; continue; }
          oneShot.add(r.subscriptionId);
        }
        if ((await d.markDelivered(owner, r.id, { route: 'conversation' })).marked) marked += 1;
        handled += 1;
      }
      // Nothing of theirs is left pending anywhere: the next poll can skip Postgres.
      if (all.length === pending.length && handled === pending.length) await d.clearPending(target.userId).catch(() => {});
    }
  } catch (e) {
    console.warn('[chat] watch delivery failed:', e);
  }
  if (posted > 0) await d.ping(target.conversationId, lastId).catch(() => {});
  return { delivered: posted, marked, pollMs };
}
