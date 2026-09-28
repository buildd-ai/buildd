/**
 * Heartbeat-triage experiment: the pure half.
 *
 * Question under test: does letting a decision model skip the organizer on a
 * confident "wait" cut organizer runs without delaying missions? Heartbeat
 * triage (apps/web/src/lib/heartbeat-triage.ts) asks the model on every cycle
 * either way; the experiment decides whether the answer may act.
 *
 * Arms, onto the registry's `control | treatment` columns:
 *   - `control`   = shadow: the organizer runs every cycle, the look is recorded.
 *   - `treatment` = applied: a confident `wait` skips the organizer.
 *
 * With no running experiment every mission is control, which is the shipped
 * behaviour: triage never skips anything outside an experiment.
 *
 * **The unit is the mission.** A skip moves the whole mission's timeline (the
 * next cycle sees the state the skipped one would have changed), so cycles of
 * one mission are not independent and cycle-level randomisation would mix
 * arms inside a mission. The draw is deterministic on the mission id, so no
 * stored row is needed to keep a mission in its arm.
 */
import { assignExperimentArm } from './experiment-randomizer';

export const HEARTBEAT_TRIAGE_EXPERIMENT_KIND = 'heartbeat_triage' as const;

export type HeartbeatTriageArm = 'control' | 'treatment';

export const DEFAULT_TRIAGE_WAIT_MIN_CONFIDENCE = 0.9;
export const DEFAULT_TRIAGE_MIN_SAMPLE_PER_ARM = 20;

/** The `experiments` row fields this module reads. */
export interface HeartbeatTriageExperimentRow {
  id: string;
  kind: string;
  status: string;
  treatmentFraction: number | string | null;
  policyVersion: number;
  config: unknown;
}

export interface HeartbeatTriageExperimentConfig {
  /** A `wait` below this confidence dispatches the organizer, in both arms. */
  waitMinConfidence: number;
  minSamplePerArm: number;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** Parse `experiments.config`; every field falls back to its default, never throws. */
export function parseHeartbeatTriageConfig(raw: unknown): HeartbeatTriageExperimentConfig {
  const cfg = asRecord(raw);
  const w = cfg.waitMinConfidence;
  const m = cfg.minSamplePerArm;
  return {
    // Below 0.5 a "wait" is not even the model's own majority view.
    waitMinConfidence: typeof w === 'number' && w >= 0.5 && w <= 1 ? w : DEFAULT_TRIAGE_WAIT_MIN_CONFIDENCE,
    minSamplePerArm: typeof m === 'number' && Number.isInteger(m) && m > 0 ? m : DEFAULT_TRIAGE_MIN_SAMPLE_PER_ARM,
  };
}

/** The config a new heartbeat_triage experiment gets when the caller sends none. */
export function defaultHeartbeatTriageConfig(): Record<string, unknown> {
  return {
    arms: { control: 'shadow', treatment: 'skip_on_confident_wait' },
    waitMinConfidence: DEFAULT_TRIAGE_WAIT_MIN_CONFIDENCE,
    minSamplePerArm: DEFAULT_TRIAGE_MIN_SAMPLE_PER_ARM,
  };
}

export interface HeartbeatTriageArmDecision {
  experimentId: string;
  policyVersion: number;
  arm: HeartbeatTriageArm;
  propensity: number;
  /** Whether a confident wait may skip the organizer this cycle. */
  apply: boolean;
  waitMinConfidence: number;
}

/** The mission's arm. Pure and deterministic on (experiment, version, mission). */
export function decideHeartbeatTriageArm(
  experiment: HeartbeatTriageExperimentRow,
  missionId: string,
): HeartbeatTriageArmDecision {
  const a = assignExperimentArm<HeartbeatTriageArm>({
    experimentId: experiment.id,
    policyVersion: String(experiment.policyVersion),
    controlArm: 'control',
    treatmentArm: 'treatment',
    unitId: missionId,
    fraction: experiment.treatmentFraction,
  });
  return {
    experimentId: experiment.id,
    policyVersion: experiment.policyVersion,
    arm: a.arm,
    propensity: a.propensity,
    apply: a.arm === 'treatment',
    waitMinConfidence: parseHeartbeatTriageConfig(experiment.config).waitMinConfidence,
  };
}
