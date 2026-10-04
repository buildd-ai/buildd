/**
 * Tells a host runner which GitHub credentials its agent gets
 * (@buildd/core/agent-github-credentials). Writes only a mode marker, never a
 * token: the runner fetches the task-scoped token itself from
 * POST /api/runner/agent-github-token, so it can refresh it mid-session.
 *
 * Never called for a cloud claim: there the egress handler injects the token
 * and the container gets no GitHub credential at all.
 */
import type { ClaimTasksResponse } from '@buildd/shared';
import {
  AGENT_GITHUB_CREDENTIALS_OPT_OUT,
  resolveAgentGitHubCredentialMode,
  runnerSupportsScopedGitHubToken,
  type AgentGitHubRollout,
} from '@buildd/core/agent-github-credentials';

export function attachGitHubCredentialModes(
  claimedWorkers: ClaimTasksResponse['workers'],
  opts: { rollout: AgentGitHubRollout; runnerFeatures: unknown },
): void {
  const runnerSupports = runnerSupportsScopedGitHubToken(opts.runnerFeatures);
  if (!runnerSupports || opts.rollout === 'off') return;
  for (const cw of claimedWorkers) {
    const ws = (cw.task as any)?.workspace as { githubRepoId?: string | null; gitConfig?: { agentGitHubCredentials?: unknown } | null } | undefined;
    if (!ws) continue;
    const mode = resolveAgentGitHubCredentialMode({
      rollout: opts.rollout,
      runnerSupports,
      workspaceOptOut: ws.gitConfig?.agentGitHubCredentials === AGENT_GITHUB_CREDENTIALS_OPT_OUT,
      hasLinkedRepo: !!ws.githubRepoId,
    });
    if (mode) cw.githubCredentials = { mode };
  }
}
