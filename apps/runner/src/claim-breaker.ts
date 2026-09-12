/**
 * Scoped claim circuit breaker.
 *
 * Failures that apply to a single auth context (account OAuth token, or a
 * specific tenant's API key) pause claims ONLY for that context, so a burned
 * account OAuth budget does not also block tenant tasks that use their own
 * credentials.
 *
 * Truly global failures (e.g. invalid API key on the process, network-level
 * outages, or repeated-rapid generic failures) continue to use the global
 * claimsPaused flag in WorkerManager — this module only handles the scoped
 * cases.
 */

import type { BuilddTask } from './types';
import {
  CLAUDE_SESSION_LIMIT_PATTERN,
  CODEX_USAGE_LIMIT_PATTERN,
} from '@buildd/core/budget-error-classifier';
import {
  clampPauseToQuotedReset,
  matchResetClause,
  resetDelayMsFrom,
  type ResetClause,
} from '@buildd/core/reset-time';

export type BreakerScope = 'global' | 'context';

export interface ClaimErrorClassification {
  label: string;
  pauseMs: number;
  scope: BreakerScope;
}

/** Agent backend a task runs on. */
export type TaskBackend = 'claude' | 'codex';

/**
 * Backend assumed when a task does not declare one. Matches the
 * `task.backend || 'claude'` default used throughout workers.ts — the runner
 * must not invent a different one here or the key it pauses would not be the
 * key it later checks.
 */
export const DEFAULT_BACKEND: TaskBackend = 'claude';

/**
 * Every backend an auth context can be walled for independently. Keep in sync
 * with AgentBackend in @buildd/core/backend-policy; only used to enumerate keys
 * when a task's backend is unknown.
 */
export const CONTEXT_BACKENDS: readonly TaskBackend[] = ['claude', 'codex'];

/** Context key used when a worker's auth context is no longer known. */
export const DEFAULT_AUTH_CONTEXT = `account:${DEFAULT_BACKEND}`;

type ContextualTask = Pick<BuilddTask, 'context' | 'backend'> | null | undefined;

/**
 * Credential scope a task runs under, without the backend suffix: the account's
 * own credentials, or a specific tenant's. Tenant id leads so tenant isolation
 * is decided before anything else.
 */
export function authScopeOf(task: ContextualTask): string {
  const ctx = (task?.context ?? null) as Record<string, unknown> | null;
  const tenantCtx = (ctx?.tenantContext as { tenantId?: string } | undefined) ?? null;
  const tenantId = tenantCtx?.tenantId;
  return tenantId ? `tenant:${tenantId}` : 'account';
}

/**
 * Auth context a task runs under. Failures pause claims for this context.
 *
 * Keyed `account:<backend>` / `tenant:<id>:<backend>`. The backend suffix is
 * load-bearing: providers exhaust independently, so a Codex usage wall must not
 * pause the Claude-backend tasks checked against the same account. The server
 * already models pauses per backend (`backend_pauses` +
 * apps/web/src/lib/backend-failover.ts); this keeps the runner consistent with
 * it instead of conflating the two providers into one key.
 */
export function authContextOf(task: ContextualTask): string {
  const backend = (task?.backend || DEFAULT_BACKEND) as TaskBackend;
  return `${authScopeOf(task)}:${backend}`;
}

/**
 * Detect a credential/auth failure from an error or agent-output string.
 *
 * Covers the `401 Invalid authentication credentials` / credential-expired
 * family — used both on the claim path and when a spawned agent fails, so a
 * runner running purely on server-managed creds can pause + invalidate the
 * cached (bad) credential instead of burn-looping.
 *
 * `text` must be lowercased by the caller.
 */
export function isAuthError(text: string): boolean {
  return (
    text.includes('invalid api key') ||
    text.includes('invalid authentication') ||
    text.includes('authentication failed') ||
    text.includes('401 unauthorized') ||
    text.includes('api key is required') ||
    text.includes('please run /login') ||
    text.includes('oauth token has expired') ||
    text.includes('credential expired') ||
    text.includes('credentials expired')
  );
}

/**
 * Freeze to serve when a provider announced exhaustion but quoted no reset
 * time we could read (no clause at all, or a timezone we refuse to guess at).
 *
 * Named and visible on purpose: its predecessor was `parseResetDelay`'s hidden
 * 1-hour return for unparseable input, which a caller could not tell apart
 * from a provider that really did say "one hour".
 */
const NO_READABLE_RESET_PAUSE_MS = 5 * 60 * 60 * 1000;

/** Render a reset clause the way the provider wrote it, for labels and logs. */
function quoted(clause: ResetClause): string {
  return clause.timezone ? `${clause.time} ${clause.timezone}` : clause.time;
}

/**
 * Pause until the reset the error text quoted, or `NO_READABLE_RESET_PAUSE_MS`
 * when there is no readable reset — logging the fallback so an unparsed clause
 * is visible in the runner log rather than silently indistinguishable from a
 * real duration.
 */
function pauseUntilQuotedReset(err: string, now: Date, kind: string): number {
  const derived = resetDelayMsFrom(err, { now });
  if (derived !== null) return derived;
  const clause = matchResetClause(err);
  console.warn(
    `[claim-breaker] ${kind}: no readable reset time` +
      (clause ? ` (could not interpret "${quoted(clause)}")` : ' (none quoted)') +
      ` — falling back to ${Math.round(NO_READABLE_RESET_PAUSE_MS / 60_000)} min`,
  );
  return NO_READABLE_RESET_PAUSE_MS;
}

/**
 * Classify a worker error for circuit-breaker routing.
 * Returns null if the error is worker-specific (no breaker action).
 *
 * `err` must be lowercased by the caller. `now` is injectable so pause
 * durations are testable to the millisecond — the reset-time bug this signature
 * change came out of survived because its tests could only assert positivity.
 */
export function classifyClaimError(
  err: string,
  now: Date = new Date(),
): ClaimErrorClassification | null {
  const result = classifyExhaustion(err, now);
  if (!result) return null;

  // Invariant: no pause may outlast the reset instant the provider's own text
  // quoted — including the flat per-branch defaults below, which never look at
  // the reset clause. See `clampPauseToQuotedReset`.
  const { pauseMs, clampedFromMs } = clampPauseToQuotedReset(err, result.pauseMs, { now });
  if (clampedFromMs !== null) {
    console.warn(
      `[claim-breaker] ${result.label}: a ${Math.round(clampedFromMs / 60_000)} min pause would ` +
        `outlast the reset the provider quoted — clamped to ${Math.round(pauseMs / 60_000)} min`,
    );
  }
  return { ...result, pauseMs };
}

function classifyExhaustion(err: string, now: Date): ClaimErrorClassification | null {
  // Dollar-budget exhaustion with a stated reset: "you're out of extra usage ·
  // resets 11:20am (UTC)". Keyed on the phrase alone, not on a reset clause —
  // the old regex demanded an hours-only clause in the same match, so a reset
  // carrying minutes classified as nothing at all and no breaker tripped.
  if (err.includes('out of extra usage')) {
    const clause = matchResetClause(err);
    return {
      label: clause ? `Quota exhausted (resets ${quoted(clause)})` : 'Quota exhausted',
      pauseMs: pauseUntilQuotedReset(err, now, 'Quota exhausted'),
      scope: 'context',
    };
  }

  // OAuth seat session cap: "You've hit your session limit · resets 8:40pm (UTC)"
  // Must be checked BEFORE generic rate-limit patterns — 'session limit' is an
  // exhaustion event with a known reset time, not a transient 429.
  if (err.includes('session limit') || err.includes(CLAUDE_SESSION_LIMIT_PATTERN)) {
    const clause = matchResetClause(err);
    return {
      label: clause ? `Session limit hit (resets ${quoted(clause)})` : 'Session limit hit',
      pauseMs: pauseUntilQuotedReset(err, now, 'Session limit hit'),
      scope: 'context',
    };
  }

  // Codex quota wall: "You've hit your usage limit. Upgrade to Pro (...) or
  // try again at 3:45pm." Anchored on the same CODEX_USAGE_LIMIT_PATTERN the
  // web route's isBudgetExhaustionError checks, so this branch cannot drift
  // out of sync with what actually flags the account/backend as exhausted.
  // Checked before generic rate-limit patterns for the same reason as the
  // session-limit case above: this is an exhaustion event with a known reset
  // time, not a transient 429.
  if (err.includes(CODEX_USAGE_LIMIT_PATTERN)) {
    const clause = matchResetClause(err);
    return {
      label: clause ? `Usage limit hit (try again ${quoted(clause)})` : 'Usage limit hit',
      pauseMs: pauseUntilQuotedReset(err, now, 'Usage limit hit'),
      scope: 'context',
    };
  }

  if (err.includes('oauth budget exhausted') || (err.includes('429') && err.includes('budget exhausted'))) {
    return { label: 'OAuth budget exhausted', pauseMs: 60 * 60 * 1000, scope: 'context' };
  }

  if (err.includes('rate limit') || err.includes('rate_limit') || err.includes('too many requests')) {
    return { label: 'Rate limited', pauseMs: 5 * 60 * 1000, scope: 'global' };
  }
  if (err.includes('overloaded') || err.includes('529') || err.includes('service unavailable')) {
    return { label: 'API overloaded', pauseMs: 2 * 60 * 1000, scope: 'global' };
  }

  if (err.includes('billing') || err.includes('insufficient credits') || err.includes('payment') || err.includes('out_of_credits')) {
    return { label: 'Billing error', pauseMs: 60 * 60 * 1000, scope: 'context' };
  }

  if (isAuthError(err)) {
    return { label: 'Auth failure', pauseMs: 30 * 60 * 1000, scope: 'context' };
  }

  if (err.includes('max budget') || err.includes('maxbudgetusd') || err.includes('budget exceeded')) {
    return { label: 'Budget limit reached', pauseMs: 60 * 60 * 1000, scope: 'context' };
  }

  return null;
}

/**
 * Parse a bare reset time like "5pm", "2am" or "10:58 pm" into ms from now.
 *
 * @deprecated Thin wrapper over `resetDelayMsFrom`, kept for existing callers
 * and tests that hand it a pre-extracted time token. Pass the whole error text
 * to `resetDelayMsFrom` instead: it reads the provider's wording itself, honours
 * minutes and a spaced meridiem, and returns null — rather than a guess — when
 * there is nothing readable. The 1-hour return here is that old guess.
 */
export function parseResetDelay(timeStr: string, now: Date = new Date()): number {
  return resetDelayMsFrom(`resets ${timeStr}`, { now }) ?? 60 * 60 * 1000;
}

/**
 * Per-auth-context pause tracker. Used alongside (not instead of) the global
 * `claimsPaused` flag in WorkerManager.
 */
export class ContextBreaker {
  private paused = new Map<string, number>();

  isPaused(ctx: string, now: number = Date.now()): boolean {
    const until = this.paused.get(ctx);
    if (!until) return false;
    if (now >= until) {
      this.paused.delete(ctx);
      return false;
    }
    return true;
  }

  /** Pause `ctx` until `untilMs`. Never shortens an existing longer pause. */
  pause(ctx: string, untilMs: number): void {
    const prev = this.paused.get(ctx);
    if (prev !== undefined && prev >= untilMs) return;
    this.paused.set(ctx, untilMs);
  }

  pausedUntil(ctx: string): number | null {
    return this.paused.get(ctx) ?? null;
  }

  clear(ctx: string): void {
    this.paused.delete(ctx);
  }

  /**
   * Currently-paused contexts and their expiry.
   *
   * Prunes expired entries first: this feeds the debug surface, and a stale key
   * there would report a pause that no longer exists — a false signal of
   * exactly the kind that made the original incident hard to read.
   */
  snapshot(now: number = Date.now()): Record<string, number> {
    for (const [ctx, until] of this.paused) {
      if (now >= until) this.paused.delete(ctx);
    }
    return Object.fromEntries(this.paused);
  }
}

/**
 * Earliest future pause expiry in a breaker snapshot, or null when nothing is
 * paused. Pure so the wake-up scheduling can be tested without timers.
 */
export function nextContextWake(
  snapshot: Record<string, number>,
  now: number = Date.now(),
): number | null {
  let earliest: number | null = null;
  for (const until of Object.values(snapshot)) {
    if (until <= now) continue;
    if (earliest === null || until < earliest) earliest = until;
  }
  return earliest;
}

/**
 * Should the nudge path drop this task because its auth context is walled?
 * Returns the offending key (and when it lifts) if so, else null.
 *
 * Fails TOWARD claiming when the backend is unknown — a Pusher payload from a
 * server predating the `backend` field. Dropping a nudge we cannot key would
 * silently discard work, which is the defect being fixed; attempting it costs
 * at most one worker row, and the resulting failure re-trips the breaker. So an
 * unknown backend is only skipped when EVERY backend for the scope is walled.
 */
export function pausedContextFor(
  breaker: ContextBreaker,
  task: ContextualTask,
  now: number = Date.now(),
): { key: string; until: number | null } | null {
  const scope = authScopeOf(task);
  const backend = task?.backend;

  if (backend) {
    const key = `${scope}:${backend}`;
    return breaker.isPaused(key, now) ? { key, until: breaker.pausedUntil(key) } : null;
  }

  const keys = CONTEXT_BACKENDS.map(b => `${scope}:${b}`);
  if (!keys.every(k => breaker.isPaused(k, now))) return null;
  const untils = keys
    .map(k => breaker.pausedUntil(k))
    .filter((n): n is number => n !== null);
  // Report the soonest recovery of the walled set, not the longest wall.
  return { key: `${scope}:*`, until: untils.length > 0 ? Math.min(...untils) : null };
}
