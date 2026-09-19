/**
 * Generic per-unit experiment-arm randomiser.
 *
 * Extracted from the memory-digest experiment (`apps/runner/src/
 * memory-digest-policy.ts`, retired by the task that added this file — see
 * `docs/design/workspace-memory-digest-arm.md`). That experiment's assignment
 * logic was correct and reusable but hardcoded to one version constant, one
 * `'full' | 'task_scoped'` arm union and one call site
 * (`docs/design/experiment-lifecycle.md` names this as the thing to fix before
 * a second experiment exists). This module is the fix: every constant below is
 * a parameter instead.
 *
 * What makes an assignment correct, preserved from the original:
 *
 * - **Per unit, not per attempt.** A retried task gets a fresh worker; hashing
 *   on a stable unit id (a task id, typically) means a retry cannot land a
 *   different arm than the original attempt drew.
 * - **Version-salted.** The draw is salted with `experimentId` AND
 *   `policyVersion`, so bumping the version re-randomises — without the salt,
 *   every unit would keep the arm it drew under the old version, and a new
 *   comparison would silently inherit the old assignment and any carry-over
 *   effect from it. The experiment id is part of the salt too, so two
 *   experiments hashing the same unit id (e.g. two concurrent experiments both
 *   keyed on task id) draw independently rather than correlating.
 * - **Propensity recorded at assignment**, not reconstructed later from the
 *   configured fraction — the fraction can be reconfigured between assignment
 *   and analysis, so any off-policy estimate needs the probability that was
 *   actually in effect when the draw happened.
 * - **Out-of-range fractions rejected, not clamped.** A fat-fingered `15`
 *   (meant as 15%) must run the control, not enrol the entire fleet.
 */

/** FNV-1a offset basis / prime, 32-bit. */
const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/**
 * Map a string onto [0, 1) deterministically (FNV-1a, 32-bit).
 *
 * Not a security hash — it only needs to spread ids evenly and give the same
 * answer on every runner, every restart, and every replay of an analysis.
 *
 * FNV-1a degrades badly for keys that differ only in their last character or
 * two, so callers must pass high-entropy unit ids (v4 UUIDs are fine; a
 * sequential `unit-1`, `unit-2` scheme is not).
 *
 * Exported for tests only — assignment goes through `assignExperimentArm`,
 * which salts the key. A caller that hashes a bare id is not in the
 * experiment.
 */
export function hashUnitInterval(key: string): number {
  let h = FNV_OFFSET_BASIS;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, FNV_PRIME);
  }
  // >>> 0 first: Math.imul yields a signed int32.
  return (h >>> 0) / 0x100000000;
}

/**
 * Coerce a configured treatment share into a usable fraction.
 *
 * Numeric strings are accepted, because the operator-facing knob is typically
 * an env var and env vars are always strings — rejecting them would make a
 * documented override silently inert, which is a worse failure than a bad
 * value.
 *
 * Anything that is not a finite number inside [0, 1] resolves to 0, meaning
 * "run the control". Out-of-range values are rejected rather than clamped: a
 * fat-fingered `15` (meant as 15%) would clamp to 1 and cut the entire
 * population over to the treatment, which is the one outcome this function
 * exists to prevent.
 */
export function resolveEnrolmentFraction(raw: unknown): number {
  const n = typeof raw === 'string'
    ? (raw.trim() === '' ? NaN : Number(raw))
    : raw;
  if (typeof n !== 'number') return 0;
  if (!Number.isFinite(n)) return 0;
  if (n < 0 || n > 1) return 0;
  return n;
}

export interface ExperimentAssignment<TArm extends string> {
  arm: TArm;
  /**
   * Probability that this unit would have been assigned the arm it actually
   * got. Recorded at assignment time rather than reconstructed from the
   * fraction afterwards, because the fraction can be reconfigured between the
   * draw and the analysis.
   */
  propensity: number;
  /** The configured treatment share this assignment was drawn against. */
  fraction: number;
  policyVersion: string;
}

export interface AssignExperimentArmArgs<TArm extends string> {
  /**
   * Stable identifier for the experiment. Part of the salt, so two
   * experiments hashing the same unit id draw independently.
   */
  experimentId: string;
  /**
   * Bump whenever the meaning of an arm changes. Assignments drawn under a
   * different version are not comparable, and — because the draw is salted
   * with this — bumping it re-randomises.
   */
  policyVersion: string;
  controlArm: TArm;
  treatmentArm: TArm;
  /**
   * The unit to randomise on (a task id, typically). An empty or missing id
   * cannot be randomised stably, so it runs the control.
   */
  unitId: string | undefined | null;
  /** The configured treatment share; resolved via `resolveEnrolmentFraction`. */
  fraction: unknown;
}

/**
 * Assign an arm to a unit of work.
 *
 * The draw is salted with `${experimentId}:${policyVersion}:${unitId}`, so:
 * bumping `policyVersion` re-randomises everyone (no carry-over from a
 * previous definition of an arm); running two experiments against the same
 * unit ids does not correlate their assignments; and the same unit always
 * draws the same arm for as long as the experiment id and version hold still.
 */
export function assignExperimentArm<TArm extends string>(
  args: AssignExperimentArmArgs<TArm>,
): ExperimentAssignment<TArm> {
  const { experimentId, policyVersion, controlArm, treatmentArm, unitId } = args;
  const fraction = resolveEnrolmentFraction(args.fraction);
  const base = { fraction, policyVersion };

  if (!unitId) return { ...base, arm: controlArm, propensity: 1 };
  if (fraction <= 0) return { ...base, arm: controlArm, propensity: 1 };
  if (fraction >= 1) return { ...base, arm: treatmentArm, propensity: 1 };

  const draw = hashUnitInterval(`${experimentId}:${policyVersion}:${unitId}`);
  return draw < fraction
    ? { ...base, arm: treatmentArm, propensity: fraction }
    : { ...base, arm: controlArm, propensity: 1 - fraction };
}
