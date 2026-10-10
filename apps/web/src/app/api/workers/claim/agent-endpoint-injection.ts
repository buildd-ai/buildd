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
import {
  AGENT_ENDPOINT_HEADERS_RUNNER_FEATURE, AGENT_ENDPOINT_RUNNER_FEATURE, resolveAgentModelRoute, routeNeedsHeaders,
  type AgentModelDecision,
} from '@buildd/core/agent-endpoint';

/** True when the claim request declares AGENT_ENDPOINT_RUNNER_FEATURE. */
export function runnerSupportsAgentEndpoint(runnerFeatures: unknown): boolean {
  return Array.isArray(runnerFeatures) && runnerFeatures.includes(AGENT_ENDPOINT_RUNNER_FEATURE);
}

/** True when the claim request declares AGENT_ENDPOINT_HEADERS_RUNNER_FEATURE (it applies `modelEndpoint.headers`). */
export function runnerSupportsEndpointHeaders(runnerFeatures: unknown): boolean {
  return Array.isArray(runnerFeatures) && runnerFeatures.includes(AGENT_ENDPOINT_HEADERS_RUNNER_FEATURE);
}

type ClaimedTask = { id: string; workspaceId: string };

export interface AgentEndpointDeps {
  resolve: (opts: { teamId: string; workspaceId: string; accountId: string; backend: 'claude' | 'codex' }) => Promise<AgentModelDecision | null>;
}

export async function attachAgentEndpoints(
  claimedWorkers: ClaimTasksResponse['workers'],
  claimedTasks: readonly ClaimedTask[],
  accountId: string,
  opts: { llmProviderOverride: boolean; codexBaseUrlOverride?: boolean; runnerSupportsEndpoint: boolean; runnerSupportsHeaders?: boolean },
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
      if (!isCodexTask && routeNeedsHeaders(decision.endpoint) && !opts.runnerSupportsHeaders) {
        // The gateway would refuse every call without its header. This runner
        // gets the claim an endpoint-unaware runner gets: its own credentials.
        console.log(`[claim] agent endpoint (${decision.endpoint.kind}) not used for worker ${cw.id}: it needs request headers this runner does not apply`);
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
        ...(e.upstream ? { upstream: e.upstream } : {}),
        // Claude only: Codex runs never get a route that needs headers (no openAiBaseUrl).
        ...(!isCodexTask && e.headers ? { headers: e.headers } : {}),
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

/**
 * Cloud claim: the container never gets `modelEndpoint` (the dispatcher's egress
 * applies it), so Claude Code there thinks it talks to Anthropic and keeps
 * ToolSearch on. For a Claude task whose winning endpoint does not pass
 * `tool_reference` through, mark the worker `toolSearchDisabled` so the runner
 * sets ENABLE_TOOL_SEARCH=false. Same `resolveAgentModelRoute` result as the
 * host path, per run; a marker only, no credential. Lookup failures write nothing.
 */
export async function attachCloudToolSearchHint(
  claimedWorkers: ClaimTasksResponse['workers'],
  claimedTasks: readonly ClaimedTask[],
  accountId: string,
  deps: AgentEndpointDeps = { resolve: resolveAgentModelRoute },
): Promise<void> {
  if (claimedWorkers.length === 0 || !process.env.ENCRYPTION_KEY) return;
  for (const cw of claimedWorkers) {
    const task = (claimedTasks.find(t => t.id === cw.taskId) ?? cw.task) as any;
    if (!task || task.backend === 'codex') continue;
    const teamId = task.workspace?.teamId as string | undefined;
    const workspaceId = task.workspaceId as string | undefined;
    if (!teamId || !workspaceId) continue;
    try {
      const decision = await deps.resolve({ teamId, workspaceId, accountId, backend: 'claude' });
      if (decision?.winner === 'endpoint' && !decision.endpoint.toolSearch) {
        (cw as typeof cw & { toolSearchDisabled?: boolean }).toolSearchDisabled = true;
      }
    } catch (err) {
      console.warn(`[claim] cloud tool-search lookup failed for worker ${cw.id}:`, err);
    }
  }
}
