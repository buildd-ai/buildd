import type { WorkerAgent } from './worker-agent';

/**
 * Worker bindings, vars and secrets. See README.md for which is which.
 * Secrets: DISPATCH_TOKEN, BUILDD_API_KEY. Everything else is a plain var.
 */
export interface Env {
  WorkerAgent: DurableObjectNamespace<WorkerAgent>;
  /** Must equal the workspace's webhookConfig.token. */
  DISPATCH_TOKEN?: string;
  /** Runner API key handed to the container (ideally scoped to one workspace). */
  BUILDD_API_KEY?: string;
  /** buildd base URL. Required: the runner would otherwise default to production. */
  BUILDD_SERVER?: string;
  ANTHROPIC_BASE_URL?: string;
  MODEL?: string;
  PUSHER_KEY?: string;
  PUSHER_CLUSTER?: string;
  BUILDD_ONCE_MAX_WAIT_MS?: string;
  /** Local testing only (scripts/local-e2e.sh); refused unless BUILDD_SERVER is local. */
  DEV_ANTHROPIC_API_KEY?: string;
  CONTAINER_INACTIVITY_TIMEOUT_MS?: string;
  CONTAINER_START_TIMEOUT_MS?: string;
}
