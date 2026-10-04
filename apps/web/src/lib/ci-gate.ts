/**
 * CI/review gate resolution for the Home action queue.
 *
 * A red PR is only "waiting on you" when no agent is fixing it, and a PR with
 * an outstanding reviewer request-changes verdict is only "waiting on you to
 * merge" once no fix for it is queued or running. While a `[CI Retry]`
 * attempt (lib/ci-retry.ts) or a reviewer-retry attempt (dispatched from
 * `handleReviewerOutcomeIfNeeded`) is live, the card is informational; once CI
 * retries are spent it becomes a human decision, and the card leads with the
 * last agent's own recommendation rather than a Merge button.
 */

export type PrLifecycle =
  | 'pr_open' | 'ci_running' | 'ci_green' | 'ci_failed' | 'conflict' | 'merged' | 'closed'
  // Terminal: the reconcile sweep could not resolve this PR against GitHub and
  // gave up. See lib/pr-freshness.ts. Never a CI state, so resolveCiGate
  // returns null for it, same as any other non-CI status.
  | 'unresolvable'
  | null;

export interface CiGateInput {
  prLifecycleStatus: PrLifecycle;
  /** Live `[CI Retry]` or reviewer-retry attempt task for this PR, if one exists. */
  liveFixTaskId?: string | null;
  liveFixIteration?: number | null;
  /** Workspace gitConfig.maxCiRetries — 0 means automatic retries are off. */
  maxCiRetries?: number | null;
  /** Terminal fix attempts already made for this PR. */
  attemptsConsumed?: number;
  /** result.nextSuggestion from the last attempt — the agent's handoff advice. */
  recommendation?: string | null;
  /**
   * `'ci'` (default) for a `[CI Retry]` attempt; `'review'` for a fix
   * dispatched off a reviewer's request-changes verdict. Only changes the
   * label and which word names the trigger — the precedence rule (a live fix
   * outranks a merge/review CTA) is identical either way, and applies even
   * when CI is currently green, which is the case a reviewer retry sits on.
   */
  liveFixKind?: 'ci' | 'review';
  /**
   * Whether a worker has claimed `liveFixTaskId` yet. Only read for
   * `liveFixKind: 'review'` — a CI retry is dispatched close enough to its
   * claim that queued-vs-running hasn't needed its own word here.
   */
  liveFixClaimed?: boolean | null;
  /** `tasks.title` of the live fix task — the actual thing a reader can follow, not just an iteration count. */
  liveFixTaskTitle?: string | null;
}

export type CiGate =
  | { kind: 'fixing'; label: string; taskId: string | null; taskTitle: string | null; fixKind: 'ci' | 'review' }
  | { kind: 'running'; label: string }
  | { kind: 'blocked'; reason: string; recommendation: string | null };

export function resolveCiGate(input: CiGateInput): CiGate | null {
  const status = input.prLifecycleStatus;

  // An agent holding a fix takes precedence over the raw CI/review state — a
  // retry that pushed a new commit shows as ci_running while it iterates, and
  // a reviewer-retry attempt sits on top of a head that may already be
  // ci_green. Checked before the CI-lifecycle gate below so it fires either way.
  if (input.liveFixTaskId) {
    const max = input.maxCiRetries ?? null;
    const kind = input.liveFixKind ?? 'ci';
    const taskTitle = input.liveFixTaskTitle ?? null;
    if (kind === 'review') {
      const fixName = input.liveFixIteration != null
        ? `Fix ${input.liveFixIteration}${max ? ` of ${max}` : ''}`
        : 'Fix';
      const label = `${fixName} ${input.liveFixClaimed ? 'in progress' : 'queued'}`;
      return { kind: 'fixing', label, taskId: input.liveFixTaskId, taskTitle, fixKind: 'review' };
    }
    const label = input.liveFixIteration != null
      ? `Fixing CI · attempt ${input.liveFixIteration}${max ? ` of ${max}` : ''}`
      : 'Fixing CI';
    return { kind: 'fixing', label, taskId: input.liveFixTaskId, taskTitle, fixKind: 'ci' };
  }

  if (status !== 'ci_failed' && status !== 'ci_running') return null;

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
