/**
 * Server half of the visible-answer turn signal (./turn-signal.ts): merge a
 * posted signal into the user message's `usage.turn`, first value wins.
 */
import { db } from '@buildd/core/db';
import { conversationMessages } from '@buildd/core/db/schema';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import type { TurnSignal } from './turn-signal';

/** The user message of this conversation the client called `ref`. */
export function turnRowWhere(conversationId: string, ref: string): SQL {
  return and(
    eq(conversationMessages.conversationId, conversationId),
    eq(conversationMessages.role, 'user'),
    sql`${conversationMessages.usage} -> 'turn' ->> 'ref' = ${ref}`,
  )!;
}

/**
 * `incoming || existing`: jsonb concatenation keeps the right side on a key
 * clash, so every key keeps its first value (`mergeTurnSignal` is the spec).
 * Returns whether a row matched; a ref with no saved turn records nothing.
 */
export async function recordTurnSignal(conversationId: string, ref: string, signal: TurnSignal): Promise<boolean> {
  const incoming = JSON.stringify(signal);
  const rows = await db.update(conversationMessages)
    .set({
      usage: sql`jsonb_set(${conversationMessages.usage}, '{turn}', ${incoming}::jsonb || coalesce(${conversationMessages.usage} -> 'turn', '{}'::jsonb))`,
    })
    .where(turnRowWhere(conversationId, ref))
    .returning({ id: conversationMessages.id });
  return rows.length > 0;
}
