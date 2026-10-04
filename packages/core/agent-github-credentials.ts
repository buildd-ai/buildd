/**
 * Which GitHub credentials an agent on a self-hosted runner works with.
 *
 * Invariant once enforced: an agent acts on GitHub with a short-lived GitHub
 * App installation token scoped to its task's linked repository, minted by
 * the server (POST /api/runner/agent-github-token) from the workspace's
 * github_repos link — never the runner operator's own token or host
 * credentials. A workspace without the GitHub App opts out explicitly
 * (`gitConfig.agentGitHubCredentials: 'runner'`) and keeps the runner's.
 *
 * Rolled out in stages by the server env var AGENT_GITHUB_TOKEN_ROLLOUT:
 *   off      (default) claims are unchanged; every agent inherits as before
 *   linked   scoped for workspaces with a linked GitHub App repo, else unchanged
 *   enforce  scoped for every workspace that has not opted out
 * Only a runner that declares AGENT_GITHUB_TOKEN_RUNNER_FEATURE is ever told
 * to scope: an older build would ignore the marker anyway. Rollout steps:
 * docs/runner-github-credentials.md.
 */

/** The claim-request `runnerFeatures` entry of a runner that applies `githubCredentials`. */
export const AGENT_GITHUB_TOKEN_RUNNER_FEATURE = 'scoped_github_token' as const;

/** Server env var holding the rollout stage. */
export const AGENT_GITHUB_TOKEN_ROLLOUT_ENV = 'AGENT_GITHUB_TOKEN_ROLLOUT' as const;

export type AgentGitHubRollout = 'off' | 'linked' | 'enforce';

/**
 * `scoped`: the runner strips inherited GitHub credentials and gives the agent
 * only the task-scoped token. `runner`: the workspace opted out; the agent
 * keeps the runner's own credentials, as before.
 */
export type AgentGitHubCredentialMode = 'scoped' | 'runner';

/** Value of `gitConfig.agentGitHubCredentials` that opts a workspace out. */
export const AGENT_GITHUB_CREDENTIALS_OPT_OUT = 'runner' as const;

export function parseAgentGitHubRollout(raw: string | undefined | null): AgentGitHubRollout {
  const v = (raw ?? '').trim().toLowerCase();
  return v === 'linked' || v === 'enforce' ? v : 'off';
}

export function runnerSupportsScopedGitHubToken(runnerFeatures: unknown): boolean {
  return Array.isArray(runnerFeatures) && runnerFeatures.includes(AGENT_GITHUB_TOKEN_RUNNER_FEATURE);
}

/**
 * The mode to put on a host claim, or undefined to leave the claim exactly as
 * it was before this existed (the runner then inherits, as it always has).
 */
export function resolveAgentGitHubCredentialMode(opts: {
  rollout: AgentGitHubRollout;
  runnerSupports: boolean;
  workspaceOptOut: boolean;
  hasLinkedRepo: boolean;
}): AgentGitHubCredentialMode | undefined {
  if (!opts.runnerSupports || opts.rollout === 'off') return undefined;
  if (opts.workspaceOptOut) return 'runner';
  if (opts.rollout === 'linked' && !opts.hasLinkedRepo) return undefined;
  return 'scoped';
}
