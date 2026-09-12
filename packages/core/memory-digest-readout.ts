/**
 * The reproducible readout for the workspace-memory-digest experiment
 * (`full` control vs `task_scoped` treatment — see
 * `apps/runner/src/memory-digest-policy.ts` and
 * `docs/design/workspace-memory-digest-arm.md`).
 *
 * Everything here is pure arithmetic over rows. No IO, no LLM, no judgement:
 * the same rows always produce the same numbers and the same text, so the
 * readout can be recomputed from history and checked by hand. The database
 * access lives in `memory-digest-readout-source.ts`, which is what makes the
 * analysis rules below testable without a live cohort.
 *
 * ── Why the rules are in code rather than in a runbook ──────────────────────
 *
 * An earlier hand-pasted analysis of this experiment was contaminated, in a way
 * that no amount of care at the SQL prompt would have caught twice running. The
 * four rules that analysis broke are therefore structural here:
 *
 *  1. **The cohort is split at a contamination boundary derived from the rows.**
 *     A retrieval change landed mid-enrolment without bumping
 *     `MEMORY_DIGEST_POLICY_VERSION`, so one policy version spans two injection
 *     behaviours. The change is visible in the data because it introduced a new
 *     `task_match_derived_by` value (`CONTAMINATION_MARKER`), and the boundary
 *     is the first timestamp that value appears. It is NEVER a constant in this
 *     file: a hardcoded date would be a second, silently-wrong source of truth
 *     the moment rows are backfilled, re-synced, or the marker appears earlier
 *     than someone remembered. Tasks whose prompt builds straddle the boundary
 *     belong to neither era and are excluded and counted.
 *
 *  2. **`called_recall` is reported per era and has no pooled figure.** Its
 *     apparent effect lives almost entirely in the pre-boundary era. A pooled
 *     number would be a measurement of the boundary dressed up as a measurement
 *     of the arm, which is exactly the mistake that got made. There is no code
 *     path here that produces one, so none can be quoted by accident.
 *
 *  3. **The primary outcomes are continuous process metrics.** Failure rate is
 *     a catastrophe guardrail: it answers "did the treatment break anything",
 *     never "did the treatment help". It is a rare binary event, so it has
 *     essentially no power at any realistic exposure, and promoting it to a
 *     primary outcome invites reading noise as a result.
 *
 *  4. **"Not yet conclusive" is a first-class verdict.** `accruing` is the
 *     expected steady state and is reported with an explicit power position (n
 *     per arm against what the design requires). An analysis that cannot say
 *     "not yet" will always say something else instead.
 *
 * A fifth rule is about this module's own failure modes rather than the
 * experiment's: an empty cohort, or one whose boundary cannot be derived, is
 * `indeterminate` — never a quiet pass. A readout that reports health over an
 * empty set is worse than no readout, because it is trusted.
 */

// ── Domain ──────────────────────────────────────────────────────────────────

export type MemoryDigestArm = 'full' | 'task_scoped';

export const ARMS: readonly MemoryDigestArm[] = ['full', 'task_scoped'] as const;

/** The control arm. Differences are always reported as treatment − control. */
export const CONTROL_ARM: MemoryDigestArm = 'full';
export const TREATMENT_ARM: MemoryDigestArm = 'task_scoped';

/**
 * The `task_match_derived_by` value whose first appearance marks the
 * mid-enrolment retrieval change. Rows before it and rows after it were built
 * by two different injection behaviours under one policy version.
 *
 * This is the NAME of a marker, not a date. The date is always derived.
 */
export const CONTAMINATION_MARKER = 'inferred_paths';

/**
 * The backend the readout segments to by default.
 *
 * Not a pooling decision deferred to the caller: prompt size means something
 * different on every backend, so *some* single backend has to be named, and
 * this is the one the fleet overwhelmingly runs.
 */
export const DEFAULT_BACKEND = 'claude';

/**
 * The policy version the readout reports on.
 *
 * Mirrors `MEMORY_DIGEST_POLICY_VERSION` in `apps/runner/src/memory-digest-policy.ts`.
 * It is duplicated rather than imported because `packages/core` must not depend
 * on `apps/runner` — and a duplicated constant that decides which rows are
 * comparable is exactly the kind that drifts silently, so
 * `packages/core/__tests__/memory-digest-readout-policy-pin.test.ts` parses the
 * runner source and fails if the two ever disagree.
 *
 * A stale value here would not throw. It would select an empty cohort and
 * report `indeterminate` for ever, which is why the readout treats an empty
 * cohort as an error rather than as health.
 */
export const READOUT_POLICY_VERSION = 'memory-digest-v4';

/**
 * The smallest standardised effect (Cohen's d) this experiment is *designed* to
 * detect, fixed up front.
 *
 * Deliberately a design parameter and not something re-derived from the
 * observed effect each run. Powering against whatever effect happens to be in
 * the data so far is circular — it makes the threshold chase the noise, and it
 * makes "we have enough data" a function of having got lucky.
 */
export const DESIGN_MDE = 0.22;

/** Two-sided α and target power for the exposure calculation. */
export const DESIGN_ALPHA = 0.05;
export const DESIGN_POWER = 0.8;

/**
 * How long the post-boundary cohort may go without a new prompt build before
 * accrual counts as stalled. Three days: long enough that a quiet weekend is
 * not a verdict, short enough to still be actionable on an experiment with
 * days of useful life left.
 */
export const STALL_MS = 3 * 24 * 60 * 60 * 1000;

/** One prompt-build row, as stored in `worker_prompt_composition_events`. */
export interface CompositionRow {
  taskId: string | null;
  workerId: string;
  buildIndex: number;
  ts: Date;
  policyVersion: string;
  arm: MemoryDigestArm;
  /** NULL = written by a runner predating the column. Never imputed. */
  taskMatchDerivedBy: string | null;
  /** NULL = predates the column. Rows must be segmented by backend, not pooled. */
  backend: string | null;
  promptBytes: number;
  memoryBlockBytes: number;
  digestBytes: number;
  digestBytesAvailable: number;
  memoryShare: number;
}

/**
 * One worker session belonging to a cohort task. A task's outcome spans its
 * whole retry chain, so these are summed per task, not averaged.
 *
 * `null` on a count means the runner did not report it (absent `toolCounts`),
 * which is UNKNOWN and not zero — the distinction is the difference between
 * "the treatment read no files" and "we cannot see how many files it read".
 */
export interface SessionRow {
  taskId: string | null;
  workerId: string;
  status: string;
  turns: number | null;
  durationMs: number | null;
  readCalls: number | null;
  shellCalls: number | null;
  /**
   * Whether this session called the `recall` tool. `null` is unknown.
   *
   * Sourced from the session's tool histogram, NOT from
   * `worker_action_events`. That table records the bare action name off the
   * `buildd` MCP call, and `recall` is a separate top-level tool — so it has
   * never appeared there and a query against it returns zero for every
   * session in both arms, for ever. That is not a null result, it is a metric
   * that cannot see, and it would have read as "the treatment did not change
   * recall usage" when the truth was unmeasured.
   */
  calledRecall: boolean | null;
}

export interface ReadoutOptions {
  /** Design MDE. Overridable for sensitivity analysis, not per-run tuning. */
  mde?: number;
  alpha?: number;
  power?: number;
  stallMs?: number;
}

export interface ReadoutInput {
  composition: readonly CompositionRow[];
  sessions: readonly SessionRow[];
  /** The only policy version this readout may report on. */
  policyVersion: string;
  /**
   * The single agent backend this readout covers. Defaults to
   * `DEFAULT_BACKEND`.
   *
   * Segmentation, never pooling: the Codex path delivers the role persona,
   * inlined skills and project instructions through a file on disk rather than
   * through the prompt, so `promptBytes` and `memoryShare` mean a different
   * thing per backend. A NULL backend predates the column and is genuinely
   * unknown — it is excluded and counted, not imputed to the default.
   */
  backend?: string;
  now: Date;
  options?: ReadoutOptions;
}

// ── Statistics (deterministic, closed form) ─────────────────────────────────

/**
 * Standard-normal quantiles, as constants.
 *
 * Hardcoded rather than computed because only two are ever needed and an
 * inverse-normal implementation is a lot of surface area to get subtly wrong in
 * the tail. z(0.975) for a two-sided 95% interval; z(0.80) for 80% power.
 */
const Z_975 = 1.959963985;
const Z_80 = 0.841621234;

const Z_BY_ALPHA: Record<string, number> = { '0.05': Z_975, '0.1': 1.644853627, '0.01': 2.575829304 };
const Z_BY_POWER: Record<string, number> = { '0.8': Z_80, '0.9': 1.281551566, '0.95': Z_975 };

function zForAlpha(alpha: number): number {
  return Z_BY_ALPHA[String(alpha)] ?? Z_975;
}
function zForPower(power: number): number {
  return Z_BY_POWER[String(power)] ?? Z_80;
}

/**
 * Tasks needed **per arm** to detect a standardised effect `d` at the given
 * two-sided α and power, for a two-sample comparison of means.
 *
 *   n = 2 (z_{1-α/2} + z_{power})² / d²
 */
export function requiredNPerArm(d: number, alpha = DESIGN_ALPHA, power = DESIGN_POWER): number {
  if (!Number.isFinite(d) || d <= 0) return Infinity;
  const z = zForAlpha(alpha) + zForPower(power);
  return Math.ceil((2 * z * z) / (d * d));
}

export interface ArmSummary {
  n: number;
  mean: number | null;
  sd: number | null;
}

function summarize(values: readonly number[]): ArmSummary {
  const n = values.length;
  if (n === 0) return { n: 0, mean: null, sd: null };
  const mean = values.reduce((s, v) => s + v, 0) / n;
  if (n < 2) return { n, mean, sd: null };
  const ss = values.reduce((s, v) => s + (v - mean) * (v - mean), 0);
  return { n, mean, sd: Math.sqrt(ss / (n - 1)) };
}

export interface Interval {
  value: number | null;
  ciLow: number | null;
  ciHigh: number | null;
}

const NO_INTERVAL: Interval = { value: null, ciLow: null, ciHigh: null };

/**
 * Welch difference in means (treatment − control) with a normal-approximation
 * 95% interval.
 *
 * The normal approximation is anti-conservative at small n — a t-quantile would
 * need an inverse incomplete beta, and nothing in the *verdict* depends on
 * these intervals (that is decided by n and by accrual), so the extra surface
 * area buys precision on a number that is already labelled as provisional
 * until the cohort is powered.
 */
export function welchDiff(treatment: ArmSummary, control: ArmSummary, alpha = DESIGN_ALPHA): Interval {
  if (treatment.mean === null || control.mean === null) return NO_INTERVAL;
  const diff = treatment.mean - control.mean;
  if (treatment.sd === null || control.sd === null || treatment.n < 2 || control.n < 2) {
    return { value: diff, ciLow: null, ciHigh: null };
  }
  const se = Math.sqrt((treatment.sd * treatment.sd) / treatment.n + (control.sd * control.sd) / control.n);
  const z = zForAlpha(alpha);
  return { value: diff, ciLow: diff - z * se, ciHigh: diff + z * se };
}

/**
 * Hedges' g (bias-corrected Cohen's d), treatment − control, with a
 * normal-approximation interval.
 */
export function hedgesG(treatment: ArmSummary, control: ArmSummary, alpha = DESIGN_ALPHA): Interval {
  if (treatment.mean === null || control.mean === null) return NO_INTERVAL;
  const n1 = treatment.n;
  const n2 = control.n;
  if (n1 < 2 || n2 < 2 || treatment.sd === null || control.sd === null) return NO_INTERVAL;
  const pooledVar =
    ((n1 - 1) * treatment.sd * treatment.sd + (n2 - 1) * control.sd * control.sd) / (n1 + n2 - 2);
  const sPooled = Math.sqrt(pooledVar);
  // A degenerate spread makes a standardised effect meaningless — and the test
  // is RELATIVE, not `sPooled > 0`. A metric that is constant within each arm
  // (a fixed cap, a config-derived size) leaves a residue of floating-point
  // dust in the pooled sd, which divides into an effect size of 1e15 that
  // renders as a real number and reads as the largest result on the page.
  const scale = Math.max(Math.abs(treatment.mean), Math.abs(control.mean), 1);
  if (!(sPooled > 0) || sPooled < 1e-9 * scale) return NO_INTERVAL;
  const d = (treatment.mean - control.mean) / sPooled;
  const j = 1 - 3 / (4 * (n1 + n2) - 9);
  const g = j * d;
  const se = Math.sqrt((n1 + n2) / (n1 * n2) + (g * g) / (2 * (n1 + n2 - 2)));
  const z = zForAlpha(alpha);
  return { value: g, ciLow: g - z * se, ciHigh: g + z * se };
}

/**
 * Agresti–Caffo interval for a difference of proportions (treatment − control).
 *
 * Preferred over the plain Wald interval because rare binary outcomes — the
 * failure guardrail especially — put the Wald interval's coverage on the floor
 * exactly where it matters. The point estimate reported is the adjusted one, so
 * the interval always contains it; raw rates are reported per arm alongside.
 */
export function riskDiff(
  treatmentSuccesses: number,
  treatmentN: number,
  controlSuccesses: number,
  controlN: number,
  alpha = DESIGN_ALPHA,
): Interval {
  if (treatmentN <= 0 || controlN <= 0) return NO_INTERVAL;
  const p1 = (treatmentSuccesses + 1) / (treatmentN + 2);
  const p2 = (controlSuccesses + 1) / (controlN + 2);
  const diff = p1 - p2;
  const se = Math.sqrt((p1 * (1 - p1)) / (treatmentN + 2) + (p2 * (1 - p2)) / (controlN + 2));
  const z = zForAlpha(alpha);
  return { value: diff, ciLow: diff - z * se, ciHigh: diff + z * se };
}

// ── Per-task observations ───────────────────────────────────────────────────

export type Era = 'pre' | 'post';

/**
 * One unit of randomisation: a task.
 *
 * Randomisation is on the task id, so the task — not the worker and not the
 * prompt build — is the analysis unit. Process metrics are summed across the
 * task's whole retry chain because that is the span the outcome covers.
 */
export interface TaskObservation {
  taskId: string;
  arm: MemoryDigestArm;
  era: Era;
  /** Timestamp of the task's first prompt build — its enrolment moment. */
  enrolledAt: Date;
  /** Timestamp of the task's last prompt build, for accrual recency. */
  lastBuildAt: Date;
  taskMatchDerivedBy: string | null;
  promptBytes: number;
  memoryShare: number;
  turns: number | null;
  durationMs: number | null;
  readCalls: number | null;
  shellCalls: number | null;
  failed: boolean;
  /** Null when no session reported a tool histogram — unknown, not false. */
  calledRecall: boolean | null;
}

/** Worker statuses that count as a catastrophe for the guardrail. */
const FAILED_STATUSES = new Set(['failed', 'error']);

/**
 * The contamination boundary: the first moment the marker value appears.
 *
 * Returns null when no row carries it, which means the split cannot be made and
 * the readout must refuse to report one. NULL `taskMatchDerivedBy` is unknown,
 * never the marker.
 */
export function deriveContaminationBoundary(rows: readonly CompositionRow[]): Date | null {
  let earliest: Date | null = null;
  for (const r of rows) {
    if (r.taskMatchDerivedBy !== CONTAMINATION_MARKER) continue;
    if (earliest === null || r.ts.getTime() < earliest.getTime()) earliest = r.ts;
  }
  return earliest;
}

/**
 * OR across a task's sessions, preserving "nobody reported this" as null.
 *
 * One session that definitely called recall makes the task a caller even if
 * its siblings are unknown; all-unknown stays unknown rather than collapsing
 * to false, which is the difference between a measurement and an assumption.
 */
function anyKnownTrue(values: ReadonlyArray<boolean | null>): boolean | null {
  if (values.some(v => v === true)) return true;
  if (values.some(v => v === false)) return false;
  return null;
}

/** Sum across a task's sessions, preserving "nobody reported this" as null. */
function sumKnown(values: ReadonlyArray<number | null>): number | null {
  const known = values.filter((v): v is number => v !== null && Number.isFinite(v));
  if (known.length === 0) return null;
  return known.reduce((s, v) => s + v, 0);
}

export interface ExclusionCounts {
  /** Prompt builds with no task id — unrandomisable, so uncountable. */
  noTaskId: number;
  /** Tasks seen under a foreign policy version. Never pooled. */
  foreignPolicyVersion: number;
  /** Tasks whose builds disagree about the arm. Assignment is deterministic,
   *  so this is corruption, not variance. */
  mixedArm: number;
  /** Tasks whose builds span the boundary — they belong to neither era. */
  straddling: number;
  /** Rows on another backend, or on none at all (NULL predates the column). */
  otherBackend: number;
}

interface BuiltObservations {
  observations: TaskObservation[];
  excluded: ExclusionCounts;
  boundary: Date | null;
  markerRowsBefore: number;
  markerRowsAfter: number;
  cohortRows: number;
}

function buildObservations(input: ReadoutInput): BuiltObservations {
  const excluded: ExclusionCounts = {
    noTaskId: 0,
    foreignPolicyVersion: 0,
    mixedArm: 0,
    straddling: 0,
    otherBackend: 0,
  };
  const backend = input.backend ?? DEFAULT_BACKEND;

  const byTask = new Map<string, CompositionRow[]>();
  const foreignTasks = new Set<string>();

  for (const row of input.composition) {
    if (!row.taskId) {
      excluded.noTaskId++;
      continue;
    }
    if (row.backend !== backend) {
      excluded.otherBackend++;
      continue;
    }
    if (row.policyVersion !== input.policyVersion) {
      foreignTasks.add(row.taskId);
      continue;
    }
    const list = byTask.get(row.taskId);
    if (list) list.push(row);
    else byTask.set(row.taskId, [row]);
  }
  // A task counts as foreign-version-excluded only if it contributed no rows to
  // the cohort at all; a task with rows on both sides of a version bump has
  // been re-randomised and its cohort rows are legitimately ours.
  for (const t of foreignTasks) if (!byTask.has(t)) excluded.foreignPolicyVersion++;

  const cohortRows = [...byTask.values()].reduce((s, rows) => s + rows.length, 0);
  const boundary = deriveContaminationBoundary([...byTask.values()].flat());

  const sessionsByTask = new Map<string, SessionRow[]>();
  for (const s of input.sessions) {
    if (!s.taskId) continue;
    const list = sessionsByTask.get(s.taskId);
    if (list) list.push(s);
    else sessionsByTask.set(s.taskId, [s]);
  }
  let markerRowsBefore = 0;
  let markerRowsAfter = 0;
  const observations: TaskObservation[] = [];

  for (const [taskId, rows] of byTask) {
    const arms = new Set(rows.map(r => r.arm));
    if (arms.size > 1) {
      excluded.mixedArm++;
      continue;
    }
    // Order by the runner's own build index, ts as a tiebreak.
    const ordered = [...rows].sort((a, b) => a.buildIndex - b.buildIndex || a.ts.getTime() - b.ts.getTime());
    const first = ordered[0];
    const last = ordered[ordered.length - 1];

    if (boundary === null) continue;
    const before = ordered.filter(r => r.ts.getTime() < boundary.getTime()).length;
    if (before > 0) markerRowsBefore += before;
    markerRowsAfter += ordered.length - before;
    if (before > 0 && before < ordered.length) {
      excluded.straddling++;
      continue;
    }
    const era: Era = before === ordered.length ? 'pre' : 'post';

    const sessions = sessionsByTask.get(taskId) ?? [];
    observations.push({
      taskId,
      arm: first.arm,
      era,
      enrolledAt: first.ts,
      lastBuildAt: last.ts,
      taskMatchDerivedBy: first.taskMatchDerivedBy,
      promptBytes: first.promptBytes,
      memoryShare: first.memoryShare,
      turns: sumKnown(sessions.map(s => s.turns)),
      durationMs: sumKnown(sessions.map(s => s.durationMs)),
      readCalls: sumKnown(sessions.map(s => s.readCalls)),
      shellCalls: sumKnown(sessions.map(s => s.shellCalls)),
      failed: sessions.some(s => FAILED_STATUSES.has(s.status)),
      calledRecall: anyKnownTrue(sessions.map(s => s.calledRecall)),
    });
  }

  observations.sort((a, b) => a.enrolledAt.getTime() - b.enrolledAt.getTime() || a.taskId.localeCompare(b.taskId));

  return { observations, excluded, boundary, markerRowsBefore, markerRowsAfter, cohortRows };
}

// ── Metric results ──────────────────────────────────────────────────────────

export interface ContinuousMetricResult {
  key: string;
  label: string;
  unit: string;
  role: 'primary';
  /** Share of the era's tasks that reported this metric at all. */
  coverage: number;
  arms: Record<MemoryDigestArm, ArmSummary>;
  /** Treatment − control, absolute units. */
  diff: Interval;
  /** Treatment − control, standardised (Hedges' g). */
  effect: Interval;
}

export interface BinaryMetricResult {
  key: string;
  label: string;
  role: 'guardrail' | 'secondary-per-era';
  /** Share of the era's tasks where this outcome was observable at all. */
  coverage: number;
  arms: Record<MemoryDigestArm, { n: number; events: number; rate: number | null }>;
  /** Treatment − control risk difference (Agresti–Caffo point estimate). */
  diff: Interval;
  /** Present on anything that must never be quoted across eras. */
  pooledWarning?: string;
  /** Set when nothing was observable, so the zeroes cannot be read as a result. */
  coverageWarning?: string;
}

export interface BalanceCategory {
  category: string;
  arms: Record<MemoryDigestArm, { n: number; events: number; rate: number | null }>;
  diff: Interval;
}

export interface BalanceResult {
  field: string;
  rationale: string;
  categories: BalanceCategory[];
  /** True when any category's difference interval excludes zero. */
  imbalanced: boolean;
}

export interface EraReadout {
  era: Era;
  /** Only the post-boundary era is comparable; `pre` is reported for contrast. */
  valid: boolean;
  note: string;
  n: Record<MemoryDigestArm, number>;
  firstObservationAt: string | null;
  lastObservationAt: string | null;
  metrics: ContinuousMetricResult[];
  guardrail: BinaryMetricResult;
  secondary: BinaryMetricResult[];
  balance: BalanceResult;
}

export type VerdictStatus = 'indeterminate' | 'accruing' | 'powered' | 'stalled';

export interface Verdict {
  status: VerdictStatus;
  /** Terminal means "stop waiting and look" — the only state that notifies. */
  terminal: boolean;
  /** The readout could not be computed. Non-terminal, but never a quiet pass. */
  indeterminate: boolean;
  headline: string;
  reason: string;
  /** Smaller arm of the post-boundary cohort. */
  nPerArm: number;
  requiredNPerArm: number;
  fractionOfRequired: number;
  /** Hours since the last post-boundary prompt build, or null when there are none. */
  hoursSinceLastObservation: number | null;
  /** Stable across runs for one verdict, so one verdict pages exactly once. */
  notificationKey: string;
}

export interface Readout {
  policyVersion: string;
  /** The single backend segment these numbers describe. */
  backend: string;
  generatedAt: string;
  /** Null when the boundary could not be derived — the split is then refused. */
  boundary: {
    at: string;
    derivedFrom: string;
    rowsBefore: number;
    rowsAfter: number;
  } | null;
  cohortRows: number;
  excluded: ExclusionCounts;
  design: { mde: number; alpha: number; power: number; stallHours: number };
  eras: Record<Era, EraReadout>;
  verdict: Verdict;
}

interface MetricSpec {
  key: string;
  label: string;
  unit: string;
  pick: (o: TaskObservation) => number | null;
}

/**
 * The primary outcomes: continuous process metrics.
 *
 * Every one of these is a property of the prompt or of the work the prompt
 * caused, measured on every task, which is what makes them usable at this
 * exposure. Order is fixed so the rendered text is byte-stable.
 */
const METRIC_SPECS: readonly MetricSpec[] = [
  { key: 'promptBytes', label: 'prompt bytes', unit: 'bytes', pick: o => o.promptBytes },
  { key: 'memoryShare', label: 'memory share of prompt', unit: 'fraction', pick: o => o.memoryShare },
  { key: 'readCalls', label: 'file-read calls', unit: 'calls', pick: o => o.readCalls },
  { key: 'shellCalls', label: 'shell calls', unit: 'calls', pick: o => o.shellCalls },
  { key: 'turns', label: 'turns', unit: 'turns', pick: o => o.turns },
  { key: 'durationMs', label: 'duration', unit: 'ms', pick: o => o.durationMs },
] as const;

function byArm(observations: readonly TaskObservation[]): Record<MemoryDigestArm, TaskObservation[]> {
  return {
    full: observations.filter(o => o.arm === 'full'),
    task_scoped: observations.filter(o => o.arm === 'task_scoped'),
  };
}

function continuousMetric(
  spec: MetricSpec,
  arms: Record<MemoryDigestArm, TaskObservation[]>,
  alpha: number,
): ContinuousMetricResult {
  const values = {
    full: arms.full.map(spec.pick).filter((v): v is number => v !== null),
    task_scoped: arms.task_scoped.map(spec.pick).filter((v): v is number => v !== null),
  };
  const summaries = {
    full: summarize(values.full),
    task_scoped: summarize(values.task_scoped),
  };
  const total = arms.full.length + arms.task_scoped.length;
  const known = values.full.length + values.task_scoped.length;
  return {
    key: spec.key,
    label: spec.label,
    unit: spec.unit,
    role: 'primary',
    coverage: total === 0 ? 0 : known / total,
    arms: summaries,
    diff: welchDiff(summaries[TREATMENT_ARM], summaries[CONTROL_ARM], alpha),
    effect: hedgesG(summaries[TREATMENT_ARM], summaries[CONTROL_ARM], alpha),
  };
}

/**
 * A binary outcome, over the tasks where it was observable.
 *
 * `pick` is tri-state: `null` means the outcome could not be seen for that
 * task, and such tasks are dropped from the denominator instead of counted as
 * non-events. Counting them would turn missing instrumentation into a
 * measured zero — the single most misreadable number a readout can print.
 */
function binaryMetric(
  key: string,
  label: string,
  role: BinaryMetricResult['role'],
  arms: Record<MemoryDigestArm, TaskObservation[]>,
  pick: (o: TaskObservation) => boolean | null,
  alpha: number,
  pooledWarning?: string,
): BinaryMetricResult {
  const cell = (list: TaskObservation[]) => {
    const known = list.filter(o => pick(o) !== null);
    const events = known.filter(o => pick(o) === true).length;
    return { n: known.length, events, rate: known.length === 0 ? null : events / known.length };
  };
  const full = cell(arms.full);
  const treatment = cell(arms.task_scoped);
  const total = arms.full.length + arms.task_scoped.length;
  const coverage = total === 0 ? 0 : (full.n + treatment.n) / total;
  return {
    key,
    label,
    role,
    coverage,
    arms: { full, task_scoped: treatment },
    diff: coverage === 0 ? NO_INTERVAL : riskDiff(treatment.events, treatment.n, full.events, full.n, alpha),
    ...(pooledWarning ? { pooledWarning } : {}),
    ...(coverage === 0 && total > 0
      ? {
          coverageWarning:
            'NOT MEASURED for any task in this era. The zeroes below are absence of instrumentation, not absence of effect, and must not be reported as a null result.',
        }
      : {}),
  };
}

const BALANCE_RATIONALE =
  'Assignment is a hash of the task id salted with the policy version, so retrieval ' +
  'provenance cannot correlate with the arm by construction. A difference here is ' +
  'evidence the cohort is broken, not evidence about the treatment.';

function balanceCheck(arms: Record<MemoryDigestArm, TaskObservation[]>, alpha: number): BalanceResult {
  const label = (o: TaskObservation) => o.taskMatchDerivedBy ?? 'unknown';
  const categories = [...new Set([...arms.full, ...arms.task_scoped].map(label))].sort();
  const rows: BalanceCategory[] = categories.map(category => {
    const cell = (list: TaskObservation[]) => {
      const events = list.filter(o => label(o) === category).length;
      return { n: list.length, events, rate: list.length === 0 ? null : events / list.length };
    };
    const full = cell(arms.full);
    const treatment = cell(arms.task_scoped);
    return {
      category,
      arms: { full, task_scoped: treatment },
      diff: riskDiff(treatment.events, treatment.n, full.events, full.n, alpha),
    };
  });
  const imbalanced = rows.some(
    r => r.diff.ciLow !== null && r.diff.ciHigh !== null && (r.diff.ciLow > 0 || r.diff.ciHigh < 0),
  );
  return { field: 'taskMatchDerivedBy', rationale: BALANCE_RATIONALE, categories: rows, imbalanced };
}

const CALLED_RECALL_WARNING =
  'Reported per era only. The pooled figure for this outcome is a measurement of the ' +
  'contamination boundary, not of the arm, and must never be quoted.';

function eraReadout(era: Era, observations: readonly TaskObservation[], alpha: number): EraReadout {
  const arms = byArm(observations);
  const times = observations.map(o => o.lastBuildAt.getTime());
  return {
    era,
    valid: era === 'post',
    note:
      era === 'post'
        ? 'Valid cohort: one injection behaviour throughout.'
        : 'Pre-boundary cohort. Reported for contrast only — a retrieval change landed mid-enrolment, so these rows are not comparable with the post-boundary ones and must not be pooled with them.',
    n: { full: arms.full.length, task_scoped: arms.task_scoped.length },
    firstObservationAt: times.length ? new Date(Math.min(...times)).toISOString() : null,
    lastObservationAt: times.length ? new Date(Math.max(...times)).toISOString() : null,
    metrics: METRIC_SPECS.map(spec => continuousMetric(spec, arms, alpha)),
    guardrail: binaryMetric('failureRate', 'failure rate', 'guardrail', arms, o => o.failed, alpha),
    secondary: [
      binaryMetric(
        'calledRecall',
        'called_recall',
        'secondary-per-era',
        arms,
        o => o.calledRecall,
        alpha,
        CALLED_RECALL_WARNING,
      ),
    ],
    balance: balanceCheck(arms, alpha),
  };
}

// ── The readout ─────────────────────────────────────────────────────────────

export function computeReadout(input: ReadoutInput): Readout {
  const mde = input.options?.mde ?? DESIGN_MDE;
  const alpha = input.options?.alpha ?? DESIGN_ALPHA;
  const power = input.options?.power ?? DESIGN_POWER;
  const stallMs = input.options?.stallMs ?? STALL_MS;

  const built = buildObservations(input);
  const pre = built.observations.filter(o => o.era === 'pre');
  const post = built.observations.filter(o => o.era === 'post');

  const eras: Record<Era, EraReadout> = {
    pre: eraReadout('pre', pre, alpha),
    post: eraReadout('post', post, alpha),
  };

  const required = requiredNPerArm(mde, alpha, power);
  const nPerArm = Math.min(eras.post.n.full, eras.post.n.task_scoped);

  // Recency is judged on the post-boundary cohort when it exists, and on the
  // cohort as a whole when it does not — otherwise "the boundary landed and
  // then nothing ever arrived" would look identical to "still warming up".
  const recencySource = post.length > 0 ? post : built.observations;
  const lastAt = recencySource.length
    ? Math.max(...recencySource.map(o => o.lastBuildAt.getTime()))
    : null;
  const hoursSinceLastObservation =
    lastAt === null ? null : (input.now.getTime() - lastAt) / (60 * 60 * 1000);

  const verdict = decideVerdict({
    policyVersion: input.policyVersion,
    boundary: built.boundary,
    cohortRows: built.cohortRows,
    nPerArm,
    required,
    lastAt,
    now: input.now,
    stallMs,
    hoursSinceLastObservation,
  });

  return {
    policyVersion: input.policyVersion,
    backend: input.backend ?? DEFAULT_BACKEND,
    generatedAt: input.now.toISOString(),
    boundary: built.boundary
      ? {
          at: built.boundary.toISOString(),
          derivedFrom: `first appearance of task_match_derived_by='${CONTAMINATION_MARKER}'`,
          rowsBefore: built.markerRowsBefore,
          rowsAfter: built.markerRowsAfter,
        }
      : null,
    cohortRows: built.cohortRows,
    excluded: built.excluded,
    design: { mde, alpha, power, stallHours: stallMs / (60 * 60 * 1000) },
    eras,
    verdict,
  };
}

function decideVerdict(args: {
  policyVersion: string;
  boundary: Date | null;
  cohortRows: number;
  nPerArm: number;
  required: number;
  lastAt: number | null;
  now: Date;
  stallMs: number;
  hoursSinceLastObservation: number | null;
}): Verdict {
  const { policyVersion, boundary, cohortRows, nPerArm, required } = args;
  const fractionOfRequired = Number.isFinite(required) && required > 0 ? nPerArm / required : 0;
  const base = {
    nPerArm,
    requiredNPerArm: required,
    fractionOfRequired,
    hoursSinceLastObservation: args.hoursSinceLastObservation,
  };

  // Indeterminate: the readout could not be computed. Deliberately NOT a quiet
  // pass — an empty cohort is how a broken collection path looks, and reporting
  // health over an empty set is the failure mode this whole file guards against.
  if (cohortRows === 0) {
    return {
      ...base,
      status: 'indeterminate',
      terminal: false,
      indeterminate: true,
      headline: 'Indeterminate — no prompt-composition rows for this policy version.',
      reason:
        'No rows in the cohort. Either nobody is enrolled, or the collection path from the runner to worker_prompt_composition_events is broken. Check the runner is emitting [prompt-composition] and that PATCH /api/workers/[id] is inserting.',
      notificationKey: `${policyVersion}:indeterminate:no-rows`,
    };
  }
  if (boundary === null) {
    return {
      ...base,
      status: 'indeterminate',
      terminal: false,
      indeterminate: true,
      headline: 'Indeterminate — the contamination boundary cannot be derived from the rows.',
      reason: `No row carries task_match_derived_by='${CONTAMINATION_MARKER}', so the cohort cannot be split at the mid-enrolment retrieval change. Reporting a single pooled cohort here would be reporting the contamination. Refusing.`,
      notificationKey: `${policyVersion}:indeterminate:no-boundary`,
    };
  }

  if (nPerArm >= required) {
    return {
      ...base,
      status: 'powered',
      terminal: true,
      indeterminate: false,
      headline: `Terminal — post-boundary cohort is powered (n per arm ${nPerArm} of ${required}).`,
      reason: `The smaller post-boundary arm has reached the exposure the design requires to detect d=${DESIGN_MDE} at ${Math.round(
        DESIGN_POWER * 100,
      )}% power. Read the effect sizes and their intervals.`,
      notificationKey: `${policyVersion}:powered`,
    };
  }

  const stalled = args.lastAt !== null && args.now.getTime() - args.lastAt >= args.stallMs;
  if (stalled) {
    const hours = Math.floor((args.hoursSinceLastObservation ?? 0));
    return {
      ...base,
      status: 'stalled',
      terminal: true,
      indeterminate: false,
      headline: `Terminal — accrual stalled at n per arm ${nPerArm} of ${required}.`,
      reason: `No new post-boundary prompt build in ${hours}h. Accrual has stalled short of power, so waiting longer will not resolve it: either enrolment stopped (check BUILDD_MEMORY_DIGEST_TASK_SCOPED_FRACTION on every runner) or the experiment is over and this is the most it will ever have.`,
      notificationKey: `${policyVersion}:stalled`,
    };
  }

  return {
    ...base,
    status: 'accruing',
    terminal: false,
    indeterminate: false,
    headline: `Accruing — not yet conclusive (n per arm ${nPerArm} of ${required}).`,
    reason:
      'The post-boundary cohort is still growing and has not reached the exposure the design requires. This is the expected steady state, not a problem.',
    notificationKey: `${policyVersion}:accruing`,
  };
}

// ── Rendering ───────────────────────────────────────────────────────────────

function num(v: number | null, digits = 2): string {
  if (v === null || !Number.isFinite(v)) return 'n/a';
  return v.toFixed(digits);
}

function interval(i: Interval, digits = 2): string {
  if (i.value === null) return 'n/a';
  if (i.ciLow === null || i.ciHigh === null) return `${num(i.value, digits)} (CI n/a)`;
  return `${num(i.value, digits)} [${num(i.ciLow, digits)}, ${num(i.ciHigh, digits)}]`;
}

function pct(v: number | null): string {
  return v === null ? 'n/a' : `${(v * 100).toFixed(1)}%`;
}

function renderEra(e: EraReadout): string[] {
  const tag = e.era === 'pre' ? 'pre-boundary' : 'post-boundary';
  const out: string[] = [];
  out.push('');
  out.push(`── ${tag} cohort ${e.valid ? '(VALID)' : '(contrast only — do not pool)'} ──`);
  out.push(`  ${e.note}`);
  out.push(`  n: full=${e.n.full}  task_scoped=${e.n.task_scoped}`);
  out.push(`  window: ${e.firstObservationAt ?? 'n/a'} → ${e.lastObservationAt ?? 'n/a'}`);

  if (e.n.full === 0 && e.n.task_scoped === 0) {
    out.push('  (no tasks in this era)');
    return out;
  }

  out.push('  primary outcomes (continuous process metrics; diff = task_scoped − full):');
  for (const m of e.metrics) {
    const digits = m.key === 'memoryShare' ? 4 : 1;
    out.push(
      `    ${m.label.padEnd(24)} full ${num(m.arms.full.mean, digits)} (sd ${num(m.arms.full.sd, digits)}, n ${m.arms.full.n})` +
        `  task_scoped ${num(m.arms.task_scoped.mean, digits)} (sd ${num(m.arms.task_scoped.sd, digits)}, n ${m.arms.task_scoped.n})`,
    );
    out.push(
      `      ${''.padEnd(22)} diff ${interval(m.diff, digits)}   g ${interval(m.effect, 3)}   coverage ${pct(m.coverage)}`,
    );
  }

  const g = e.guardrail;
  out.push(
    `  guardrail — ${g.label}: full ${pct(g.arms.full.rate)} (${g.arms.full.events}/${g.arms.full.n})` +
      `  task_scoped ${pct(g.arms.task_scoped.rate)} (${g.arms.task_scoped.events}/${g.arms.task_scoped.n})` +
      `  risk diff ${interval(g.diff, 3)}  coverage ${pct(g.coverage)}`,
  );
  out.push('      (catastrophe check only — never a primary outcome)');
  if (g.coverageWarning) out.push(`      ${g.coverageWarning}`);

  for (const s of e.secondary) {
    out.push(
      `  secondary (${tag}) — ${s.label}: full ${pct(s.arms.full.rate)} (${s.arms.full.events}/${s.arms.full.n})` +
        `  task_scoped ${pct(s.arms.task_scoped.rate)} (${s.arms.task_scoped.events}/${s.arms.task_scoped.n})` +
        `  risk diff ${interval(s.diff, 3)}  coverage ${pct(s.coverage)}`,
    );
    if (s.coverageWarning) out.push(`      ${s.coverageWarning}`);
    if (s.pooledWarning) out.push(`      ${s.pooledWarning}`);
  }

  out.push(`  covariate balance on ${e.balance.field} — ${e.balance.imbalanced ? 'IMBALANCED' : 'balanced'}:`);
  for (const c of e.balance.categories) {
    out.push(
      `    ${c.category.padEnd(20)} full ${pct(c.arms.full.rate)} (${c.arms.full.events}/${c.arms.full.n})` +
        `  task_scoped ${pct(c.arms.task_scoped.rate)} (${c.arms.task_scoped.events}/${c.arms.task_scoped.n})` +
        `  diff ${interval(c.diff, 3)}`,
    );
  }
  return out;
}

/** Human-readable rendering. Pure: the same readout always yields the same text. */
export function formatReadoutText(r: Readout): string {
  const out: string[] = [];
  out.push('════════════════════════════════════════════════════════════════');
  out.push(`memory-digest readout — policy ${r.policyVersion}, backend ${r.backend}`);
  out.push(`generated ${r.generatedAt}`);
  out.push('════════════════════════════════════════════════════════════════');
  out.push('');
  out.push(`VERDICT: ${r.verdict.status.toUpperCase()}${r.verdict.terminal ? ' (terminal)' : ''}`);
  out.push(`  ${r.verdict.headline}`);
  out.push(`  ${r.verdict.reason}`);
  out.push(
    `  power position: n per arm ${r.verdict.nPerArm} of ${r.verdict.requiredNPerArm} required ` +
      `(${pct(r.verdict.fractionOfRequired)}) for d=${r.design.mde} at ${Math.round(r.design.power * 100)}% power, α=${r.design.alpha}`,
  );
  if (r.verdict.hoursSinceLastObservation !== null) {
    out.push(
      `  last prompt build: ${num(r.verdict.hoursSinceLastObservation, 1)}h ago (stall threshold ${r.design.stallHours}h)`,
    );
  }
  out.push('');
  if (r.boundary) {
    out.push(`contamination boundary: ${r.boundary.at}`);
    out.push(`  derived from: ${r.boundary.derivedFrom}`);
    out.push(`  cohort prompt builds before: ${r.boundary.rowsBefore}, at-or-after: ${r.boundary.rowsAfter}`);
  } else {
    out.push('contamination boundary: NOT DERIVABLE — cohort cannot be split, no comparison reported');
  }
  out.push(`cohort prompt builds: ${r.cohortRows}`);
  out.push(
    `excluded: ${r.excluded.noTaskId} rows without a task id, ${r.excluded.foreignPolicyVersion} tasks on a foreign policy version, ` +
      `${r.excluded.mixedArm} tasks with mixed arms, ${r.excluded.straddling} tasks straddling the boundary, ` +
      `${r.excluded.otherBackend} rows on another backend (or none recorded)`,
  );

  for (const era of ['post', 'pre'] as const) out.push(...renderEra(r.eras[era]));

  out.push('');
  out.push('Intervals are 95% normal-approximation and anti-conservative at small n;');
  out.push('the verdict depends on exposure and accrual, never on an interval.');
  out.push('════════════════════════════════════════════════════════════════');
  return out.join('\n');
}

/** Short body for a push notification. Terminal verdicts only carry one. */
export function formatReadoutSummary(r: Readout): string {
  const post = r.eras.post;
  const lines = [
    r.verdict.headline,
    `post-boundary n: full=${post.n.full} task_scoped=${post.n.task_scoped} (need ${r.verdict.requiredNPerArm}/arm)`,
  ];
  const prompt = post.metrics.find(m => m.key === 'promptBytes');
  if (prompt && prompt.diff.value !== null) {
    lines.push(`prompt bytes diff ${interval(prompt.diff, 0)}`);
  }
  const g = post.guardrail;
  lines.push(`guardrail failure rate: full ${pct(g.arms.full.rate)} vs task_scoped ${pct(g.arms.task_scoped.rate)}`);
  if (post.balance.imbalanced) lines.push('WARNING: covariate imbalance detected — cohort may be broken.');
  lines.push(r.verdict.reason);
  return lines.join('\n');
}
