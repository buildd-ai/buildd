/**
 * The subscription-wall fallback's model credential on a host claim
 * (provider-failover spec, "Subscription wall fallback").
 *
 * Runs after every other model-credential attach step, and decides last:
 *
 * - A Claude run the claim let through on the team's fallback (its login is
 *   walled, `plans` has its task) gets the fallback credential as its only
 *   model credential: the team's Anthropic key as `serverApiKey`, or an
 *   endpoint route (OpenRouter, LiteLLM, the agent endpoint) as
 *   `modelEndpoint`. Whatever an earlier step attached is replaced.
 * - Every other Claude run of a subscription runner loses the credential the
 *   team reserved for walls (`heldByTeam`, `heldForWall`), so it spends its
 *   own login first. `resolveClaudeModelRoute` reads the same hold, so the
 *   route the claim decided and the credential the run gets agree.
 *
 * `skip` holds workers whose model credential is someone else's decision (a
 * person's own key, a Coding policy pinned to the machine login): untouched.
 * Codex runs are untouched: the fallback is a Claude-login fallback.
 * Never called for a cloud claim (no credential is in one).
 */
import type { ClaimModelEndpoint, ClaimTasksResponse } from '@buildd/shared';
import { routeNeedsHeaders } from '@buildd/core/agent-endpoint';
import type { WallFallbackRecord } from '@buildd/core/wall-fallback';
import type { WallFallbackCredential } from '@/lib/subscription-fallback';

export interface WallFallbackPlan {
  credential: WallFallbackCredential;
  record: WallFallbackRecord;
}

type Worker = ClaimTasksResponse['workers'][number] & {
  serverApiKey?: string;
  modelEndpoint?: ClaimModelEndpoint;
  modelEndpointIgnored?: boolean;
};

/** Returns the workers a fallback credential was delivered to, with what served them. */
export function applyWallFallbackCredentials(
  claimedWorkers: ClaimTasksResponse['workers'],
  opts: {
    /** By task id: the walled runs the claim let through on the fallback. */
    plans: ReadonlyMap<string, WallFallbackPlan>;
    /** By team id: the credential reserved for walls, for a subscription runner. */
    heldByTeam: ReadonlyMap<string, 'anthropic_api_key' | 'agent_endpoint' | null>;
    skip: ReadonlySet<string>;
    runnerSupportsEndpoint: boolean;
    runnerSupportsHeaders: boolean;
  },
): Map<string, WallFallbackPlan> {
  const applied = new Map<string, WallFallbackPlan>();
  for (const raw of claimedWorkers) {
    const w = raw as Worker;
    const task = w.task as any;
    if (!task || task.backend === 'codex' || opts.skip.has(w.id)) continue;
    const plan = opts.plans.get(w.taskId);
    if (plan) {
      const c = plan.credential;
      if (c.apiKey) {
        delete w.modelEndpoint;
        delete w.modelEndpointIgnored;
        w.serverApiKey = c.apiKey;
        applied.set(w.id, plan);
        continue;
      }
      const e = c.endpoint;
      if (e && opts.runnerSupportsEndpoint && (!routeNeedsHeaders(e) || opts.runnerSupportsHeaders)) {
        delete w.serverApiKey;
        delete w.modelEndpointIgnored;
        w.modelEndpoint = {
          kind: e.kind, baseUrl: e.baseUrl, authToken: e.apiKey, authHeader: e.authHeader, models: e.models,
          ...(e.openAiBaseUrl ? { openAiBaseUrl: e.openAiBaseUrl } : {}),
          ...(e.upstream ? { upstream: e.upstream } : {}),
          ...(e.headers ? { headers: e.headers } : {}),
          ...(e.toolSearch ? { toolSearch: true } : {}),
        };
        applied.set(w.id, plan);
        continue;
      }
      console.log(`[claim] wall fallback (${c.served}) not delivered to worker ${w.id}: this runner cannot apply it`);
    }
    const held = opts.heldByTeam.get(task.workspace?.teamId as string) ?? null;
    if (held === 'anthropic_api_key' && w.serverApiKey) {
      delete w.serverApiKey;
    } else if (held === 'agent_endpoint' && (w.modelEndpoint || w.modelEndpointIgnored)) {
      delete w.modelEndpoint;
      delete w.modelEndpointIgnored;
    }
  }
  return applied;
}
