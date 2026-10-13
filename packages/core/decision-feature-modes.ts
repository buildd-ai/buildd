/**
 * The platform owner's switch between "recording only" and "acting" for a
 * decision feature, and the honest account of what each feature does today.
 *
 * Two separate controls exist, on purpose:
 *
 * - **Which teams have a feature**: `teams.enabledDecisionShadows`, per team
 *   (Settings, or the admin team flags). Off means the model is never asked.
 * - **What the feature does once on**: this module. Most features already act
 *   (or advise a person) by design the moment a team turns them on, so there
 *   is nothing to switch. A feature whose code ships recording only, and that
 *   has an apply path, can be switched to acting by the platform owner: one
 *   `decision_feature_modes` row, recorded and reversible. No row means the
 *   code default. Switching back to recording always succeeds.
 *
 * A stored "acting" row pins what was switched (`measuredFingerprint`, the
 * feature's measured identity, and its `threshold`). If the feature's
 * questions or model change afterwards, the row stops matching and the
 * feature records again until it is switched on anew, so a switch never
 * silently carries over to a decision nobody looked at.
 *
 * The DB read is cached per instance for a minute and never throws: a failed
 * read is "no row", which is the code default.
 */
import type { InferenceCapability } from './inference-policy';
import { ALL_INFERENCE_CAPABILITIES } from './inference-policy';
import { manifestPickIdentity, storedManifestSwitchMatches } from './orchestration-promotion';
import type { DecisionFeatureMode, StoredFeatureMode } from './owner-feature-switches';

// Storage and the promotion bridge live in core (owner-feature-switches.ts,
// orchestration-promotion.ts) because the core manifest path reads them; the
// admin route imports everything from here.
export {
  clearDecisionFeatureModeCache,
  loadDecisionFeatureMode,
  loadDecisionFeatureModes,
  writeDecisionFeatureMode,
  type DecisionFeatureMode,
  type StoredFeatureMode,
} from './owner-feature-switches';
export { manifestPromotionFromRow } from './orchestration-promotion';

/** True when a stored acting row still describes the feature as deployed. */
export function storedRowMatches(feature: string, row: StoredFeatureMode | null | undefined): boolean {
  if (!SWITCHABLE_FEATURES[feature as InferenceCapability]) return false;
  return feature === 'orchestration_manifest' && storedManifestSwitchMatches(row);
}

/** What a feature does with the model's answer once a team has it on. */
export type DecisionFeatureEffect =
  | 'acts'        // the answer changes what buildd does, inside the feature's own rails
  | 'advises'     // the answer is shown to a person, who decides
  | 'records'     // the answer is stored and compared with what happened; nothing changes
  | 'interactive' // chat
  | 'unused'      // a named id with no call site
  | 'retired';    // the id still validates, nothing calls it


/** Features whose recording-only default the platform owner may switch. */
interface Switchable {
  /** The feature's measured identity today; a stored row must match it to act. */
  identity: () => string;
  /** Threshold used when the switch does not name one. */
  defaultThreshold: number;
  /** Bounds for an owner-supplied threshold. */
  thresholdRange: readonly [number, number];
  /** What acting means, in the reader's words. */
  acting: string;
}

/**
 * Per-pick confidence a predicted file needs before the prediction becomes the
 * task's scope. Conservative on purpose: a too-wide predicted scope only
 * serializes a task that could have run in parallel; a too-narrow one is
 * caught by the claim-time collision check. Owner may raise or lower it.
 */
export const MANIFEST_ACTING_DEFAULT_THRESHOLD = 0.9;

export const SWITCHABLE_FEATURES: Partial<Record<InferenceCapability, Switchable>> = {
  orchestration_manifest: {
    identity: manifestPickIdentity,
    defaultThreshold: MANIFEST_ACTING_DEFAULT_THRESHOLD,
    thresholdRange: [0.5, 0.99],
    acting: 'A confident prediction becomes the scope of a task filed without one, before a runner claims it.',
  },
};

/** Code defaults: what each feature does once a team turns it on. */
export const FEATURE_EFFECT: Record<InferenceCapability, DecisionFeatureEffect> = {
  criteria_grading: 'acts',
  visual_qa: 'unused',
  mission_summary: 'unused',
  heartbeat_triage: 'retired',
  task_category: 'acts',
  surface_audit_advice: 'advises',
  task_role_shadow: 'acts',
  task_role_apply: 'acts',
  orchestration_manifest: 'records',
  orchestration_claim: 'acts',
  orchestration_ordering: 'acts',
  mission_strand_choice: 'advises',
  mission_goal_quality: 'advises',
  scout_probe_selection: 'acts',
  endpoint_model_match: 'advises',
  question_gate: 'acts',
  escalation_gate: 'acts',
  post_session_triage: 'acts',
  failure_incident_triage: 'acts',
  visual_impact: 'acts',
  task_verdict: 'acts',
  early_release: 'acts',
  merge_readiness: 'advises',
  operator_recovery: 'acts',
  spec_duplicate: 'acts',
  spec_area: 'acts',
  chat: 'interactive',
};

const NOT_SWITCHABLE_REASON: Record<DecisionFeatureEffect, string> = {
  acts: 'Acts already for every team that has it on. Turn it off per team.',
  advises: 'Only ever advises a person, who decides. Turn it off per team.',
  interactive: 'Chat answers people directly; there is nothing to switch.',
  unused: 'Nothing calls it yet.',
  retired: 'Retired: nothing calls it.',
  records: 'No way to act on its answers is built yet.',
};

export interface FeatureModeView {
  mode: DecisionFeatureMode;
  effect: DecisionFeatureEffect;
  /** True when the owner can switch it (either way). */
  switchable: boolean;
  /** True when it acts now, or can be switched to act. */
  canAct: boolean;
  /** Why there is no switch, when there is none. */
  cannotActReason?: string;
  /** When the owner's switch to acting took effect. */
  actingSince?: string;
  /** Threshold in effect while acting. */
  threshold?: number;
  /** A stored acting row that no longer matches the feature. */
  stale?: string;
  /** What acting means, for a switchable feature. */
  actingMeans?: string;
}

/** The admin view of one feature, from the code default and the stored row. Pure. */
export function describeFeatureMode(feature: string, row: StoredFeatureMode | null | undefined): FeatureModeView {
  const effect = FEATURE_EFFECT[feature as InferenceCapability] ?? 'records';
  const s = SWITCHABLE_FEATURES[feature as InferenceCapability];
  if (!s) {
    const acting = effect === 'acts' || effect === 'advises' || effect === 'interactive';
    return { mode: acting ? 'acting' : 'recording', effect, switchable: false, canAct: acting, cannotActReason: NOT_SWITCHABLE_REASON[effect] };
  }
  if (storedRowMatches(feature, row)) {
    return {
      mode: 'acting', effect: 'acts', switchable: true, canAct: true,
      actingSince: row!.setAt.toISOString(), threshold: row!.threshold!, actingMeans: s.acting,
    };
  }
  const stale = row?.mode === 'acting'
    ? 'Back to recording only: its questions or model changed after it was switched on. Switch it on again to act.'
    : undefined;
  return { mode: 'recording', effect, switchable: true, canAct: true, actingMeans: s.acting, ...(stale ? { stale } : {}) };
}

export type SwitchRequest = { mode: DecisionFeatureMode; threshold?: number; reason?: string | null };
export type SwitchCheck =
  | { ok: true; row: Omit<StoredFeatureMode, 'setAt' | 'setByAccountId'> }
  | { ok: false; status: 400 | 404 | 409; error: string };

/** Validate an owner switch and build the row to store. Pure. */
export function planFeatureSwitch(feature: string, req: unknown): SwitchCheck {
  if (!(ALL_INFERENCE_CAPABILITIES as readonly string[]).includes(feature)) return { ok: false, status: 404, error: 'unknown decision feature' };
  if (!req || typeof req !== 'object' || Array.isArray(req)) return { ok: false, status: 400, error: 'body must be an object' };
  const b = req as Record<string, unknown>;
  const unknown = Object.keys(b).filter(k => !['mode', 'threshold', 'reason'].includes(k));
  if (unknown.length) return { ok: false, status: 400, error: `unknown field(s): ${unknown.join(', ')}` };
  if (b.mode !== 'acting' && b.mode !== 'recording') return { ok: false, status: 400, error: "mode must be 'acting' or 'recording'" };
  if (b.reason !== undefined && b.reason !== null && (typeof b.reason !== 'string' || b.reason.length > 500)) {
    return { ok: false, status: 400, error: 'reason must be a string of at most 500 characters' };
  }
  const reason = typeof b.reason === 'string' && b.reason.trim() ? b.reason.trim() : null;
  const s = SWITCHABLE_FEATURES[feature as InferenceCapability];
  if (!s) {
    const view = describeFeatureMode(feature, null);
    return { ok: false, status: 409, error: view.cannotActReason ?? 'This feature has no switch.' };
  }
  if (b.mode === 'recording') {
    return { ok: true, row: { feature, mode: 'recording', applyingFraction: 0, measuredFingerprint: null, threshold: null, reason } };
  }
  let threshold = s.defaultThreshold;
  if (b.threshold !== undefined) {
    const t = b.threshold;
    const [lo, hi] = s.thresholdRange;
    if (typeof t !== 'number' || !Number.isFinite(t) || t < lo || t > hi) {
      return { ok: false, status: 400, error: `threshold must be a number from ${lo} to ${hi}` };
    }
    threshold = t;
  }
  return { ok: true, row: { feature, mode: 'acting', applyingFraction: 1, measuredFingerprint: s.identity(), threshold, reason } };
}
