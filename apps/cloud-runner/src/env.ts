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
   * (which holds a per-task token but never this).
   */
  DISPATCH_TOKEN?: string;
  /**
   * Runner API key (ideally scoped to one workspace). Never handed to the
   * container: it mints the per-task token the container gets instead.
   */
  BUILDD_API_KEY?: string;
  /** buildd base URL. Required: the runner would otherwise default to production. */
  BUILDD_SERVER?: string;
  /** Model passed to the container's runner. With a proxy, a model name or alias the proxy serves. */
  MODEL?: string;
  PUSHER_KEY?: string;
  PUSHER_CLUSTER?: string;
  BUILDD_ONCE_MAX_WAIT_MS?: string;
  /**
   * The fleet group this deployment's runs report (lifecycle.ts
   * RUNNER_GROUP_CONTAINER_ENV). Set in wrangler.jsonc to the Worker name.
   */
  RUNNER_GROUP?: string;
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
  /**
   * Largest warm snapshot part (bundle or cache tarball) in bytes; default
   * 1 GiB (lifecycle.ts warmMaxBundleBytes). Passed to the container, which
   * skips the upload past it, and enforced by the snapshot route.
   */
  WARM_MAX_BUNDLE_BYTES?: string;
  /** `1` enables the debug POST /tasks/:id/kill (http.ts). Off by default; recovery testing only. */
  ALLOW_DEBUG_KILL?: string;
  /**
   * `1` turns on resumable runs (Phase 2): a worker waiting for input is
   * parked (container released) and a `task.resume` dispatch continues it.
   * Default off. Needs the SNAPSHOTS binding too (resumableRunsEnabled).
   */
  RESUMABLE_RUNS?: string;
  /** R2 bucket for snapshots (wrangler.jsonc `r2_buckets`). Only the Worker writes it. */
  SNAPSHOTS?: R2Bucket;
}
