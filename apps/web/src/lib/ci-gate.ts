/**
 * CI gate resolution for the Home action queue.
 *
 * A red PR is only "waiting on you" when no agent is fixing it. While a
 * `[CI Retry]` attempt is live (see lib/ci-retry.ts) the card is informational;
 * once retries are spent it becomes a human decision, and the card leads with
 * the last agent's own recommendation rather than a Merge button.
 */

export type PrLifecycle =
  | 'pr_open' | 'ci_running' | 'ci_green' | 'ci_failed' | 'conflict' | 'merged' | 'closed' | null;

export interface CiGateInput {
  prLifecycleStatus: PrLifecycle;
  /** Live `[CI Retry]` attempt task for this PR, if one is running. */
  liveFixTaskId?: string | null;
  liveFixIteration?: number | null;
  /** Workspace gitConfig.maxCiRetries — 0 means automatic retries are off. */
  maxCiRetries?: number | null;
  /** Terminal fix attempts already made for this PR. */
  attemptsConsumed?: number;
  /** result.nextSuggestion from the last attempt — the agent's handoff advice. */
  recommendation?: string | null;
}

export type CiGate =
  | { kind: 'fixing'; label: string; taskId: string | null }
  | { kind: 'running'; label: string }
  | { kind: 'blocked'; reason: string; recommendation: string | null };

export function resolveCiGate(input: CiGateInput): CiGate | null {
  const status = input.prLifecycleStatus;
  if (status !== 'ci_failed' && status !== 'ci_running') return null;

  // An agent holding the fix takes precedence over the raw check state — a
  // retry that pushed a new commit shows as ci_running while it iterates.
  if (input.liveFixTaskId) {
    const max = input.maxCiRetries ?? null;
    const label = input.liveFixIteration != null
      ? `Fixing CI · attempt ${input.liveFixIteration}${max ? ` of ${max}` : ''}`
      : 'Fixing CI';
    return { kind: 'fixing', label, taskId: input.liveFixTaskId };
  }

  if (status === 'ci_running') return { kind: 'running', label: 'CI running' };

  const recommendation = input.recommendation ?? null;
  const max = input.maxCiRetries ?? null;
  const consumed = input.attemptsConsumed ?? 0;

  if (max === 0) {
    return { kind: 'blocked', reason: 'CI failing — automatic fix retries are disabled', recommendation };
  }
  if (max != null && consumed >= max) {
    return {
      kind: 'blocked',
      reason: `CI failing — ${consumed} fix attempt${consumed === 1 ? '' : 's'} exhausted`,
      recommendation,
    };
  }
  return { kind: 'blocked', reason: 'CI failing — no fix in flight', recommendation };
}
