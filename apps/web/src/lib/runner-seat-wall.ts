/**
 * Whose Claude limit is this? A runner-scoped wall (task e68327a1).
 *
 * Several host runners can share one runner account (one bld_ key), each
 * running Claude on its own machine's login (`claude login`, or
 * CLAUDE_CODE_OAUTH_TOKEN set on that machine). When one of those logins hits
 * its session or weekly limit, the limit is that machine's, not the account's
 * or the team's: the other runners' logins are fine. Recording it on the
 * account flag or as a team-wide provider pause held every Claude task for
 * every runner until the reset, which for a weekly limit is days.
 *
 * So a Claude subscription wall (session, weekly or extra-usage text) is
 * scoped to the runner that hit it, by a seat key, whenever the worker names
 * that runner (`workers.runner`, the id every runner already sends on claim).
 * A team never shares a subscription wall, whatever credentials the team
 * stores (spec 0dc7c6de R-10): buildd does not pool anyone's subscription.
 *
 * Shared ("no seat key") is left for walls that are not a subscription's: an
 * API rate limit, a Codex wall, tenant work (that has its own tenant budget),
 * and a worker that names no runner. The caller writes no team-wide pause for
 * a subscription wall it could not key.
 *
 * Which key: the limit belongs to the login, and two runners can share one
 * (two processes on one host reading one ~/.claude). A runner on its machine's
 * `claude login` reports `claudeLoginId`, a one-way hash it computes locally
 * from the login's account id (apps/runner/src/host-seat.ts
 * claudeLoginIdentity); the wall is keyed on that, so it holds every runner on
 * the login. With no identity (a CLAUDE_CODE_OAUTH_TOKEN, which says nothing
 * about its account offline, or an older runner) the key is a hash of the
 * runner id, as before. A claim reads walls under both its login key and its
 * runner key. No credential is read, stored or sent.
 */
import { createHash } from 'crypto';
import { INTERACTIVE_RUNNER, UNVERIFIED_INTERACTIVE_RUNNER } from './interactive-session';
import { NON_RUNNER_EXECUTOR_IDS } from './executor';
import {
  CLAUDE_SESSION_LIMIT_PATTERN,
  CLAUDE_WEEKLY_LIMIT_PATTERN,
} from '@buildd/core/budget-error-classifier';

/** Runner ids that do not name one runner process. */
const NOT_A_RUNNER_ID = new Set<string>([
  'runner', // the runner client's default when it was given no id
  INTERACTIVE_RUNNER,
  UNVERIFIED_INTERACTIVE_RUNNER,
  ...NON_RUNNER_EXECUTOR_IDS,
]);

/**
 * The seat key for a runner id, or null when the caller is not one named
 * runner. Opaque on purpose: the runner id can be a host name or a URL.
 */
export function runnerSeatKey(runner: string | null | undefined): string | null {
  const id = (runner ?? '').trim();
  if (!id || NOT_A_RUNNER_ID.has(id)) return null;
  return `runner:${createHash('sha256').update(id).digest('hex').slice(0, 32)}`;
}

/** A runner-reported login identity: the 32-hex-character hash, or null. */
export function parseClaudeLoginId(v: unknown): string | null {
  return typeof v === 'string' && /^[0-9a-f]{32}$/.test(v) ? v : null;
}

/** The seat key for a login identity (parseClaudeLoginId's output). */
export function claudeLoginSeatKey(loginId: string): string {
  return `login:${loginId}`;
}

/**
 * Every seat key a claiming runner answers to: its login's (when it reported
 * one), then its runner's. Null when the caller is not one named runner, so it
 * reads every wall.
 */
export function callerSeatKeys(runner: string | null | undefined, loginId: string | null | undefined): string[] | null {
  const runnerKey = runnerSeatKey(runner);
  if (!runnerKey) return null;
  const id = parseClaudeLoginId(loginId);
  return id ? [claudeLoginSeatKey(id), runnerKey] : [runnerKey];
}

/** Claude subscription walls: what a machine login can run into. */
const MACHINE_LOGIN_WALL_PATTERNS: readonly string[] = [
  CLAUDE_SESSION_LIMIT_PATTERN,
  'session limit',
  CLAUDE_WEEKLY_LIMIT_PATTERN,
  'weekly limit',
  'out of extra usage',
];

export function isMachineLoginWallError(error?: string | null): boolean {
  if (!error) return false;
  const lower = error.toLowerCase();
  return MACHINE_LOGIN_WALL_PATTERNS.some(p => lower.includes(p));
}

export interface RunnerSeatWallInput {
  /** The backend this run used (claimedBackendOf). */
  backend: string | null | undefined;
  error: string | null | undefined;
  /** workers.runner */
  runner: string | null | undefined;
  tenantId: string | null | undefined;
  /**
   * The Claude login this run says it used (the runner's failure report).
   * `stored` (a credential the team keeps server-side) has no machine login
   * identity, so its wall is keyed on the runner.
   */
  loginUsed?: RunLoginUsed | null;
  /**
   * The run's login identity (parseClaudeLoginId), when its runner could tell:
   * a machine-login wall is keyed on it so it holds every runner on the login.
   */
  loginId?: string | null;
}

/** Which Claude login a run used, as the runner reports it. */
export type RunLoginUsed = 'machine_login' | 'machine_token' | 'stored';

export function parseRunLoginUsed(v: unknown): RunLoginUsed | null {
  return v === 'machine_login' || v === 'machine_token' || v === 'stored' ? v : null;
}

export interface RunnerSeatWallDecision {
  /** Set: the wall holds only this runner. Null: the wall is shared. */
  seatKey: string | null;
  /** Why, for the log line. */
  reason: string;
}

/** Decide whether a recorded wall belongs to one runner's login. Never throws. */
export function resolveRunnerSeatWallKey(input: RunnerSeatWallInput): RunnerSeatWallDecision {
  const shared = (reason: string): RunnerSeatWallDecision => ({ seatKey: null, reason });
  if ((input.backend || 'claude') !== 'claude') return shared('not a Claude wall');
  if (!isMachineLoginWallError(input.error)) return shared('not a subscription session or weekly limit');
  if (input.tenantId) return shared('tenant work: the tenant budget is the wall');
  const runnerKey = runnerSeatKey(input.runner);
  if (!runnerKey) return shared('the worker names no runner');
  // A login identity is the runner's own machine login; a run on anything
  // else is keyed on its runner.
  const loginId = input.loginUsed === 'stored' ? null : parseClaudeLoginId(input.loginId);
  return {
    seatKey: loginId ? claudeLoginSeatKey(loginId) : runnerKey,
    reason: loginId ? "the runner's Claude login" : 'the runner that hit it',
  };
}
