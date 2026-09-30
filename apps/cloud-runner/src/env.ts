import type { EgressEnv } from './outbound';
import type { WorkerAgent } from './worker-agent';

/**
 * Worker bindings, vars and secrets. See README.md for which is which.
 * Secrets: DISPATCH_TOKEN, BUILDD_API_KEY, AI_GATEWAY_TOKEN or MODEL_PROXY_KEY,
 * and (local only) ANTHROPIC_DIRECT_API_KEY. Everything else is a plain var. The egress
 * settings are in EgressEnv (outbound.ts).
 */
export interface Env extends EgressEnv {
  WorkerAgent: DurableObjectNamespace<WorkerAgent>;
  /**
   * Must equal the workspace's webhookConfig.token. Also proves to buildd
   * that a GitHub token request comes from the dispatcher, not the container
   * (which holds BUILDD_API_KEY but never this).
   */
  DISPATCH_TOKEN?: string;
  /** Runner API key handed to the container (ideally scoped to one workspace). */
  BUILDD_API_KEY?: string;
  /** buildd base URL. Required: the runner would otherwise default to production. */
  BUILDD_SERVER?: string;
  /** Model passed to the container's runner. With a proxy, a model name or alias the proxy serves. */
  MODEL?: string;
  PUSHER_KEY?: string;
  PUSHER_CLUSTER?: string;
  BUILDD_ONCE_MAX_WAIT_MS?: string;
  CONTAINER_INACTIVITY_TIMEOUT_MS?: string;
  CONTAINER_START_TIMEOUT_MS?: string;
  /** Local smoke only: `1` makes the egress handler echo instead of forwarding. */
  EGRESS_DEBUG_ECHO?: string;
}
