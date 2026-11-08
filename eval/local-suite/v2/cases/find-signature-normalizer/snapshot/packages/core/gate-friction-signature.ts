/**
 * Composes the friction-dedupe key for a gate refusal.
 *
 * A traced worker failure gets a `frictionSignature` for free from
 * `get_error_traces` / `get_failure_analytics`. A gate refusal never becomes a
 * worker failure — it is a creation-time or completion-time 400 — so it had
 * nothing to hand `create_task`, and eighty friction reports over 23 days
 * proved it: the dedupe predicate in `apps/web/src/app/api/tasks/route.ts`
 * (exact match on `context->>'frictionSignature'`) was always correct, it
 * just never received a key for this class of refusal.
 *
 * Reuses `toFrictionSignature` — the SAME namespace:stem_hash composer worker
 * failures already use — rather than a second hashing scheme, so there is one
 * frictionSignature format in the codebase, not two that could drift. Passing
 * the `gate` namespace (instead of the default `worker-failure`) is what
 * makes a gate refusal's key legible as a gate refusal on sight, e.g. in a
 * task's `context.frictionSignature` or a friction-report title.
 *
 * Both halves fed in here already exist on every `recordGateEvent` call — the
 * gate slug and the caller-facing reason — so this needs no new computation.
 * The reason is normalized with the SAME `normalizeErrorSignature` the ledger
 * normalizes `gate_events.reason` with (see `gate-events.ts`), so two
 * refusals that collapse into one `gate_events` row also collapse into one
 * friction signature.
 */
import { normalizeErrorSignature } from './error-signature';
import { toFrictionSignature } from './failure-friction-signature';

const GATE_FRICTION_NAMESPACE = 'gate';

export function gateFrictionSignature(gate: string, reason: string): string {
  const normalized = normalizeErrorSignature(reason);
  return toFrictionSignature(`${gate}: ${normalized}`, GATE_FRICTION_NAMESPACE);
}
