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
 * PRESENCE. `getPresence(userId)` is the presence PR's contract
 * (lib/presence.ts: `{ state: 'present' | 'away' }`, a missing key or no
 * Redis reads as away). Until that PR is in this branch the default below
 * answers away, which is the fail-toward-delivering state: the record is
 * posted, nothing is marked, and the away job owns delivery.
 */

import { eq } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { conversationMessages, conversations } from '@buildd/core/db/schema';
import { CHAT_EVENT_PART_TYPE, type ChatEventData, type ChatMessagePart } from '@buildd/shared';
import { listUndelivered, listUnpostedForConversation, markDelivered, type UndeliveredRow } from '@/lib/subscriptions';
import { watchNotice } from '@/lib/watch-notice';
import { pingConversation } from './store';

/** lib/presence.ts `Presence` (presence PR), the part this module reads. */
export type OwnerPresence = { state: 'present'; conversationId: string | null } | { state: 'away'; reason?: string };

/**
 * Placeholder until lib/presence.ts is in this branch: swap for
 * `import { getPresence } from '@/lib/presence'`. Away is the safe answer.
 */
async function presenceNotYetWired(_userId: string): Promise<OwnerPresence> {
  return { state: 'away', reason: 'unavailable' };
}

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
  getPresence: (userId: string) => Promise<OwnerPresence>;
  insertEvent: (conversationId: string, id: string, parts: ChatMessagePart[], createdAt: Date) => Promise<boolean>;
  ping: (conversationId: string, messageId?: string) => Promise<void>;
}

const DEFAULT_DEPS: WatchDeliveryDeps = {
  listUnposted: listUnpostedForConversation,
  listUndelivered,
  markDelivered,
  getPresence: presenceNotYetWired,
  insertEvent: insertEventOnce,
  ping: (id, messageId) => pingConversation(id, 'event', messageId),
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
  target: { userId: string; conversationId: string },
  deps: Partial<WatchDeliveryDeps> = {},
): Promise<{ delivered: number; marked: number }> {
  const d = { ...DEFAULT_DEPS, ...deps };
  const owner = { userId: target.userId };
  let posted = 0;
  let marked = 0;
  let lastId: string | undefined;
  try {
    for (const r of await d.listUnposted(owner, target.conversationId, { limit: 50 })) {
      if (await postWatchEvent(target.conversationId, r, d)) { posted += 1; lastId = r.id; }
    }
    const presence = await d.getPresence(target.userId).catch((): OwnerPresence => ({ state: 'away', reason: 'unavailable' }));
    if (presence.state === 'present') {
      const pending = (await d.listUndelivered(owner, { limit: 50 })).filter(r => r.conversationId === target.conversationId);
      const oneShot = new Set<string>();
      for (const r of pending) {
        if (r.lifetime === 'one_shot') {
          if (oneShot.has(r.subscriptionId)) continue;
          oneShot.add(r.subscriptionId);
        }
        if ((await d.markDelivered(owner, r.id, { route: 'conversation' })).marked) marked += 1;
      }
    }
  } catch (e) {
    console.warn('[chat] watch delivery failed:', e);
  }
  if (posted > 0) await d.ping(target.conversationId, lastId).catch(() => {});
  return { delivered: posted, marked };
}
