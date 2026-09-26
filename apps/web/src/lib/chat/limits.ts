/**
 * Chat spend and rate limits (docs/design/agent-chat.md → Cost and rate limits).
 *
 * Chat spend is inference spend: metered per turn from `usage`, stored on the
 * message, summed per team per local day. It never touches an account's
 * maxCostPerDay / totalCost, which meter runner work.
 */

import { and, eq, gte, sql } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { conversationApprovals, conversationMessages, conversations } from '@buildd/core/db/schema';
import { zonedIsoWithOffset } from './context-block';

/** Turns per user per window. Approvals and resumes count too. */
export const CHAT_RATE_LIMIT = 30;
export const CHAT_RATE_WINDOW_MS = 10 * 60 * 1000;
export const BUDGET_WARN_FRACTION = 0.8;

export type LimitVerdict =
  | { ok: true; budgetWarning: boolean }
  | { ok: false; reason: 'rate_limited' | 'budget_exhausted'; retryAfterSeconds: number };

/** Midnight today in `timeZone`, as an instant. */
export function startOfLocalDay(now: Date, timeZone: string): Date {
  const { iso, date } = zonedIsoWithOffset(now, timeZone);
  const offset = iso.slice(19); // ±HH:MM
  return new Date(`${date}T00:00:00${offset}`);
}

export function evaluateLimits(input: {
  now: Date;
  timeZone: string;
  turnsInWindow: number;
  spentTodayUsd: number;
  dailyBudgetUsd: number | null;
}): LimitVerdict {
  if (input.turnsInWindow >= CHAT_RATE_LIMIT) {
    return { ok: false, reason: 'rate_limited', retryAfterSeconds: Math.ceil(CHAT_RATE_WINDOW_MS / 1000) };
  }
  const cap = input.dailyBudgetUsd;
  if (cap != null && cap >= 0) {
    if (input.spentTodayUsd >= cap) {
      const next = new Date(startOfLocalDay(input.now, input.timeZone).getTime() + 24 * 3600 * 1000);
      return { ok: false, reason: 'budget_exhausted', retryAfterSeconds: Math.max(60, Math.ceil((next.getTime() - input.now.getTime()) / 1000)) };
    }
    return { ok: true, budgetWarning: cap > 0 && input.spentTodayUsd >= cap * BUDGET_WARN_FRACTION };
  }
  return { ok: true, budgetWarning: false };
}

export async function loadLimitInputs(opts: { teamId: string; userId: string; now: Date; timeZone: string }) {
  const windowStart = new Date(opts.now.getTime() - CHAT_RATE_WINDOW_MS);
  const dayStart = startOfLocalDay(opts.now, opts.timeZone);
  const [turns, approvals, spend] = await Promise.all([
    db.select({ n: sql<number>`count(*)::int` }).from(conversationMessages).where(and(
      eq(conversationMessages.authorUserId, opts.userId),
      eq(conversationMessages.role, 'user'),
      gte(conversationMessages.createdAt, windowStart),
    )),
    db.select({ n: sql<number>`count(*)::int` }).from(conversationApprovals).where(and(
      eq(conversationApprovals.proposedForUserId, opts.userId),
      gte(conversationApprovals.decidedAt, windowStart),
    )),
    db.select({ usd: sql<string | null>`coalesce(sum((${conversationMessages.usage}->>'costUsd')::numeric), 0)` })
      .from(conversationMessages)
      .innerJoin(conversations, eq(conversations.id, conversationMessages.conversationId))
      .where(and(
        eq(conversations.teamId, opts.teamId),
        eq(conversationMessages.role, 'assistant'),
        gte(conversationMessages.createdAt, dayStart),
      )),
  ]);
  return {
    turnsInWindow: (turns[0]?.n ?? 0) + (approvals[0]?.n ?? 0),
    spentTodayUsd: Number(spend[0]?.usd ?? 0),
  };
}
