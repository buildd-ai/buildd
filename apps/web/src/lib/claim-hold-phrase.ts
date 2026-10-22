/**
 * What a claim-loop deferral reason means to a person, as the end of a
 * sentence ("queued: <phrase>"). Spec 8e137fdb I-4: a waiting task or check
 * names the claim gate's real hold. Keyed by the claim route's own deferral
 * counters, so a new gate reason does not compile until it has words here
 * (AC-10; `claim-hold-phrase.test.ts` checks the same at runtime).
 *
 * `claimHoldPhrase` is null for a reason it does not know: the caller then
 * says the work is waiting, never guesses a cause (AC-9).
 */
import type { ClaimDiagnostics } from '@buildd/shared';

export type ClaimHoldReason = keyof Required<NonNullable<ClaimDiagnostics['deferrals']>>;

export const CLAIM_HOLD_PHRASES: Readonly<Record<ClaimHoldReason, string>> = {
  connector_mismatch: 'a connector its role needs is not available here',
  subject_dead: 'the PR it works on was closed',
  path_overlap: 'another open PR touches the same files',
  advisory_manifest: 'another task with no declared files is running in the mission',
  soft_overlap: 'it waits for a task working on the same files',
  mission_budget: "the mission's budget is spent",
  mission_concurrent: 'the mission is already running as many tasks as it allows',
  mission_paced: "the mission's pacing spaces out starts",
  workspace_cap: 'every agent slot in the workspace is in use',
  provider_unavailable: 'no model provider is available to start it',
  budget_paused: 'runners paused new work until the model budget resets',
  routing_paused: 'routing is paused',
  duplicate_worker: 'an agent is already working on it',
  sibling_retry_open: 'a retry of the same work is already open',
  awaiting_owner_answer: 'a person has to answer the question it stopped on',
  fix_not_needed: 'the fix it was filed for is no longer needed',
  kernel_unavailable: 'the workflow control plane did not answer in time',
  kernel_refused: 'the workflow control plane refused to check its fix',
  runner_capability: 'no online runner has what it needs',
  codex_single_flight: 'Codex runs one task at a time and is busy',
  oauth_parallelism: 'the subscription is at its session limit',
  role_env_unsatisfied: 'its role needs settings the runner does not have',
  delegation_unmet: 'it needs access to another workspace that nobody has granted yet',
  ordered_behind: 'it waits for earlier work in the queue',
  managed_concurrency: 'the managed runners are all busy',
  managed_runner_hours: 'the managed runner hours are used up',
  hosted_runner_hours: "the team's hosted runner hours are used up",
  no_personal_credential: 'it needs your own model key, which is not set',
  provider_not_allowed: "the team's model policy does not allow its provider",
  tier_policy: "the team's model policy does not allow its tier",
  isolation_unenforced: 'no online runner can confine it as its isolation policy requires',
};

/** The one cause for a visual audit no online runner can take (spec 8e137fdb I-4, I-5). */
export const BROWSER_RUNNER_MISSING = 'it needs a runner with a browser';

export function claimHoldPhrase(reason: string | null | undefined): string | null {
  return reason && Object.prototype.hasOwnProperty.call(CLAIM_HOLD_PHRASES, reason)
    ? CLAIM_HOLD_PHRASES[reason as ClaimHoldReason]
    : null;
}
