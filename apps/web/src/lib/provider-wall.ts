/**
 * A provider usage wall is a wait, not a failure (provider-failover spec,
 * "A usage wall is a wait").
 *
 * When a runner's model login hits a usage wall (Claude's 5-hour, session,
 * weekly or extra-usage cap, Codex's usage limit) the work waits for the reset
 * the provider quoted and then carries on by itself. The worker PATCH route
 * owns the requeue; this module holds the pure decisions it needs:
 *
 * - `usageWallFromReport`: a wall can arrive as `failed`, as `error`, or as a
 *   `completed` session whose only output is the wall message (the SDK ends a
 *   walled turn as an ordinary result). All three are the same wall.
 * - `isRepeatWallEpisode`: one wall episode is one notice. The 20th task to
 *   hit the same login's wall before its reset is not news.
 * - the `usageWall` context record and its one sentence, read by the task
 *   page and the fleet view: "Waiting for the usage limit to reset at 16:00
 *   UTC (Claude login on runner box-a). Resumes by itself."
 */
import { isBudgetExhaustionError, isSessionBudgetCapError } from '@buildd/core/budget-error-classifier';

/** Context key on `tasks.context` for the wall the task is waiting out. */
export const USAGE_WALL_CONTEXT_KEY = 'usageWall';

/** A completed session's fallback summary longer than this did real work; never read it as a wall. */
const MAX_WALL_SUMMARY_CHARS = 500;

/** Two walls on one login whose quoted resets are this close are the same episode. */
export const WALL_EPISODE_TOLERANCE_MS = 30 * 60 * 1000;

export interface WallReportInput {
  status: string | null | undefined;
  error?: string | null;
  summary?: string | null;
  summarySource?: string | null;
  budgetExhausted?: boolean;
  sessionBudgetCapped?: boolean;
  hasStructuredOutput: boolean;
  hasPr: boolean;
}

/**
 * The wall text when a terminal report is a provider usage wall the route's
 * `failed` budget branch would not otherwise see: an `error` report, or a
 * `completed` one that delivered nothing but the wall message. Null for a
 * `failed` report (that branch already reads it), for the task's own per-session
 * dollar cap (a real task failure), and for anything else.
 */
export function usageWallFromReport(r: WallReportInput): string | null {
  if (r.status !== 'error' && r.status !== 'completed') return null;
  const error = typeof r.error === 'string' ? r.error : null;
  const wallText = (text: string | null) =>
    text && isBudgetExhaustionError(text) ? text : null;
  if (r.status === 'error') {
    const text = wallText(error) ?? (r.budgetExhausted === true && error && !isSessionBudgetCapError(error) ? error : null);
    if (!text) return null;
    if (r.sessionBudgetCapped === true && !isBudgetExhaustionError(text)) return null;
    return text;
  }
  // completed: only a session that delivered nothing. A PR or a structured
  // outcome is a real completion, whatever its closing line said.
  if (r.hasStructuredOutput || r.hasPr) return null;
  const fromError = wallText(error);
  if (fromError) return fromError;
  const summary = typeof r.summary === 'string' ? r.summary.trim() : '';
  if (r.summarySource === 'fallback' && summary.length > 0 && summary.length <= MAX_WALL_SUMMARY_CHARS) {
    return wallText(summary);
  }
  return null;
}

export interface WallEpisodeKey {
  backend: string;
  seatKey: string | null;
  resetsAt: Date;
}

/**
 * True when a pause already in force is the same wall: same backend, same
 * login (seat key, or both shared), and a reset within the tolerance. Each
 * task on the login reports the wall again; only the first one is news.
 */
export function isRepeatWallEpisode(active: readonly WallEpisodeKey[], next: WallEpisodeKey): boolean {
  return active.some(p =>
    p.backend === next.backend &&
    (p.seatKey ?? null) === (next.seatKey ?? null) &&
    Math.abs(p.resetsAt.getTime() - next.resetsAt.getTime()) <= WALL_EPISODE_TOLERANCE_MS,
  );
}

/** What the task context records about the wall it waits out. */
export interface UsageWallRecord {
  /** Provider whose pool ran dry: 'claude' | 'codex'. */
  backend: string;
  /** ISO time the provider quoted (or the session-window fallback). */
  resetsAt: string;
  /** `login`: one runner's (or login's) own wall; other runners can take the task. `pool`: the shared pool. */
  scope: 'login' | 'pool';
  /** The runner whose login hit it, as `workers.runner` names it. */
  runner: string | null;
  /** When the wall was reported. */
  at: string;
}

export function usageWallRecord(o: {
  backend: string;
  resetsAt: Date;
  scope: 'login' | 'pool';
  runner?: string | null;
  now?: Date;
}): UsageWallRecord {
  return {
    backend: o.backend,
    resetsAt: o.resetsAt.toISOString(),
    scope: o.scope,
    runner: o.runner ?? null,
    at: (o.now ?? new Date()).toISOString(),
  };
}

/** The record on a task's context, or null when absent, malformed or already past its reset. */
export function readUsageWall(context: unknown, now: Date = new Date()): UsageWallRecord | null {
  const raw = (context as Record<string, unknown> | null | undefined)?.[USAGE_WALL_CONTEXT_KEY] as Partial<UsageWallRecord> | undefined;
  if (!raw || typeof raw !== 'object' || typeof raw.resetsAt !== 'string' || typeof raw.backend !== 'string') return null;
  const at = new Date(raw.resetsAt);
  if (Number.isNaN(at.getTime()) || at.getTime() <= now.getTime()) return null;
  return {
    backend: raw.backend,
    resetsAt: raw.resetsAt,
    scope: raw.scope === 'login' ? 'login' : 'pool',
    runner: typeof raw.runner === 'string' ? raw.runner : null,
    at: typeof raw.at === 'string' ? raw.at : raw.resetsAt,
  };
}

/** `headless://box-a` → `box-a`: the name a person knows the runner by. */
export function runnerDisplayName(runner: string | null | undefined): string | null {
  if (!runner) return null;
  const bare = runner.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').trim();
  return bare || null;
}

const PROVIDER_LABEL: Record<string, string> = { claude: 'Claude', codex: 'Codex' };

/** "16:00 UTC" — the reset in the one zone every reader shares. */
export function wallResetClock(resetsAt: Date | string): string {
  const d = typeof resetsAt === 'string' ? new Date(resetsAt) : resetsAt;
  return `${d.toISOString().slice(11, 16)} UTC`;
}

/** Who hit the wall, in words: "Claude login on runner box-a", or "the team's Claude pool". */
export function wallHolder(w: Pick<UsageWallRecord, 'backend' | 'scope' | 'runner'>): string {
  const provider = PROVIDER_LABEL[w.backend] ?? w.backend;
  const runner = runnerDisplayName(w.runner);
  if (w.scope === 'login') return runner ? `${provider} login on runner ${runner}` : `a runner's ${provider} login`;
  return runner ? `${provider} usage, hit on runner ${runner}` : `${provider} usage`;
}

/**
 * The one sentence every surface shows for a waiting task:
 * "Waiting for the usage limit to reset at 16:00 UTC (Claude login on runner box-a). Resumes by itself."
 * A login-scoped wall adds that another runner may take it sooner.
 */
export function usageWallLine(w: Pick<UsageWallRecord, 'backend' | 'scope' | 'runner' | 'resetsAt'>): string {
  const sooner = w.scope === 'login' ? ' Resumes by itself, sooner if another runner with budget takes it.' : ' Resumes by itself.';
  return `Waiting for the usage limit to reset at ${wallResetClock(w.resetsAt)} (${wallHolder(w)}).${sooner}`;
}

/** The `Buildd / Review approval` description for a review held by a wall (≤140 chars). */
export function reviewBudgetWaitDescription(resetsAt: Date | string): string {
  return `Review waiting for model budget: resumes ${wallResetClock(resetsAt)}`;
}
