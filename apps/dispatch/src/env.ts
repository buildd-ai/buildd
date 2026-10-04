import type { DispatchConfigEnv } from './config';
import type { ScopeQueue } from './scope-queue';

/**
 * Worker bindings, vars and secrets. See README.md.
 * Secrets: PUBLISH_SECRET, CALLBACK_SECRET (key rings). Vars: BUILDD_SERVER
 * (no default), DRY_RUN_TYPES.
 */
export interface Env extends DispatchConfigEnv {
  SCOPE_QUEUE: DurableObjectNamespace<ScopeQueue>;
}
