/**
 * What a claim-loop deferral reason means to a person, as the end of a
 * sentence ("queued: <phrase>"). Spec f7f67f1a R-33: a waiting task or check
 * names the claim gate's real hold; "waiting for a runner" is only the answer
 * when nothing here applies.
 *
 * Null for reasons with no plain reading: the caller then says only that the
 * work is queued, never guesses a cause.
 */
const PHRASES: Readonly<Record<string, string>> = {
  budget_paused: 'runners paused new work until the model budget resets',
  provider_unavailable: 'no model provider is available to start it',
  mission_budget: "the mission's budget is spent",
  mission_concurrent: 'the mission is already running as many tasks as it allows',
  mission_paced: "the mission's pacing spaces out starts",
  workspace_cap: 'every agent slot in the workspace is in use',
  account_cap: 'every agent slot is in use',
  oauth_parallelism: 'the subscription is at its session limit',
  path_overlap: 'another open PR touches the same files',
  runner_capability: 'no online runner can run it',
  routing_paused: 'routing is paused',
};

export function claimHoldPhrase(reason: string | null | undefined): string | null {
  return reason ? PHRASES[reason] ?? null : null;
}
