/**
 * What a person, and each person on a team, spent: Interactive (server-side AI,
 * metered per turn on conversation_messages.usage) and Agent runs (runner work,
 * workers.cost_usd), today and this month in the team's timezone.
 *
 * Agent runs are attributed to the person who created the run's mission; runs
 * with no mission have no person and are reported as unattributed. On a
 * subscription seat, agent-run cost is the SDK's virtual figure, not a bill.
 */

import { sql, type SQL } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { zonedIsoWithOffset } from '@/lib/chat/context-block';
import { startOfLocalDay } from '@/lib/chat/limits';

export interface Split { today: number; month: number }
export interface PersonSpend { userId: string; label: string; interactive: Split; agent: Split }
export interface SpendSummary {
  me: { interactive: Split; agent: Split };
  /** Every member, most spend this month first. */
  people: PersonSpend[];
  /** Agent runs with no mission, so no person. */
  unattributedAgent: Split;
}

type Row = { user_id: string | null; today: unknown; month: unknown };
type Member = { userId: string; name: string | null; email: string | null };

function offsetMs(at: Date, timeZone: string): number {
  const off = zonedIsoWithOffset(at, timeZone).iso.slice(19); // ±HH:MM
  const sign = off.startsWith('-') ? -1 : 1;
  const [h, m] = off.slice(1).split(':').map(Number);
  return sign * ((h || 0) * 60 + (m || 0)) * 60_000;
}

/** Midnight on the 1st of the current month in `timeZone`, as an instant. */
export function startOfLocalMonth(now: Date, timeZone: string): Date {
  const [y, mo] = zonedIsoWithOffset(now, timeZone).date.split('-').map(Number);
  const wall = Date.UTC(y, mo - 1, 1);
  // The offset at local midnight on the 1st, which can differ from now's (DST).
  let t = wall - offsetMs(new Date(wall), timeZone);
  t = wall - offsetMs(new Date(t), timeZone);
  return new Date(t);
}

interface Window { teamId: string; dayStart: Date; monthStart: Date }

export function interactiveSpendSql(w: Window): SQL {
  const cost = sql`(m."usage"->>'costUsd')::numeric`;
  return sql`
    select c."created_by_user_id" as "user_id",
      coalesce(sum(${cost}) filter (where m."created_at" >= ${w.dayStart.toISOString()}::timestamptz), 0) as "today",
      coalesce(sum(${cost}), 0) as "month"
    from "conversation_messages" m join "conversations" c on c."id" = m."conversation_id"
    where c."team_id" = ${w.teamId}
      and m."role" in ('user', 'assistant')
      and m."created_at" >= ${w.monthStart.toISOString()}::timestamptz
    group by c."created_by_user_id"
  `;
}

export function agentSpendSql(w: Window): SQL {
  const at = sql`coalesce(w."started_at", w."created_at")`;
  return sql`
    select ms."created_by_user_id" as "user_id",
      coalesce(sum(w."cost_usd") filter (where ${at} >= ${w.dayStart.toISOString()}::timestamptz), 0) as "today",
      coalesce(sum(w."cost_usd"), 0) as "month"
    from "workers" w join "workspaces" ws on ws."id" = w."workspace_id"
    left join "tasks" t on t."id" = w."task_id" left join "missions" ms on ms."id" = t."mission_id"
    where ws."team_id" = ${w.teamId}
      and ${at} >= ${w.monthStart.toISOString()}::timestamptz
    group by ms."created_by_user_id"
  `;
}

const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const split = (r: Row | undefined): Split => ({ today: num(r?.today), month: num(r?.month) });

export function foldSpend(input: { userId: string; interactive: Row[]; agent: Row[]; members: Member[] }): SpendSummary {
  const iBy = new Map(input.interactive.filter((r) => r.user_id).map((r) => [r.user_id!, r]));
  const aBy = new Map(input.agent.filter((r) => r.user_id).map((r) => [r.user_id!, r]));
  const people = input.members
    .map((m) => ({
      userId: m.userId,
      label: m.name || m.email || 'Unknown',
      interactive: split(iBy.get(m.userId)),
      agent: split(aBy.get(m.userId)),
    }))
    .sort((a, b) => (b.interactive.month + b.agent.month) - (a.interactive.month + a.agent.month));
  return {
    me: { interactive: split(iBy.get(input.userId)), agent: split(aBy.get(input.userId)) },
    people,
    unattributedAgent: split(input.agent.find((r) => !r.user_id)),
  };
}

type Exec = (q: SQL) => Promise<{ rows?: unknown[] }>;
const dbExec: Exec = (q) => db.execute(q) as unknown as Promise<{ rows?: unknown[] }>;

export async function loadSpendSummary(
  opts: { teamId: string; userId: string; timeZone: string; now: Date; members: Member[] },
  deps: { exec?: Exec } = {},
): Promise<SpendSummary> {
  const exec = deps.exec ?? dbExec;
  const w = { teamId: opts.teamId, dayStart: startOfLocalDay(opts.now, opts.timeZone), monthStart: startOfLocalMonth(opts.now, opts.timeZone) };
  const [i, a] = await Promise.all([exec(interactiveSpendSql(w)), exec(agentSpendSql(w))]);
  return foldSpend({ userId: opts.userId, interactive: (i.rows ?? []) as Row[], agent: (a.rows ?? []) as Row[], members: opts.members });
}
