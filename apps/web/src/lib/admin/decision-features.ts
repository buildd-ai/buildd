import {
  ALL_INFERENCE_CAPABILITIES,
  INFERENCE_CAPABILITIES,
  type CapabilityKind,
  type InferenceCapability,
} from '@buildd/core/inference-policy';

/** Ledger totals for one capability over the window (decision_records or orchestration_decisions). */
export interface DecisionFeatureCount {
  capability: string;
  count: number;
  applied: number;
  suggested: number;
  fallback: number;
  overridden: number;
  costUsd: number;
  inputTokens: number;
}

export interface DecisionFeature extends Omit<DecisionFeatureCount, 'capability'> {
  id: InferenceCapability;
  kind: CapabilityKind;
  /** Another id with the same effect; its numbers are reported under that id. */
  aliasOf: InferenceCapability | null;
  /** The id still validates, but nothing calls it any more. */
  retired: boolean;
}

/** Group order: the order the kinds are introduced in packages/core/inference-policy.ts. */
export const DECISION_FEATURE_KINDS: readonly CapabilityKind[] = ['interactive', 'built_in', 'opt_in', 'server_feature'];

const ALIASES: Partial<Record<InferenceCapability, InferenceCapability>> = { task_role_apply: 'task_role_shadow' };
const RETIRED: ReadonlySet<InferenceCapability> = new Set(['heartbeat_triage']);

const ZERO = { count: 0, applied: 0, suggested: 0, fallback: 0, overridden: 0, costUsd: 0, inputTokens: 0 };
const round = (n: number) => Math.round(n * 1e6) / 1e6;

/**
 * Every inference capability the platform names, grouped by kind, each with
 * its ledger counts and cost. A capability with no rows reads zero; a ledger
 * row for an id the registry no longer names is kept in `unregistered` so a
 * renamed call site cannot hide spend.
 */
export function groupDecisionFeatures(counts: DecisionFeatureCount[]) {
  const byId = new Map<string, Omit<DecisionFeatureCount, 'capability'>>();
  for (const { capability, ...c } of counts) {
    const prev = byId.get(capability) ?? ZERO;
    byId.set(capability, {
      count: prev.count + c.count,
      applied: prev.applied + c.applied,
      suggested: prev.suggested + c.suggested,
      fallback: prev.fallback + c.fallback,
      overridden: prev.overridden + c.overridden,
      costUsd: prev.costUsd + c.costUsd,
      inputTokens: prev.inputTokens + c.inputTokens,
    });
  }

  const feature = (id: InferenceCapability): DecisionFeature => {
    const aliasOf = ALIASES[id] ?? null;
    const c = aliasOf ? ZERO : (byId.get(id) ?? ZERO);
    return { id, kind: INFERENCE_CAPABILITIES[id].kind, aliasOf, retired: RETIRED.has(id), ...c, costUsd: round(c.costUsd) };
  };

  const groups = DECISION_FEATURE_KINDS.map(kind => ({
    kind,
    features: ALL_INFERENCE_CAPABILITIES.filter(id => INFERENCE_CAPABILITIES[id].kind === kind).map(feature),
  }));

  const known = new Set<string>(ALL_INFERENCE_CAPABILITIES);
  const unregistered = [...byId.entries()]
    .filter(([id]) => !known.has(id))
    .map(([id, c]) => ({ id, ...c, costUsd: round(c.costUsd) }));

  let count = 0;
  let costUsd = 0;
  for (const c of byId.values()) { count += c.count; costUsd += c.costUsd; }

  return { groups, unregistered, totals: { count, costUsd: round(costUsd) } };
}
