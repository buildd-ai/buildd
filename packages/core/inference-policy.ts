/**
 * Which actions a team lets buildd spend inference money on.
 *
 * Storing an inference key and *using* it are two decisions, not one. An
 * inference call is faster than dispatching an agent run and costs metered
 * dollars; an agent run is slower and spends a subscription seat the team is
 * already paying for. Which trade is right is a per-team, per-action judgment: an
 * enterprise may happily pay for every judgment to come back in seconds, while a
 * solo operator on a subscription wants the agent path for everything except the
 * few actions that genuinely cannot be done by an agent.
 *
 * So the key answers "can we?" and this policy answers "should we, for this?".
 *
 * ## Default is off, deliberately
 *
 * An absent or empty allowlist means **no capability uses inference** — every
 * action takes its agent path. Two reasons:
 *
 * 1. Pasting a credential should never silently start spending on call sites the
 *    operator has not seen. Spend is opt-in per action.
 * 2. It is exactly today's behaviour. No team's costs change when this ships,
 *    which is the same "existing teams are unaffected" property that
 *    `teams.enabledBackends` gets from its NULL-means-all default. The value
 *    differs because the behaviour being preserved differs.
 *
 * ## Layered above resolution, like the backend mask
 *
 * This is a mask, not another default in the resolution chain. Turning a
 * capability off does not clear the key, edit the tier registry, or touch any
 * per-workspace setting — the call site takes its fallback and re-enabling
 * restores the previous behaviour with no stored state to undo.
 */

/** Every inference call site in the platform, named. */
export type InferenceCapability =
  | 'criteria_grading'
  | 'visual_qa'
  | 'task_classification'
  | 'mission_summary';

export interface CapabilityDescriptor {
  id: InferenceCapability;
  label: string;
  /** What the capability does, in operator language. */
  description: string;
  /**
   * What happens when this capability may NOT use inference.
   *
   * `agent` — a dispatched agent run produces the same answer, slower and on the
   * subscription seat. Turning inference off here is a cost/latency trade.
   *
   * `none` — there is no other way to get this answer. Turning inference off here
   * turns the feature off. These are the load-bearing toggles and the UI must say
   * so rather than presenting them as equivalent switches.
   */
  fallback: 'agent' | 'none';
  /** Rough per-call cost, for the settings UI. */
  costHint: string;
}

export const INFERENCE_CAPABILITIES: Record<InferenceCapability, CapabilityDescriptor> = {
  criteria_grading: {
    id: 'criteria_grading',
    label: 'Goal criteria grading',
    description:
      'Grade a mission\'s prose (description) goal criteria against task summaries and artifacts.',
    fallback: 'agent',
    costHint: '~$0.001 per mission verification',
  },
  visual_qa: {
    id: 'visual_qa',
    label: 'Visual QA judgment',
    description:
      'Judge release-PR screenshots against their spec claims. Multimodal — an agent run cannot see the screenshot.',
    fallback: 'none',
    costHint: '~$0.01 per page judged',
  },
  task_classification: {
    id: 'task_classification',
    label: 'Task classification',
    description:
      'Tag a task with kind and complexity when it is created outside a mission.',
    fallback: 'none',
    costHint: '~$0.001 per task',
  },
  mission_summary: {
    id: 'mission_summary',
    label: 'Mission summaries',
    description:
      'Answer questions about a mission and compress long note threads on request.',
    fallback: 'none',
    costHint: '~$0.005 per request',
  },
};

export const ALL_INFERENCE_CAPABILITIES = Object.keys(INFERENCE_CAPABILITIES) as InferenceCapability[];

/** True when `value` names a capability this build knows about. */
export function isInferenceCapability(value: unknown): value is InferenceCapability {
  return typeof value === 'string' && value in INFERENCE_CAPABILITIES;
}

/**
 * May this capability spend an inference call for this team?
 *
 * `enabled` is `teams.enabledInferenceCapabilities`: null/empty means none.
 * Unknown names in the stored array are ignored rather than trusted — a row
 * written by a newer deploy must not enable spend on a capability this build does
 * not have.
 */
export function isInferenceEnabled(
  capability: InferenceCapability,
  enabled: readonly string[] | null | undefined,
): boolean {
  if (!enabled || enabled.length === 0) return false;
  return enabled.includes(capability);
}

/**
 * Normalize an operator-supplied allowlist: drop unknowns, dedupe, keep a stable
 * order. Returns null for "nothing enabled" so the column stays NULL rather than
 * accumulating empty arrays that mean the same thing.
 */
export function normalizeInferenceCapabilities(input: unknown): InferenceCapability[] | null {
  if (!Array.isArray(input)) return null;
  const kept = ALL_INFERENCE_CAPABILITIES.filter(c => input.includes(c));
  return kept.length > 0 ? kept : null;
}

/**
 * Capabilities that stop working entirely if inference is disabled for them.
 * The settings UI uses this to warn instead of implying a graceful fallback.
 */
export function capabilitiesWithoutFallback(): InferenceCapability[] {
  return ALL_INFERENCE_CAPABILITIES.filter(c => INFERENCE_CAPABILITIES[c].fallback === 'none');
}
