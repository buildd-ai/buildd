/**
 * Chat spend and rate limits (docs/design/agent-chat.md → Cost and rate limits).
 *
 * Chat spend is inference spend: metered per turn from `usage` (the generative
 * call plus the routing decision call in front of it), stored on the messages,
 * summed per team and per person per day in the team's timezone. It never
 * touches an account's maxCostPerDay / totalCost, which meter runner work.
 *
 * Three limits, checked before any model call:
 *  1. the team's daily budget — `teams.chatDailyBudgetUsd`, or
 *     DEFAULT_CHAT_DAILY_BUDGET_USD when unset (unset is never "unlimited");
 *  2. each person's daily share of it — `teams.chatUserDailyBudgetUsd`, or
 *     DEFAULT_CHAT_USER_SHARE of the team budget, clamped to the team budget;
 *  3. CHAT_RATE_LIMIT turns per person per CHAT_RATE_WINDOW_MS, admitted by one
 *     conditional upsert (see admitTurnSql) so parallel requests can't overrun it.
 *
 * Owners and admins change 1 and 2 with PATCH /api/teams/[id].
 */

import { sql, type SQL } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { zonedIsoWithOffset } from './context-block';

/** Turns per user per window. Approvals and resumes count too. */
export const CHAT_RATE_LIMIT = 30;
export const CHAT_RATE_WINDOW_MS = 10 * 60 * 1000;
export const BUDGET_WARN_FRACTION = 0.8;
/** A team that never set a chat budget gets this much per day, in USD. */
export const DEFAULT_CHAT_DAILY_BUDGET_USD = 20;
/** Without an explicit per-person cap, one person may spend this fraction of the team budget per day. */
export const DEFAULT_CHAT_USER_SHARE = 0.5;

export type LimitVerdict =
  | { ok: true; budgetWarning: boolean }
  | {
      ok: false;
      reason: 'rate_limited' | 'budget_exhausted';
      /** For budget_exhausted: whose budget ran out. */
      scope?: 'team' | 'user';
      retryAfterSeconds: number;
      /** Shown to the user as-is. */
      message: string;
    };

export interface ChatBudgetSettings {
  dailyBudgetUsd: number | null;
  userDailyBudgetUsd: number | null;
}

export interface ChatBudgets {
  teamUsd: number;
  userUsd: number;
  /** The team never set a budget, so the default applies. */
  teamIsDefault: boolean;
}

const validUsd = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

export function resolveChatBudgets(s: ChatBudgetSettings): ChatBudgets {
  const teamIsDefault = !validUsd(s.dailyBudgetUsd);
  const teamUsd = teamIsDefault ? DEFAULT_CHAT_DAILY_BUDGET_USD : s.dailyBudgetUsd!;
  const userUsd = validUsd(s.userDailyBudgetUsd)
    ? Math.min(s.userDailyBudgetUsd, teamUsd)
    : teamUsd * DEFAULT_CHAT_USER_SHARE;
  return { teamUsd, userUsd, teamIsDefault };
}

/** Midnight today in `timeZone`, as an instant. */
export function startOfLocalDay(now: Date, timeZone: string): Date {
  const { iso, date } = zonedIsoWithOffset(now, timeZone);
  const offset = iso.slice(19); // ±HH:MM
  return new Date(`${date}T00:00:00${offset}`);
}

const usd = (n: number) => `$${n.toFixed(2)}`;

/** "about 3 hours", "12 minutes" — for a reset or retry time. */
export function roughDuration(seconds: number): string {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  return `about ${hours} hour${hours === 1 ? '' : 's'}`;
}

export function evaluateBudget(input: {
  now: Date;
  timeZone: string;
  teamSpentUsd: number;
  userSpentUsd: number;
  budgets: ChatBudgets;
}): LimitVerdict {
  const { budgets: b } = input;
  const nextMidnight = new Date(startOfLocalDay(input.now, input.timeZone).getTime() + 24 * 3600 * 1000);
  const retryAfterSeconds = Math.max(60, Math.ceil((nextMidnight.getTime() - input.now.getTime()) / 1000));
  const resets = `It resets at midnight ${input.timeZone}, in ${roughDuration(retryAfterSeconds)}.`;

  if (input.teamSpentUsd >= b.teamUsd) {
    const which = b.teamIsDefault ? `the default daily chat budget of ${usd(b.teamUsd)}` : `its daily chat budget of ${usd(b.teamUsd)}`;
    return {
      ok: false, reason: 'budget_exhausted', scope: 'team', retryAfterSeconds,
      message: `Your team has used ${which}. ${resets} A team owner or admin can raise the budget. The mission form still works.`,
    };
  }
  if (input.userSpentUsd >= b.userUsd) {
    return {
      ok: false, reason: 'budget_exhausted', scope: 'user', retryAfterSeconds,
      message: `You've used your daily chat limit of ${usd(b.userUsd)} (the team budget is ${usd(b.teamUsd)}). ${resets} A team owner or admin can raise the per-person limit. The mission form still works.`,
    };
  }
  const warn = (spent: number, cap: number) => cap > 0 && spent >= cap * BUDGET_WARN_FRACTION;
  return { ok: true, budgetWarning: warn(input.teamSpentUsd, b.teamUsd) || warn(input.userSpentUsd, b.userUsd) };
}

export function rateLimitedVerdict(retryAfterSeconds: number): LimitVerdict {
  return {
    ok: false, reason: 'rate_limited', retryAfterSeconds,
    message: `You've sent ${CHAT_RATE_LIMIT} chat turns in the last ${CHAT_RATE_WINDOW_MS / 60_000} minutes. Try again in ${roughDuration(retryAfterSeconds)}.`,
  };
}

// ── Turn admission ────────────────────────────────────────────────────────────

/**
 * Record a turn for `userId` iff fewer than CHAT_RATE_LIMIT fall in the window.
 *
 * One statement: INSERT … ON CONFLICT DO UPDATE … WHERE <count in window> <
 * limit … RETURNING. The conflicting row is locked before the WHERE is
 * evaluated, and a concurrent statement re-checks against the committed row,
 * so N parallel requests serialize and at most the remaining slots return a
 * row. Timestamps outside the window are pruned on every write.
 */
export function admitTurnSql(opts: { userId: string; now: Date }): SQL {
  const now = opts.now.toISOString();
  const cutoff = new Date(opts.now.getTime() - CHAT_RATE_WINDOW_MS).toISOString();
  return sql`
    insert into "chat_turn_windows" ("user_id", "turn_at", "updated_at")
    values (${opts.userId}, array[${now}::timestamptz], ${now}::timestamptz)
    on conflict ("user_id") do update set
      "turn_at" = array_append(
        array(select t from unnest("chat_turn_windows"."turn_at") as t where t > ${cutoff}::timestamptz order by t),
        ${now}::timestamptz
      ),
      "updated_at" = ${now}::timestamptz
    where (select count(*) from unnest("chat_turn_windows"."turn_at") as t where t > ${cutoff}::timestamptz) < ${CHAT_RATE_LIMIT}
    returning cardinality("turn_at") as "turns"
  `;
}

function oldestTurnSql(opts: { userId: string; now: Date }): SQL {
  const cutoff = new Date(opts.now.getTime() - CHAT_RATE_WINDOW_MS).toISOString();
  return sql`
    select min(t) as "oldest"
    from "chat_turn_windows", unnest("chat_turn_windows"."turn_at") as t
    where "chat_turn_windows"."user_id" = ${opts.userId} and t > ${cutoff}::timestamptz
  `;
}

type Exec = (q: SQL) => Promise<{ rows?: unknown[] }>;
const dbExec: Exec = q => db.execute(q) as unknown as Promise<{ rows?: unknown[] }>;

export type Admission = { ok: true } | { ok: false; retryAfterSeconds: number };

export async function admitTurn(opts: { userId: string; now: Date }, deps: { exec?: Exec } = {}): Promise<Admission> {
  const exec = deps.exec ?? dbExec;
  const admitted = await exec(admitTurnSql(opts));
  if ((admitted.rows ?? []).length > 0) return { ok: true };
  const r = await exec(oldestTurnSql(opts));
  const oldest = (r.rows?.[0] as { oldest?: string | Date | null } | undefined)?.oldest;
  const frees = oldest ? new Date(oldest).getTime() + CHAT_RATE_WINDOW_MS : opts.now.getTime() + CHAT_RATE_WINDOW_MS;
  return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((frees - opts.now.getTime()) / 1000)) };
}

// ── Spend ─────────────────────────────────────────────────────────────────────

/**
 * Today's chat spend for the team and for one person. Counts every metered
 * message: assistant turns and the routing cost stored on user messages.
 * Conversations are personal, so a person's spend is their conversations'.
 */
export async function loadChatSpend(opts: { teamId: string; userId: string; dayStart: Date }): Promise<{ teamUsd: number; userUsd: number }> {
  const r = await db.execute(sql`
    select
      coalesce(sum((m."usage"->>'costUsd')::numeric), 0) as "team",
      coalesce(sum((m."usage"->>'costUsd')::numeric) filter (where c."created_by_user_id" = ${opts.userId}), 0) as "user"
    from "conversation_messages" m
    join "conversations" c on c."id" = m."conversation_id"
    where c."team_id" = ${opts.teamId}
      and m."role" in ('user', 'assistant')
      and m."created_at" >= ${opts.dayStart.toISOString()}::timestamptz
  `) as unknown as { rows?: Array<{ team?: unknown; user?: unknown }> };
  const row = r.rows?.[0];
  return { teamUsd: Number(row?.team ?? 0) || 0, userUsd: Number(row?.user ?? 0) || 0 };
}

// ── The check ─────────────────────────────────────────────────────────────────

/**
 * Budget first (a read; a refusal consumes nothing), then atomic admission.
 * A turn that passes has already been counted against the rate window.
 *
 * Budget is checked against spend already recorded, so turns in flight at the
 * same moment can finish a little past the cap; admission bounds how many.
 */
export async function checkChatLimits(
  opts: { teamId: string; userId: string; now: Date; settings: ChatBudgetSettings & { timezone: string | null } },
  deps: {
    loadSpend?: typeof loadChatSpend;
    admit?: (o: { userId: string; now: Date }) => Promise<Admission>;
  } = {},
): Promise<LimitVerdict> {
  const timeZone = opts.settings.timezone || 'UTC';
  const dayStart = startOfLocalDay(opts.now, timeZone);
  const spent = await (deps.loadSpend ?? loadChatSpend)({ teamId: opts.teamId, userId: opts.userId, dayStart });
  const budget = evaluateBudget({
    now: opts.now, timeZone, teamSpentUsd: spent.teamUsd, userSpentUsd: spent.userUsd,
    budgets: resolveChatBudgets(opts.settings),
  });
  if (!budget.ok) return budget;
  const admission = await (deps.admit ?? admitTurn)({ userId: opts.userId, now: opts.now });
  if (!admission.ok) return rateLimitedVerdict(admission.retryAfterSeconds);
  return budget;
}
