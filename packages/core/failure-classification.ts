/**
 * The one terminal-failure classifier (knowledge-base:
 * buildd/design/backend-failover-policy.md §1; failure-incident-recovery
 * §18.2). Every terminal worker failure is exactly one class:
 *
 *   budget — a provider wall (seat, weekly, quota). Pause or fail over.
 *   auth   — the credential was rejected. Hold the task for the credential.
 *   infra  — Buildd's own machinery lost the session. Requeue the same task.
 *   task   — the work itself failed. The ordinary retry budget applies.
 *
 * `task` is the default for anything unrecognised: an unknown failure must
 * never buy a free retry or a second backend's spend. The `family` slug is
 * what incident cause keys group on, never the raw error text.
 *
 * Pure. Lives in core so the runner and the web app read failures the same way.
 */
import { classifyAuthErrorSeverity } from './auth-error-classifier';
import { isBudgetExhaustionError } from './budget-error-classifier';

export type FailureClass = 'budget' | 'auth' | 'infra' | 'task';

export type FailureFamily =
  | 'budget'
  | 'auth'
  /** A runner or interactive session went away mid-work (stale reap, restart, idle). */
  | 'infra.session_lost'
  /** An interactive (local executor) worker's slot was released; a session re-claims. */
  | 'infra.interactive_released'
  /** Any other infrastructure exit the server already diagnosed (mount gap, CLI gate, refusal). */
  | 'infra.runner'
  | 'task';

export interface FailureClassification {
  class: FailureClass;
  family: FailureFamily;
}

export interface FailureClassificationHints {
  /** The exit cause the server already recorded, when there is one. */
  exitCause?: string | null;
}

const INTERACTIVE_RELEASED = /slot released|local session detached/i;
const SESSION_LOST = /no mcp activity from its session|stale worker expired|process restarted|runner went offline|session (?:was )?lost/i;

const INFRA_EXITS = new Set(['infra_failure', 'sandbox_mount_gap', 'silent_start', 'server_refused']);

export function classifyFailure(
  error: string | null | undefined,
  pattern: string | null | undefined,
  hints: FailureClassificationHints = {},
): FailureClassification {
  const texts = [error, pattern].filter((t): t is string => typeof t === 'string' && t.length > 0);
  const exit = hints.exitCause ?? null;

  if (exit === 'budget_limited' || texts.some(t => isBudgetExhaustionError(t))) return { class: 'budget', family: 'budget' };
  if (exit === 'auth_failure' || texts.some(t => classifyAuthErrorSeverity(t) !== 'none')) return { class: 'auth', family: 'auth' };
  if (exit === 'reassigned' || texts.some(t => INTERACTIVE_RELEASED.test(t))) return { class: 'infra', family: 'infra.interactive_released' };
  if (texts.some(t => SESSION_LOST.test(t))) return { class: 'infra', family: 'infra.session_lost' };
  if (exit && INFRA_EXITS.has(exit)) return { class: 'infra', family: 'infra.runner' };
  return { class: 'task', family: 'task' };
}

/** Owned by Buildd's machinery, not the work: never `code_failure`, never charged. */
export function isInfrastructureClass(c: FailureClass): boolean {
  return c === 'auth' || c === 'infra';
}
