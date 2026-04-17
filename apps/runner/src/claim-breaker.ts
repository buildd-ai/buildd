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

export type BreakerScope = 'global' | 'context';

export interface ClaimErrorClassification {
  label: string;
  pauseMs: number;
  scope: BreakerScope;
}

/** Auth context a task runs under. Failures pause claims for this context. */
export function authContextOf(task: Pick<BuilddTask, 'context'> | null | undefined): string {
  const ctx = (task?.context ?? null) as Record<string, unknown> | null;
  const tenantCtx = (ctx?.tenantContext as { tenantId?: string } | undefined) ?? null;
  const tenantId = tenantCtx?.tenantId;
  return tenantId ? `tenant:${tenantId}` : 'account';
}

/**
 * Classify a worker error for circuit-breaker routing.
 * Returns null if the error is worker-specific (no breaker action).
 *
 * `err` must be lowercased by the caller.
 */
export function classifyClaimError(err: string): ClaimErrorClassification | null {
  const quotaMatch = err.match(/out of extra usage.*resets\s+(\d{1,2}(?:am|pm)?)\s*\((\w+)\)/i);
  if (quotaMatch) {
    return {
      label: `Quota exhausted (resets ${quotaMatch[1]} ${quotaMatch[2]})`,
      pauseMs: parseResetDelay(quotaMatch[1]),
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

  if (err.includes('invalid api key') || err.includes('authentication failed') || err.includes('401 unauthorized') || err.includes('api key is required')) {
    return { label: 'Auth failure', pauseMs: 30 * 60 * 1000, scope: 'context' };
  }

  if (err.includes('max budget') || err.includes('maxbudgetusd') || err.includes('budget exceeded')) {
    return { label: 'Budget limit reached', pauseMs: 60 * 60 * 1000, scope: 'context' };
  }

  return null;
}

/** Parse a reset time like "5pm" or "2am" into ms from now (assumes UTC). */
export function parseResetDelay(timeStr: string): number {
  const hourMatch = timeStr.match(/^(\d{1,2})(am|pm)?$/i);
  if (!hourMatch) return 60 * 60 * 1000;

  let hour = parseInt(hourMatch[1], 10);
  const ampm = hourMatch[2]?.toLowerCase();
  if (ampm === 'pm' && hour < 12) hour += 12;
  if (ampm === 'am' && hour === 12) hour = 0;

  const now = new Date();
  const target = new Date(now);
  target.setUTCHours(hour, 0, 0, 0);
  if (target.getTime() <= now.getTime()) {
    target.setUTCDate(target.getUTCDate() + 1);
  }

  return Math.max(5 * 60 * 1000, Math.min(target.getTime() - now.getTime(), 24 * 60 * 60 * 1000));
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

  snapshot(): Record<string, number> {
    return Object.fromEntries(this.paused);
  }
}
