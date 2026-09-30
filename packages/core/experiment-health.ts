/**
 * Experiment health — does a running experiment's enrolment look like the
 * experiment it claims to be? Pure: rows in, findings out, no db, no clock.
 *
 * Every readout answers "which arm is winning". None of them answered "is the
 * draw happening at all", so experiments failed silently: a tier-pool
 * challenger arm that was never drawn, a triage experiment that enrolled
 * nobody, a mission-unit experiment where one large mission filled an arm, and
 * experiments with no end that ran on forever. Each of those is a finding here.
 *
 * Findings describe enrolment, never outcomes: nothing here peeks at which arm
 * is doing better, so acting on a finding cannot bias the comparison.
 *
 * The db half is ./experiment-health-source.ts; the alert is the
 * `/api/cron/experiment-health` route.
 */

import type { ExperimentHealthCode, ExperimentHealthFinding } from '@buildd/shared';

export type { ExperimentHealthCode, ExperimentHealthFinding };

export interface HealthAssignment {
  arm: string;
  /** The randomisation unit (mission, task or conversation). */
  unitId: string;
  assignedAt: Date;
}

export interface HealthInput {
  status: string;
  kind: string;
  startedAt: Date | null;
  config: Record<string, unknown>;
  /**
   * Expected share of units per arm. Two-arm kinds: { control: 1-f, treatment: f }.
   * Tier pools: the pool's current allocation over its live arms.
   */
  expectedShares: Record<string, number>;
  /** Rows of the current policy version (and, for tier pools, allocation version). */
  assignments: HealthAssignment[];
  /**
   * Latest assignment across ALL versions, when the caller knows it. Without
   * it the latest of `assignments` is used, so a fresh policy version with no
   * rows yet reads as "nothing enrolled".
   */
  lastAssignedAt?: Date | null;
}

export interface HealthThresholds {
  /** A running experiment with no assignment for this long is starved. */
  staleDays: number;
  /** An arm with a positive share and zero units after this many units total. */
  neverDrawnMinUnits: number;
  /** Units needed before the split is tested. */
  splitMinUnits: number;
  /** |z| of the per-arm binomial normal approximation that counts as off. 3 ≈ p < 0.003. */
  splitZ: number;
  /** Rows an arm needs before one unit's share of it is judged. */
  concentrationMinRows: number;
  /** One unit holding more than this share of an arm's rows. */
  concentrationMaxShare: number;
}

export const DEFAULT_HEALTH_THRESHOLDS: HealthThresholds = {
  staleDays: 3,
  neverDrawnMinUnits: 20,
  splitMinUnits: 20,
  splitZ: 3,
  concentrationMinRows: 20,
  concentrationMaxShare: 0.5,
};

const DAY_MS = 86_400_000;
const MAX_DURATION_DAYS = 365;

/**
 * Config keys that bound the experiment's lifetime but do not shape the draw.
 * Editing them must not bump policyVersion (which re-randomises every unit).
 */
export const DURATION_CAP_KEYS = ['maxDurationDays', 'endsAt'] as const;

export function stripNonDrawConfig(config: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...config };
  for (const k of DURATION_CAP_KEYS) delete out[k];
  return out;
}

/** Null when the optional cap fields are valid (or absent), else the error. */
export function validateDurationCap(config: Record<string, unknown>): string | null {
  const d = config.maxDurationDays;
  if (d !== undefined && d !== null) {
    if (typeof d !== 'number' || !Number.isFinite(d) || d <= 0 || d > MAX_DURATION_DAYS) {
      return `config.maxDurationDays must be a number of days between 0 and ${MAX_DURATION_DAYS}`;
    }
  }
  const e = config.endsAt;
  if (e !== undefined && e !== null) {
    if (typeof e !== 'string' || Number.isNaN(Date.parse(e))) {
      return 'config.endsAt must be an ISO 8601 date';
    }
  }
  return null;
}

/** When the experiment should stop: the earlier of start + maxDurationDays and endsAt. */
export function experimentDeadline(config: Record<string, unknown>, startedAt: Date | null): Date | null {
  const candidates: number[] = [];
  const d = config.maxDurationDays;
  if (startedAt && typeof d === 'number' && Number.isFinite(d) && d > 0) {
    candidates.push(startedAt.getTime() + d * DAY_MS);
  }
  const e = config.endsAt;
  if (typeof e === 'string' && !Number.isNaN(Date.parse(e))) candidates.push(Date.parse(e));
  return candidates.length ? new Date(Math.min(...candidates)) : null;
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

export function evaluateExperimentHealth(
  input: HealthInput,
  now: Date,
  t: HealthThresholds = DEFAULT_HEALTH_THRESHOLDS,
): ExperimentHealthFinding[] {
  if (input.status !== 'running') return [];
  const findings: ExperimentHealthFinding[] = [];

  // ── Past its cap ──────────────────────────────────────────────────────────
  const deadline = experimentDeadline(input.config, input.startedAt);
  if (deadline && now.getTime() > deadline.getTime()) {
    findings.push({
      code: 'past_duration_cap',
      severity: 'critical',
      detail: `running past its duration cap (${deadline.toISOString()}); conclude it or extend the cap`,
    });
  }

  // ── Starved ───────────────────────────────────────────────────────────────
  const latestRow = input.assignments.reduce<number | null>(
    (m, a) => (m === null || a.assignedAt.getTime() > m ? a.assignedAt.getTime() : m), null,
  );
  const latest = input.lastAssignedAt?.getTime() ?? latestRow;
  const staleMs = t.staleDays * DAY_MS;
  const runningFor = input.startedAt ? now.getTime() - input.startedAt.getTime() : null;
  if (runningFor !== null && runningFor > staleMs && (latest === null || now.getTime() - latest > staleMs)) {
    findings.push({
      code: 'no_recent_assignments',
      severity: 'critical',
      detail: latest === null
        ? `running ${Math.floor(runningFor / DAY_MS)}d and no unit enrolled yet`
        : `no unit enrolled in ${Math.floor((now.getTime() - latest) / DAY_MS)}d`,
    });
  }

  // ── Units per arm (a unit's first-seen arm; units, not rows, are the draws) ─
  const unitArm = new Map<string, string>();
  const rowsByArm = new Map<string, Map<string, number>>();
  for (const a of input.assignments) {
    if (!unitArm.has(a.unitId)) unitArm.set(a.unitId, a.arm);
    const perUnit = rowsByArm.get(a.arm) ?? new Map<string, number>();
    perUnit.set(a.unitId, (perUnit.get(a.unitId) ?? 0) + 1);
    rowsByArm.set(a.arm, perUnit);
  }
  const unitsByArm = new Map<string, number>();
  for (const arm of unitArm.values()) unitsByArm.set(arm, (unitsByArm.get(arm) ?? 0) + 1);
  const totalUnits = unitArm.size;

  // ── Never drawn ───────────────────────────────────────────────────────────
  let neverDrawn = false;
  if (totalUnits >= t.neverDrawnMinUnits) {
    for (const [arm, share] of Object.entries(input.expectedShares)) {
      if (share > 0 && !unitsByArm.get(arm)) {
        neverDrawn = true;
        findings.push({
          code: 'arm_never_drawn',
          severity: 'critical',
          arm,
          detail: `arm ${arm} has a ${pct(share)} share and 0 of ${totalUnits} units`,
        });
      }
    }
  }

  // ── Split off the declared fraction ───────────────────────────────────────
  // A never-drawn arm already says it louder; the z-test would only repeat it.
  if (!neverDrawn && totalUnits >= t.splitMinUnits) {
    let worst: { arm: string; z: number; observed: number; share: number } | null = null;
    for (const [arm, share] of Object.entries(input.expectedShares)) {
      if (share <= 0 || share >= 1) continue;
      const observed = unitsByArm.get(arm) ?? 0;
      const z = Math.abs(observed - totalUnits * share) / Math.sqrt(totalUnits * share * (1 - share));
      if (!worst || z > worst.z) worst = { arm, z, observed, share };
    }
    if (worst && worst.z > t.splitZ) {
      findings.push({
        code: 'split_imbalance',
        severity: 'warning',
        arm: worst.arm,
        detail: `arm ${worst.arm} holds ${worst.observed} of ${totalUnits} units (${pct(worst.observed / totalUnits)}) against a ${pct(worst.share)} share (z=${worst.z.toFixed(1)})`,
      });
    }
  }

  // ── One unit dominating an arm ────────────────────────────────────────────
  for (const [arm, perUnit] of rowsByArm) {
    let rowsInArm = 0;
    let top: { unitId: string; n: number } | null = null;
    for (const [unitId, n] of perUnit) {
      rowsInArm += n;
      if (!top || n > top.n) top = { unitId, n };
    }
    if (top && rowsInArm >= t.concentrationMinRows && top.n / rowsInArm > t.concentrationMaxShare) {
      findings.push({
        code: 'unit_concentration',
        severity: 'warning',
        arm,
        unitId: top.unitId,
        detail: `one unit (${top.unitId}) holds ${top.n} of ${rowsInArm} rows, ${pct(top.n / rowsInArm)} of the ${arm} arm`,
      });
    }
  }

  return findings;
}

/** Two-arm kinds: the declared treatment fraction as per-arm shares. */
export function twoArmShares(treatmentFraction: number): Record<string, number> {
  return { control: 1 - treatmentFraction, treatment: treatmentFraction };
}
