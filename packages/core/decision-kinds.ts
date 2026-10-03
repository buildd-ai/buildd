/**
 * buildd's decision kinds: the contract a call site targets instead of a model.
 *
 * The kind itself (features, rule, questions, threshold, escalation policy,
 * fallback) is `@builddai/ai-kit/decide`'s `defineDecisionKind`. buildd adds a
 * *binding*: which inference capability gates the spend, whether the kind runs
 * live or shadow once allowed, which richer model (if any) fills the
 * escalation slot, and which models beyond Jev its thresholds were measured on.
 * The cheap model is never named here: it is the team's decision model
 * (`teams.decision_model`, Jev by default), resolved per call by
 * `decision-policy.ts`.
 *
 * A new kind needs its own `InferenceCapability` (`inference-policy.ts`):
 * `opt_in` for new spend, so the team switch and the readout's "disabled"
 * count mean something.
 *
 * Pure: no DB, no env. `defineBuilddDecisionKind` throws at definition time on
 * a malformed kind or binding.
 */

import {
  defineDecisionKind,
  type DecisionKind,
  type DecisionKindConfig,
  type DecisionQuestions,
} from '@builddai/ai-kit/decide';
import { INFERENCE_CAPABILITIES, type InferenceCapability } from './inference-policy';
import { isJevModel, normalizeDecisionModel, type DecisionModelConfig } from './decision-model';
import type { DecisionReadoutAdapter } from './decision-readout';

export type {
  DecisionAttempt,
  DecisionAttemptRole,
  DecisionConstraints,
  DecisionFailure,
  DecisionFailureKind,
  DecisionFallbackCause,
  DecisionRequest,
  DecisionResponse,
  DecisionRolloutMode,
  DecisionSource,
  DecisionSubjectRef,
  DecisionVerdict,
  ModelVerdict,
} from '@builddai/ai-kit/decide';

export interface BuilddDecisionKindBinding {
  /** The inference-policy capability checked before any spend. */
  capability: InferenceCapability;
  /** Once the capability allows the call. `live` applies; `shadow` asks, records and runs the fallback. */
  mode: 'live' | 'shadow';
  /** The richer model for the escalation slot; same shape as `teams.decision_model`. Absent: no slot. */
  escalation?: DecisionModelConfig | null;
  /** Models beyond Jev this kind's thresholds were measured on. A pick from any other is recorded, never applied. */
  measuredModels?: readonly string[];
  /**
   * A model asked after the decision is made, out of band, to measure it
   * against the applied answer (`decision-policy.ts`). Never applied.
   * `fraction` is the share of subjects asked (default 1), drawn per subject
   * through `experiment-randomizer.ts`.
   */
  challenger?: (DecisionModelConfig & { fraction?: number }) | null;
  /** How the shared readout counts and scores this kind. The only kind-specific readout logic. */
  readout?: DecisionReadoutAdapter;
}

export interface BuilddDecisionKind<K extends string, F, D extends string, Q extends DecisionQuestions>
  extends DecisionKind<K, F, D, Q> {
  readonly binding: Readonly<BuilddDecisionKindBinding>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyBuilddDecisionKind = BuilddDecisionKind<string, any, string, any>;

const registry = new Map<string, AnyBuilddDecisionKind>();

/**
 * Define a buildd decision kind and register it. Ids are `buildd.<name>`.
 * Redefining an id replaces it (module reloads), it does not throw.
 */
export function defineBuilddDecisionKind<const K extends string, F, const D extends string, const Q extends DecisionQuestions>(
  config: DecisionKindConfig<K, F, D, Q>,
  binding: BuilddDecisionKindBinding,
): BuilddDecisionKind<K, F, D, Q> {
  if (!config.kind.startsWith('buildd.')) throw new Error(`decision kind '${config.kind}' must be namespaced 'buildd.<name>'`);
  if (!(binding.capability in INFERENCE_CAPABILITIES)) {
    throw new Error(`decision kind '${config.kind}': unknown capability '${String(binding.capability)}'`);
  }
  if (binding.mode !== 'live' && binding.mode !== 'shadow') {
    throw new Error(`decision kind '${config.kind}': mode must be 'live' or 'shadow'`);
  }
  if (binding.escalation) {
    const checked = normalizeDecisionModel(binding.escalation);
    if (!checked.ok) throw new Error(`decision kind '${config.kind}': escalation ${checked.error}`);
  }
  if (binding.challenger) {
    const { fraction, ...model } = binding.challenger;
    const checked = normalizeDecisionModel(model);
    if (!checked.ok) throw new Error(`decision kind '${config.kind}': challenger ${checked.error}`);
    if (fraction !== undefined && !(typeof fraction === 'number' && fraction >= 0 && fraction <= 1)) {
      throw new Error(`decision kind '${config.kind}': challenger fraction must be in [0, 1]`);
    }
  }
  // Only the config's own fields: a spread of an already-defined kind carries
  // its derived fingerprints, which `defineDecisionKind` recomputes.
  const kind = defineDecisionKind(config);
  const out = Object.freeze({
    ...kind,
    binding: Object.freeze({ ...binding, measuredModels: Object.freeze([...(binding.measuredModels ?? [])]) }),
  }) as BuilddDecisionKind<K, F, D, Q>;
  registry.set(out.kind, out);
  return out;
}

/** Every kind defined in this process, for readouts. */
export function listBuilddDecisionKinds(): AnyBuilddDecisionKind[] {
  return [...registry.values()];
}

/** Was this kind's threshold measured on the model that answered? Jev always; others only when listed (a dated suffix matches). */
export function isMeasuredForKind(binding: Pick<BuilddDecisionKindBinding, 'measuredModels'>, model: string): boolean {
  if (isJevModel(model)) return true;
  return (binding.measuredModels ?? []).some(m => model === m || model.startsWith(`${m}-`));
}
