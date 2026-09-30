import type { EgressEnv } from './outbound';
import type { OtelEgressEnv } from './otel';
import type { WorkerAgent } from './worker-agent';

/**
 * Worker bindings, vars and secrets. See README.md for which is which.
 * Secrets: DISPATCH_TOKEN, BUILDD_API_KEY, AI_GATEWAY_TOKEN or MODEL_PROXY_KEY,
 * OTEL_EXPORTER_OTLP_AUTH_HEADER / OTEL_EXPORTER_OTLP_AUTH_VALUE, and (local only)
 * ANTHROPIC_DIRECT_API_KEY. Everything else is a plain var. The egress settings
 * are in EgressEnv (outbound.ts), the telemetry ones in OtelEgressEnv (otel.ts).
 */
export interface Env extends EgressEnv, OtelEgressEnv {
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
  /** Mirrors `containers[].instance_type` in wrangler.jsonc, for the run report (not readable at runtime otherwise). */
  CONTAINER_INSTANCE_TYPE?: string;
  /** Local smoke only: `1` makes the egress handler echo instead of forwarding. */
  EGRESS_DEBUG_ECHO?: string;
  /**
   * `1` turns on warm repos (Phase 2): the container restores and refreshes a
   * per-workspace snapshot through the egress handler. Default off. Needs
   * the SNAPSHOTS binding too (lifecycle.ts warmReposEnabled).
   */
  WARM_REPOS?: string;
  /** R2 bucket for snapshots (wrangler.jsonc `r2_buckets`). Only the Worker writes it. */
  SNAPSHOTS?: R2Bucket;
}
