/**
 * Pure helpers for the signals the runner reads off claim responses and
 * session results. Kept out of workers.ts so each rule is unit-testable
 * without constructing a WorkerManager.
 *
 *  - resumeAtForReset:   a claim response can carry a budgetResetsAt that is
 *    already in the past. Scheduling a wake for "now" re-polls immediately,
 *    gets the same past reset back and loops as fast as the network allows.
 *  - ClaimHealth:        a streak of claim 5xx replies used to be invisible —
 *    a 5xx still counts as "server contact", so the heartbeat kept logging
 *    "alive" and recovery waited for the hourly fallback poll.
 *  - session budget cap: the SDK's per-session dollar cap (maxBudgetUsd) is a
 *    task-level stop, not a provider usage wall. Reporting it as budget
 *    exhaustion paused the whole Claude backend for hours.
 *  - sdkMaxBudgetUsd:    a dollar cap is meaningless on a seat (OAuth)
 *    credential, whose reported cost is only an estimate. The Codex backend
 *    already skips it for OAuth; the Claude path now matches.
 */
import type { DoctorReport, CheckResult } from './doctor';

// ── N2: past budget reset ────────────────────────────────────────────────────

export const PAST_RESET_MIN_BACKOFF_MS = 30_000;
export const PAST_RESET_MAX_BACKOFF_MS = 15 * 60_000;

/**
 * When to wake for a reported budget reset. A future reset is honoured as-is.
 * A reset at or before `nowMs` waits 30s, doubling with each consecutive past
 * reset (`pastStreak` is the count seen so far), capped at 15 min.
 */
export function resumeAtForReset(
  resetMs: number,
  nowMs: number,
  pastStreak: number,
): { atMs: number; pastStreak: number } {
  if (resetMs > nowMs) return { atMs: resetMs, pastStreak: 0 };
  const exp = Math.min(Math.max(0, pastStreak), 20);
  const delay = Math.min(PAST_RESET_MIN_BACKOFF_MS * 2 ** exp, PAST_RESET_MAX_BACKOFF_MS);
  return { atMs: nowMs + delay, pastStreak: pastStreak + 1 };
}

// ── N3: claim 5xx streak ─────────────────────────────────────────────────────

export const CLAIM_5XX_DEGRADED_THRESHOLD = 3;
/** Claim poll interval while degraded (instead of the hourly fallback). */
export const DEGRADED_CLAIM_POLL_MS = 5 * 60_000;

export class ClaimHealth {
  streak = 0;
  lastStatus: number | undefined;
  lastFailureAt: number | undefined;

  /** Record a 5xx from the claim endpoint. `becameDegraded` is true only on the crossing. */
  recordServerError(status: number, now: number = Date.now()): { streak: number; becameDegraded: boolean } {
    this.streak++;
    this.lastStatus = status;
    this.lastFailureAt = now;
    return { streak: this.streak, becameDegraded: this.streak === CLAIM_5XX_DEGRADED_THRESHOLD };
  }

  /** Record a successful claim reply. Returns true when this ends a degraded streak. */
  recordSuccess(): boolean {
    const wasDegraded = this.isDegraded();
    this.streak = 0;
    this.lastStatus = undefined;
    this.lastFailureAt = undefined;
    return wasDegraded;
  }

  isDegraded(): boolean {
    return this.streak >= CLAIM_5XX_DEGRADED_THRESHOLD;
  }

  describe(): string {
    return `${this.streak} consecutive claim 5xx (last HTTP ${this.lastStatus ?? '?'})`;
  }

  check(): CheckResult {
    if (this.isDegraded()) {
      return { name: 'claim-health', status: 'error', message: `degraded: ${this.describe()}` };
    }
    if (this.streak > 0) {
      return { name: 'claim-health', status: 'warn', message: this.describe() };
    }
    return { name: 'claim-health', status: 'ok', message: 'Claim endpoint answering' };
  }
}

/** Process-wide tracker, fed by BuilddClient.claimTask. */
export const claimHealth = new ClaimHealth();

/** Log-safe rendering of a 5xx body; an empty body is named rather than logged as nothing. */
export function describeClaimErrorBody(raw: string | undefined | null): string {
  const text = (raw ?? '').trim();
  if (!text) return '(empty body)';
  return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}

/** Append the claim-health check to a doctor report (returns a new report). */
export function withClaimHealthCheck(report: DoctorReport, health: ClaimHealth = claimHealth): DoctorReport {
  const check = health.check();
  const summary = { ...report.summary, [check.status]: report.summary[check.status] + 1 };
  return { ...report, checks: [...report.checks, check], summary };
}

// ── A.2: per-session dollar cap ──────────────────────────────────────────────

/**
 * Error text reported when a session hits its own maxBudgetUsd. Deliberately
 * avoids every phrase in BUDGET_EXHAUSTION_PATTERNS and the claim breaker's
 * classifier: this is a task-level failure, not a provider wall.
 */
export const SESSION_BUDGET_CAP_ERROR = 'Session cost cap reached';

export function isSessionBudgetCapError(err: string | undefined | null): boolean {
  if (!err) return false;
  const lower = err.toLowerCase();
  return lower.includes(SESSION_BUDGET_CAP_ERROR.toLowerCase())
    || lower.includes('maxbudgetusd')
    || lower.includes('error_max_budget_usd');
}

// ── A.3: no dollar cap on seat credentials ───────────────────────────────────

/**
 * True when the Claude session bills per token. The SDK prefers an API key
 * over OAuth, so any non-empty key/auth token means metered; otherwise the
 * session runs on a seat (injected OAuth token, managed CLAUDE_CONFIG_DIR, or
 * the host's own `claude login`).
 */
export function claudeSessionIsMetered(env: Record<string, string | undefined>): boolean {
  return !!(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN);
}

/** The maxBudgetUsd to hand the backend for this session. */
export function sdkMaxBudgetUsd(
  maxBudgetUsd: number | undefined,
  opts: { backend: string; env: Record<string, string | undefined> },
): number | undefined {
  if (maxBudgetUsd === undefined) return undefined;
  // The Codex backend applies its own auth-type rule (skips OAuth).
  if (opts.backend === 'codex') return maxBudgetUsd;
  return claudeSessionIsMetered(opts.env) ? maxBudgetUsd : undefined;
}
