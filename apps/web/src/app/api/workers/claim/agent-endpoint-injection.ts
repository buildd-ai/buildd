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
 * CLAIM_CREDENTIAL_FIELDS as the backstop). A Codex task ranks the endpoint
 * against the Codex-side credentials instead of the Anthropic ones
 * (`resolveAgentModelRoute`'s `backend: 'codex'`) — when it wins, the Codex
 * credential attach step (`attachCodexCredentials`) must skip that worker the
 * same way the Anthropic one does, via the same `won` set. A runner that
 * reported `llmProviderOverride` gets a non-secret `modelEndpointIgnored`
 * marker instead of the key: its per-machine provider wins (§2.1), so the key
 * would only be exposure.
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
  resolve: (opts: { teamId: string; workspaceId: string; accountId: string; backend: 'claude' | 'codex' }) => Promise<AgentModelDecision | null>;
}

export async function attachAgentEndpoints(
  claimedWorkers: ClaimTasksResponse['workers'],
  claimedTasks: readonly ClaimedTask[],
  accountId: string,
  opts: { llmProviderOverride: boolean; codexBaseUrlOverride?: boolean; runnerSupportsEndpoint: boolean },
  deps: AgentEndpointDeps = { resolve: resolveAgentModelRoute },
): Promise<Set<string>> {
  const won = new Set<string>();
  if (!opts.runnerSupportsEndpoint) return won;
  if (claimedWorkers.length === 0 || !process.env.ENCRYPTION_KEY) return won;
  for (const cw of claimedWorkers) {
    const task = (claimedTasks.find(t => t.id === cw.taskId) ?? cw.task) as any;
    if (!task) continue;
    const isCodexTask = task.backend === 'codex';
    const teamId = task.workspace?.teamId as string | undefined;
    const workspaceId = task.workspaceId as string | undefined;
    if (!teamId || !workspaceId) continue;
    try {
      const decision = await deps.resolve({ teamId, workspaceId, accountId, backend: isCodexTask ? 'codex' : 'claude' });
      if (!decision) continue;
      if (decision.winner !== 'endpoint') {
        console.log(`[claim] agent endpoint not used for worker ${cw.id}: a ${decision.beatenBy}-scoped credential is more specific`);
        continue;
      }
      won.add(cw.id);
      const w = cw as typeof cw & { modelEndpoint?: ClaimModelEndpoint; modelEndpointIgnored?: boolean };
      const overridden = isCodexTask ? !!opts.codexBaseUrlOverride : opts.llmProviderOverride;
      if (overridden) {
        w.modelEndpointIgnored = true;
        continue;
      }
      const e = decision.endpoint;
      if (isCodexTask && !e.openAiBaseUrl) {
        // The endpoint has no OpenAI-compatible route (anthropic-compatible
        // kind). Attach it anyway so the runner can fail the task with a
        // clear message (agent-model-env.ts) instead of silently falling
        // back to whatever local Codex auth exists — the team's endpoint IS
        // the configured route here, it just can't speak Codex's wire format.
        w.modelEndpoint = { kind: e.kind, baseUrl: e.baseUrl, authToken: e.apiKey, authHeader: e.authHeader, models: e.models };
        console.log(`[claim] attached ${e.scope} agent model endpoint (${e.kind}) for Codex worker ${cw.id} — no OpenAI-compatible route, runner will fail it clearly`);
        continue;
      }
      w.modelEndpoint = {
        kind: e.kind, baseUrl: e.baseUrl, authToken: e.apiKey, authHeader: e.authHeader, models: e.models,
        ...(e.openAiBaseUrl ? { openAiBaseUrl: e.openAiBaseUrl } : {}),
        // The winning row's own capability, so a workspace row and the team
        // row can differ. Meaningless to Codex, so not sent for it.
        ...(!isCodexTask && e.toolSearch ? { toolSearch: true } : {}),
      };
      console.log(`[claim] attached ${e.scope} agent model endpoint (${e.kind}) for worker ${cw.id}${isCodexTask ? '' : ` tool_search=${e.toolSearch ? 'on' : 'off'}`}`);
    } catch (err) {
      // Non-fatal, like every credential block: the claim still succeeds.
      console.warn(`[claim] agent endpoint lookup failed for worker ${cw.id}:`, err);
    }
  }
  return won;
}
