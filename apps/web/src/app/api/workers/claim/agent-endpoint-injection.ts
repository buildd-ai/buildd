/**
 * The team's agent model endpoint on a host claim
 * (docs/design/agent-model-endpoint.md §2).
 *
 * One ranking across `agent_endpoint`, `anthropic_api_key`, `oauth_token` and
 * `claude_credential` (resolveAgentModelRoute in @buildd/core/agent-endpoint):
 * the most specific scope wins, a tie goes to the endpoint. When the endpoint
 * wins, this attaches `modelEndpoint` and returns the worker id, and the
 * credential attach steps in ./credential-injection then deliver no Anthropic
 * credential (serverApiKey / serverOauthToken / claudeAccessToken /
 * pendingCredentialRefreshes) for that worker. Only the winner is attached.
 *
 * Never called for a cloud claim (the route skips it; `modelEndpoint` is in
 * CLAIM_CREDENTIAL_FIELDS as the backstop). Codex tasks are skipped, like the
 * Anthropic injection. A runner that reported `llmProviderOverride` gets a
 * non-secret `modelEndpointIgnored` marker instead of the key: its per-machine
 * provider wins (§2.1), so the key would only be exposure.
 *
 * No endpoint row ⇒ no field written and nothing withheld: the claim is
 * exactly what it was before endpoints existed (§7). The same holds for a
 * runner that does not declare AGENT_ENDPOINT_RUNNER_FEATURE: it would not
 * apply `modelEndpoint`, so it must keep the credentials the endpoint replaces.
 */
import type { ClaimModelEndpoint, ClaimTasksResponse } from '@buildd/shared';
import { AGENT_ENDPOINT_RUNNER_FEATURE, resolveAgentModelRoute, type AgentModelDecision } from '@buildd/core/agent-endpoint';

/** True when the claim request declares AGENT_ENDPOINT_RUNNER_FEATURE. */
export function runnerSupportsAgentEndpoint(runnerFeatures: unknown): boolean {
  return Array.isArray(runnerFeatures) && runnerFeatures.includes(AGENT_ENDPOINT_RUNNER_FEATURE);
}

type ClaimedTask = { id: string; workspaceId: string };

export interface AgentEndpointDeps {
  resolve: (opts: { teamId: string; workspaceId: string; accountId: string }) => Promise<AgentModelDecision | null>;
}

export async function attachAgentEndpoints(
  claimedWorkers: ClaimTasksResponse['workers'],
  claimedTasks: readonly ClaimedTask[],
  accountId: string,
  opts: { llmProviderOverride: boolean; runnerSupportsEndpoint: boolean },
  deps: AgentEndpointDeps = { resolve: resolveAgentModelRoute },
): Promise<Set<string>> {
  const won = new Set<string>();
  if (!opts.runnerSupportsEndpoint) return won;
  if (claimedWorkers.length === 0 || !process.env.ENCRYPTION_KEY) return won;
  for (const cw of claimedWorkers) {
    const task = (claimedTasks.find(t => t.id === cw.taskId) ?? cw.task) as any;
    if (!task || task.backend === 'codex') continue;
    const teamId = task.workspace?.teamId as string | undefined;
    const workspaceId = task.workspaceId as string | undefined;
    if (!teamId || !workspaceId) continue;
    try {
      const decision = await deps.resolve({ teamId, workspaceId, accountId });
      if (!decision) continue;
      if (decision.winner !== 'endpoint') {
        console.log(`[claim] agent endpoint not used for worker ${cw.id}: a ${decision.beatenBy}-scoped Anthropic credential is more specific`);
        continue;
      }
      won.add(cw.id);
      const w = cw as typeof cw & { modelEndpoint?: ClaimModelEndpoint; modelEndpointIgnored?: boolean };
      if (opts.llmProviderOverride) {
        w.modelEndpointIgnored = true;
        continue;
      }
      const e = decision.endpoint;
      w.modelEndpoint = { kind: e.kind, baseUrl: e.baseUrl, authToken: e.apiKey, authHeader: e.authHeader, models: e.models };
      console.log(`[claim] attached ${e.scope} agent model endpoint (${e.kind}) for worker ${cw.id}`);
    } catch (err) {
      // Non-fatal, like every credential block: the claim still succeeds.
      console.warn(`[claim] agent endpoint lookup failed for worker ${cw.id}:`, err);
    }
  }
  return won;
}
