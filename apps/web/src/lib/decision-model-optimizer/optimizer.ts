/**
 * buildd picks the model for each decision (docs/specs/decision-model-selection.md,
 * "Choosing and changing the model"). Champion/challenger without live parallel
 * calls: the challengers are asked offline, on the team's own replayed
 * decisions (`runModelComparison`), so the live path keeps one call.
 *
 * Per opted-in team, per decision kind, on the same collected cases:
 *
 *   1. Every candidate (Jev, Clef, Clef Flash, and whatever each kind uses now)
 *      answers the kind's replayed decisions that have outcome gold. A hard call
 *      cap bounds the run (Workers AI is unpriced, so the cost cap cannot).
 *   2. Each model's score is the share of cases it would act on and get right
 *      at its own derived threshold (coverage x precision). A model has a score
 *      only where its threshold's Wilson lower bound clears max(rule accuracy,
 *      kind target) over the kind's minimum of graded cases (`scoreModel`).
 *   3. The best model replaces the current one only when it wins by at least
 *      `OPTIMIZER_MARGIN` and its test decision passes (`probeDecisionModel`).
 *      Ties keep the current model. A kind with too few graded cases, a model
 *      not asked every case, and a kind pinned by an Undo are left alone.
 *   4. A switch stores the winner's measurement (never loosening a stricter one
 *      already stored for the same signal; measurements are shared by every
 *      team, so a retired row or one in force on another signal is left alone
 *      and the kind is not switched), sets `decision_model.byKind` for
 *      that kind only (never the team default), writes one switch row and one
 *      decision-ledger event with the eval run id and both scores.
 *   5. Auto-revert: once the switched-to model has `REVERT_MIN_GRADED` live
 *      graded decisions on that kind and its acted precision is below the bar
 *      it was switched at, the previous model is restored.
 *
 * What the team sees is one line per switch in effect ("Start or wait now uses
 * Clef", "... is back on Jev") with Undo, which restores the previous config
 * and pins it for `OPTIMIZER_PIN_MS`. Scores, thresholds and runs stay in
 * `prompt_eval_results`, `decision_model_measurements` and the switch rows,
 * for the operator.
 *
 * Pure apart from `OptimizerDeps` (./store.ts wires the database).
 */
import { DEFAULT_DECISION_MODEL } from '@buildd/core/decision-client';
import {
  DECISION_MODEL_KINDS,
  decisionModelKindLabel,
  isDecisionModelKind,
  readDecisionModel,
  readDecisionModelOverrides,
  type DecisionModelConfig,
  type DecisionModelKind,
  type DecisionModelRoute,
} from '@buildd/core/decision-model';
import {
  CONFIDENCE_SOURCES,
  canonicalMeasuredModel,
  isCalibration,
  type Calibration,
  type ConfidenceSource,
  type StoredMeasurement,
} from '@buildd/core/decision-model-measurements';
import type { DecisionLedgerInput } from '@buildd/core/decision-ledger';
import type { ModelComparisonInput, ModelComparisonOutcome } from '../prompt-evals/compare-run';
import type { ComparisonAbort } from '../prompt-evals/compare';
import type { PromptEvalResultRow } from '../prompt-evals/run';

/** A challenger must beat the current model's score by this much (5 points of coverage x precision). */
export const OPTIMIZER_MARGIN = 0.05;
/** How long an Undo holds the restored model. */
export const OPTIMIZER_PIN_MS = 30 * 86_400_000;
/** Live graded decisions needed before acted precision can revert a switch. */
export const REVERT_MIN_GRADED = 20;
/** Calls per team run, every model together. */
export const OPTIMIZER_CALL_CAP = 1500;
/** Collected cases: how far back. */
export const OPTIMIZER_SINCE_DAYS = 30;
/** Precision bar when a switch row carries none. */
const DEFAULT_BAR = 0.9;

export const JEV_ROUTE: DecisionModelRoute = { endpoint: 'systemone', model: DEFAULT_DECISION_MODEL, via: 'openrouter' };
/** The default challengers: Jev on OpenRouter, Clef and Clef Flash on the team's Cloudflare credential. */
export const OPTIMIZER_CANDIDATES: readonly DecisionModelRoute[] = [
  JEV_ROUTE,
  { endpoint: 'systemone', model: 'clef', via: 'cloudflare' },
  { endpoint: 'systemone', model: 'clef-flash', via: 'cloudflare' },
];

/** The ledger capability a switch is recorded under. */
export const SWITCH_LEDGER_CAPABILITY = 'decision_model_switch';

// ── The decision, pure ───────────────────────────────────────────────────────

export interface DerivedAt {
  /** The signal the threshold is compared with, as the comparison read it. */
  source: ConfidenceSource;
  threshold: number;
  coverage: number;
  precision: number;
  wilsonLower: number;
  /** The isotonic breakpoints a `calibrated_top_p` threshold is read through; null for any other signal. */
  calibration: Calibration | null;
}

/**
 * A stored comparison's `derived`, or null when it cannot be acted on: an
 * unknown signal, or `calibrated_top_p` without breakpoints a measurement can
 * store. Such a result has no score, so it never wins.
 */
export function readDerived(v: unknown): DerivedAt | null {
  if (!v || typeof v !== 'object') return null;
  const d = v as Record<string, unknown>;
  if (!(CONFIDENCE_SOURCES as readonly unknown[]).includes(d.source)) return null;
  const nums = [d.threshold, d.coverage, d.precision, d.wilsonLower];
  if (!nums.every(n => typeof n === 'number' && Number.isFinite(n))) return null;
  const source = d.source as ConfidenceSource;
  if (source === 'calibrated_top_p' && !isCalibration(d.calibration)) return null;
  return {
    source,
    threshold: d.threshold as number,
    coverage: d.coverage as number,
    precision: d.precision as number,
    wilsonLower: d.wilsonLower as number,
    calibration: source === 'calibrated_top_p' ? { x: [...(d.calibration as Calibration).x], y: [...(d.calibration as Calibration).y] } : null,
  };
}

/** One model's result on one kind's collected cases. */
export interface ModelResult {
  route: DecisionModelRoute;
  /** Asked at all (a key resolved). */
  scored: boolean;
  /** Cases not asked of it (cap, deadline). */
  notRun: number;
  /** Cases with outcome gold. */
  labelled: number;
  /** Its derived threshold, when one clears the bar. */
  derived: DerivedAt | null;
  /** The precision bar its threshold was derived against. */
  bar: number | null;
}

export type KeepReason =
  | 'pinned' | 'too_few_graded' | 'current_not_asked' | 'no_model_clears_bar' | 'current_best' | 'within_margin'
  | 'preflight_failed' | 'no_fingerprint' | 'write_failed'
  // The shared (kind x model) measurement row is retired, or in force on another signal: not one team's to change.
  | 'measurement_retired' | 'measurement_other_signal';

export type KindPlan =
  | { action: 'switch'; kind: string; from: ModelResult; to: ModelResult; before: number; after: number }
  | { action: 'keep'; kind: string; reason: KeepReason };

/** Share of cases the model would act on and get right: coverage x precision at its threshold. 0 without one. */
export function scoreOf(r: ModelResult): number {
  return r.derived ? r.derived.coverage * r.derived.precision : 0;
}

export const routeKey = (r: DecisionModelRoute) => `${r.via}:${canonicalMeasuredModel(r.model)}`;
const sameRoute = (a: DecisionModelRoute | null | undefined, b: DecisionModelRoute | null | undefined) =>
  !a || !b ? !a && !b : routeKey(a) === routeKey(b) && a.endpoint === b.endpoint;

const EPS = 1e-9;

export function planKindSwitch(input: {
  kind: string;
  current: DecisionModelRoute;
  results: readonly ModelResult[];
  minLabelled: number;
  pinned: boolean;
  margin?: number;
}): KindPlan {
  const keep = (reason: KeepReason): KindPlan => ({ action: 'keep', kind: input.kind, reason });
  if (input.pinned) return keep('pinned');
  const current = input.results.find(r => routeKey(r.route) === routeKey(input.current));
  if (!current || !current.scored || current.notRun > 0) return keep('current_not_asked');
  if (current.labelled < input.minLabelled) return keep('too_few_graded');

  // Only models asked every case: the same cases as the current one.
  const comparable = input.results.filter(r => r.scored && r.notRun === 0 && r.labelled === current.labelled && r.derived);
  if (comparable.length === 0) return keep('no_model_clears_bar');
  const best = comparable.reduce((a, b) => (scoreOf(b) > scoreOf(a) + EPS ? b : a));
  const before = scoreOf(current);
  const after = scoreOf(best);
  if (routeKey(best.route) === routeKey(current.route) || after <= before + EPS) return keep('current_best');
  if (after - before < (input.margin ?? OPTIMIZER_MARGIN) - EPS) return keep('within_margin');
  return { action: 'switch', kind: input.kind, from: current, to: best, before, after };
}

/** A comparison's stored rows for one kind's collected cases, read back as model results. */
export function resultsFromRows(rows: readonly PromptEvalResultRow[], kind: string, routes: readonly DecisionModelRoute[]): { results: ModelResult[]; minLabelled: number | null } {
  let minLabelled: number | null = null;
  const results: ModelResult[] = [];
  for (const r of rows) {
    if (r.benchmarkSet !== kind || r.caseSource !== 'collected' || r.status !== 'scored' || !r.model) continue;
    const m = (r.metrics ?? {}) as Record<string, unknown>;
    const via = typeof m.via === 'string' ? m.via : '';
    const route = routes.find(x => x.via === via && canonicalMeasuredModel(x.model) === canonicalMeasuredModel(r.model!));
    if (!route) continue;
    const target = m.target as { minLabelled?: unknown } | undefined;
    if (typeof target?.minLabelled === 'number') minLabelled = target.minLabelled;
    const derived = readDerived(m.derived);
    const thresholds = (m.thresholds ?? {}) as Record<string, { bar?: unknown } | undefined>;
    const bar = derived ? thresholds[derived.source]?.bar : undefined;
    results.push({
      route,
      scored: m.status !== 'no_key',
      notRun: r.notRun,
      labelled: typeof m.labelled === 'number' ? m.labelled : 0,
      derived,
      bar: typeof bar === 'number' ? bar : null,
    });
  }
  return { results, minLabelled };
}

// ── Dependencies ─────────────────────────────────────────────────────────────

export type SwitchStatus = 'active' | 'undone' | 'reverted' | 'superseded';

export interface SwitchRow {
  id: string;
  teamId: string;
  kind: string;
  cause: 'optimizer' | 'auto_revert';
  fromRoute: DecisionModelRoute | null;
  toRoute: DecisionModelRoute | null;
  evalRunId: string | null;
  beforeScore: number | null;
  afterScore: number | null;
  bar: number | null;
  n: number | null;
  status: SwitchStatus;
  pinnedUntil: Date | null;
  endedAt: Date | null;
  endedBy: string | null;
  createdAt: Date;
}

export type NewSwitchRow = Pick<SwitchRow, 'teamId' | 'kind' | 'cause' | 'fromRoute' | 'toRoute' | 'evalRunId' | 'beforeScore' | 'afterScore' | 'bar' | 'n'>;

export interface SwitchStore {
  /** Kinds of this team an Undo pins at `at`. */
  pinnedKinds: (teamId: string, at: Date) => Promise<Set<string>>;
  insert: (row: NewSwitchRow) => Promise<string>;
  /** Mark this team's active switches for the kind superseded. */
  supersede: (teamId: string, kind: string, at: Date) => Promise<void>;
  /** Active switches, of one team or every team. */
  listActive: (teamId?: string) => Promise<SwitchRow[]>;
  get: (id: string) => Promise<SwitchRow | null>;
  /** End an active switch; false when it was no longer active. */
  end: (id: string, status: Exclude<SwitchStatus, 'active'>, patch: { endedAt: Date; endedBy?: string | null; pinnedUntil?: Date | null }) => Promise<boolean>;
}

export interface OptimizerDeps {
  optedIn: (teamId: string) => Promise<boolean>;
  /** The team's stored `decision_model`. */
  readDecisionModel: (teamId: string) => Promise<unknown>;
  compare: (input: ModelComparisonInput) => Promise<ModelComparisonOutcome>;
  /** One test decision through the route, as Save does. */
  preflight: (route: DecisionModelRoute, teamId: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  /** The fingerprint a kind's call site reports, so a stored measurement applies. Null: unknown kind. */
  fingerprintFor: (kind: string) => Promise<string | null>;
  measurements: () => Promise<readonly StoredMeasurement[]>;
  writeMeasurement: (row: Omit<StoredMeasurement, 'setAt'>) => Promise<void>;
  /** `setDecisionModelForKind`: only `byKind`, never the default. */
  setKindModel: (teamId: string, kind: DecisionModelKind, route: DecisionModelRoute | null, reason: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  switches: SwitchStore;
  /** Live decisions of this kind the model's answer applied to since `since`, graded by outcome. */
  liveGrades: (q: { teamId: string; kind: string; model: string; since: Date }) => Promise<{ graded: number; correct: number }>;
  recordLedger: (input: DecisionLedgerInput) => Promise<void>;
  now?: () => number;
}

// ── One team ─────────────────────────────────────────────────────────────────

export interface KindOutcome {
  kind: string;
  action: 'switch' | 'keep';
  reason?: KeepReason;
  /** On a switch: from and to, as model ids. Operator data. */
  from?: string;
  to?: string;
  before?: number;
  after?: number;
}

export type TeamOptimizeResult =
  | { teamId: string; status: 'not_opted_in' }
  | { teamId: string; status: 'skipped'; reason: string }
  | { teamId: string; status: 'ran'; runId: string; problems: string[]; aborted: ComparisonAbort | null; kinds: KindOutcome[] };

export interface OptimizeOptions {
  callCap?: number;
  deadlineAt?: number;
  trigger?: 'manual' | 'cron';
}

const fmt = (n: number) => String(Math.round(n * 1000) / 1000);

/**
 * What to do with the winner's measurement. Measurements are platform-wide
 * (one row per kind x model, read by every team), so one team's run never
 * revives a retired row (an operator's "this model records only") and never
 * replaces a row in force on another signal: the kind is not switched.
 * A row in force on the same signal that is at least as strict is kept; any
 * other case writes the winner's measurement.
 */
export function measurementPlan(rows: readonly StoredMeasurement[], kind: string, model: string, fingerprint: string, derived: DerivedAt):
  'write' | 'keep' | 'measurement_retired' | 'measurement_other_signal' {
  const same = rows.filter(r => r.kind === kind && canonicalMeasuredModel(r.model) === canonicalMeasuredModel(model));
  if (same.some(r => r.status === 'retired')) return 'measurement_retired';
  const existing = same.find(r => r.status === 'active' && r.measuredFingerprint === fingerprint);
  if (!existing) return 'write';
  if (existing.labelThresholds) return 'keep';
  if ((existing.confidenceSource ?? 'confidence') !== derived.source) return 'measurement_other_signal';
  return existing.threshold >= derived.threshold ? 'keep' : 'write';
}

export async function optimizeTeam(teamId: string, opts: OptimizeOptions, deps: OptimizerDeps): Promise<TeamOptimizeResult> {
  // Replaying sends the team's decision inputs to the candidates' providers: never without the team's opt-in.
  if (!(await deps.optedIn(teamId))) return { teamId, status: 'not_opted_in' };
  const now = deps.now ?? Date.now;

  const stored = await deps.readDecisionModel(teamId);
  const teamDefault: DecisionModelRoute = readDecisionModel(stored) ?? JEV_ROUTE;
  const overrides = readDecisionModelOverrides(stored);
  const routes: DecisionModelRoute[] = [];
  for (const r of [...OPTIMIZER_CANDIDATES, teamDefault, ...Object.values(overrides)]) {
    if (r && !routes.some(x => sameRoute(x, r))) routes.push({ endpoint: r.endpoint, model: r.model, via: r.via });
  }

  const out = await deps.compare({
    teamId,
    models: routes as DecisionModelConfig[],
    source: 'collected',
    kinds: [...DECISION_MODEL_KINDS],
    sinceDays: OPTIMIZER_SINCE_DAYS,
    callCap: opts.callCap ?? OPTIMIZER_CALL_CAP,
    trigger: opts.trigger ?? 'manual',
    ...(opts.deadlineAt !== undefined ? { deadlineAt: opts.deadlineAt } : {}),
  });
  if (out.status === 'skipped') return { teamId, status: 'skipped', reason: out.reason };

  const at = new Date(now());
  const pinned = await deps.switches.pinnedKinds(teamId, at);
  const kinds: KindOutcome[] = [];
  const kindIds = [...new Set(out.rows.filter(r => r.caseSource === 'collected').map(r => r.benchmarkSet))].filter(isDecisionModelKind);
  for (const kind of kindIds) {
    const current = overrides[kind] ?? teamDefault;
    const { results, minLabelled } = resultsFromRows(out.rows, kind, routes);
    const plan = planKindSwitch({ kind, current, results, minLabelled: minLabelled ?? Infinity, pinned: pinned.has(kind) });
    if (plan.action === 'keep') { kinds.push({ kind, action: 'keep', reason: plan.reason }); continue; }
    const kept = (reason: KeepReason) => kinds.push({ kind, action: 'keep', reason, from: plan.from.route.model, to: plan.to.route.model, before: plan.before, after: plan.after });

    const probe = await deps.preflight(plan.to.route, teamId);
    if (!probe.ok) { kept('preflight_failed'); continue; }
    const fingerprint = await deps.fingerprintFor(kind);
    if (!fingerprint) { kept('no_fingerprint'); continue; }
    const derived = plan.to.derived!;
    const measured = measurementPlan(await deps.measurements(), kind, plan.to.route.model, fingerprint, derived);
    if (measured === 'measurement_retired' || measured === 'measurement_other_signal') { kept(measured); continue; }
    if (measured === 'write') {
      await deps.writeMeasurement({
        kind,
        model: canonicalMeasuredModel(plan.to.route.model),
        threshold: derived.threshold,
        precisionLower: derived.wilsonLower,
        coverage: derived.coverage,
        n: plan.to.labelled,
        evalRunId: out.runId,
        measuredFingerprint: fingerprint,
        status: 'active',
        setByAccountId: null,
        reason: 'decision model optimizer: won the comparison on collected cases',
        confidenceSource: derived.source,
        calibration: derived.calibration,
        labelThresholds: null,
      });
    }
    const set = await deps.setKindModel(teamId, kind, plan.to.route, `optimizer: eval run ${out.runId}`);
    if (!set.ok) { kept('write_failed'); continue; }

    await deps.switches.supersede(teamId, kind, at);
    await deps.switches.insert({
      teamId, kind, cause: 'optimizer',
      fromRoute: overrides[kind] ?? null, toRoute: plan.to.route,
      evalRunId: out.runId, beforeScore: plan.before, afterScore: plan.after,
      bar: plan.to.bar ?? DEFAULT_BAR, n: plan.to.labelled,
    });
    await deps.recordLedger(switchLedgerEvent(teamId, kind, plan.from.route.model, plan.to.route.model,
      `optimizer: eval_run=${out.runId} before=${fmt(plan.before)} after=${fmt(plan.after)} n=${plan.to.labelled}`, out.runId, plan.after));
    kinds.push({ kind, action: 'switch', from: plan.from.route.model, to: plan.to.route.model, before: plan.before, after: plan.after });
  }
  return { teamId, status: 'ran', runId: out.runId, problems: out.problems, aborted: out.aborted, kinds };
}

function switchLedgerEvent(teamId: string, kind: string, from: string | null, to: string | null, reason: string, fingerprint: string, confidence: number | null): DecisionLedgerInput {
  return {
    teamId,
    capability: SWITCH_LEDGER_CAPABILITY,
    fingerprint,
    model: to,
    ruleAnswer: from,
    verdict: to,
    appliedAnswer: to,
    confidence,
    applied: true,
    status: 'applied',
    reason,
    // No model was asked: decision health does not count it as a call.
    attemptCount: 0,
    subjectType: 'decision_kind',
    subjectId: kind,
  };
}

// ── Auto-revert ──────────────────────────────────────────────────────────────

/** The model a stored `fromRoute` stands for: the override, else the team default, else Jev. */
function effectiveModel(route: DecisionModelRoute | null, stored: unknown): string {
  return (route ?? readDecisionModel(stored) ?? JEV_ROUTE).model;
}

export async function checkAutoReverts(deps: OptimizerDeps): Promise<{ checked: number; reverted: number; superseded: number }> {
  const now = deps.now ?? Date.now;
  const at = new Date(now());
  let checked = 0, reverted = 0, superseded = 0;
  for (const sw of await deps.switches.listActive()) {
    if (sw.cause !== 'optimizer' || !sw.toRoute || !isDecisionModelKind(sw.kind)) continue;
    if ((await deps.switches.pinnedKinds(sw.teamId, at)).has(sw.kind)) continue;
    checked++;
    const grades = await deps.liveGrades({ teamId: sw.teamId, kind: sw.kind, model: sw.toRoute.model, since: sw.createdAt });
    const bar = sw.bar ?? DEFAULT_BAR;
    if (grades.graded < REVERT_MIN_GRADED || grades.correct / grades.graded >= bar) continue;

    const stored = await deps.readDecisionModel(sw.teamId);
    if (!sameRoute(readDecisionModelOverrides(stored)[sw.kind], sw.toRoute)) {
      // Someone changed it since: not ours to put back.
      if (await deps.switches.end(sw.id, 'superseded', { endedAt: at })) superseded++;
      continue;
    }
    const precision = grades.correct / grades.graded;
    const set = await deps.setKindModel(sw.teamId, sw.kind, sw.fromRoute, `auto-revert: live precision ${fmt(precision)} below ${fmt(bar)}`);
    if (!set.ok) continue;
    await deps.switches.end(sw.id, 'reverted', { endedAt: at });
    await deps.switches.insert({
      teamId: sw.teamId, kind: sw.kind, cause: 'auto_revert',
      fromRoute: sw.toRoute, toRoute: sw.fromRoute,
      evalRunId: sw.evalRunId, beforeScore: bar, afterScore: precision, bar, n: grades.graded,
    });
    await deps.recordLedger(switchLedgerEvent(sw.teamId, sw.kind, sw.toRoute.model, effectiveModel(sw.fromRoute, stored),
      `auto_revert: live_precision=${fmt(precision)} bar=${fmt(bar)} graded=${grades.graded} switch=${sw.id}`, sw.id, precision));
    reverted++;
  }
  return { checked, reverted, superseded };
}

// ── Undo ─────────────────────────────────────────────────────────────────────

export type UndoResult = { ok: true } | { ok: false; status: 404 | 409 | 500; error: string };

/** Restore what the switch replaced and pin it. Only the switch in effect, of this team, still as it left it. */
export async function undoSwitch(input: { teamId: string; switchId: string; by: string | null }, deps: OptimizerDeps): Promise<UndoResult> {
  const now = deps.now ?? Date.now;
  const sw = await deps.switches.get(input.switchId);
  if (!sw || sw.teamId !== input.teamId || !isDecisionModelKind(sw.kind)) return { ok: false, status: 404, error: 'switch not found' };
  if (sw.status !== 'active') return { ok: false, status: 409, error: 'This change was already undone or replaced.' };
  const stored = await deps.readDecisionModel(input.teamId);
  if (!sameRoute(readDecisionModelOverrides(stored)[sw.kind] ?? null, sw.toRoute)) {
    return { ok: false, status: 409, error: `${decisionModelKindLabel(sw.kind)} was changed since. Nothing was undone.` };
  }
  const set = await deps.setKindModel(input.teamId, sw.kind, sw.fromRoute, 'undo of an automatic switch');
  if (!set.ok) return { ok: false, status: 500, error: set.error };
  const at = new Date(now());
  await deps.switches.end(sw.id, 'undone', { endedAt: at, endedBy: input.by, pinnedUntil: new Date(at.getTime() + OPTIMIZER_PIN_MS) });
  await deps.recordLedger(switchLedgerEvent(input.teamId, sw.kind, effectiveModel(sw.toRoute, stored), effectiveModel(sw.fromRoute, stored),
    `undo: switch=${sw.id}`, sw.id, null));
  return { ok: true };
}

// ── What the team sees ───────────────────────────────────────────────────────

/** How long a switch line stays in the team's view. */
export const SWITCH_FEED_MS = 30 * 86_400_000;

export function modelDisplayName(model: string): string {
  const m = canonicalMeasuredModel(model);
  if (m === 'clef') return 'Clef';
  if (m === 'clef-flash') return 'Clef Flash';
  if (m.startsWith('typesafe/jev-')) return 'Jev';
  return m;
}

export interface SwitchLine { id: string; kind: string; text: string; at: string }

/** One line per switch in effect, newest first: "Start or wait now uses Clef", "... is back on Jev". No numbers. */
export async function switchFeed(teamId: string, deps: Pick<OptimizerDeps, 'switches' | 'readDecisionModel' | 'now'>): Promise<SwitchLine[]> {
  const since = (deps.now ?? Date.now)() - SWITCH_FEED_MS;
  const rows = (await deps.switches.listActive(teamId)).filter(s => s.createdAt.getTime() >= since && isDecisionModelKind(s.kind));
  if (rows.length === 0) return [];
  const stored = await deps.readDecisionModel(teamId);
  return rows
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .map(s => {
      const label = decisionModelKindLabel(s.kind as DecisionModelKind);
      const name = modelDisplayName(effectiveModel(s.toRoute, stored));
      return { id: s.id, kind: s.kind, text: s.cause === 'auto_revert' ? `${label} is back on ${name}` : `${label} now uses ${name}`, at: s.createdAt.toISOString() };
    });
}

// ── The scheduled sweep ──────────────────────────────────────────────────────

/** A team run needs at least this long left in the invocation to start. */
export const SWEEP_MIN_TEAM_MS = 60_000;
/** Each team at most once in this long. */
export const OPTIMIZER_CADENCE_MS = 7 * 86_400_000;

export interface SweepResult {
  reverts: Awaited<ReturnType<typeof checkAutoReverts>>;
  teams: TeamOptimizeResult[];
  /** Due teams the invocation had no time left for; the next one reaches them. */
  deferred: string[];
}

/**
 * Auto-revert checks first (no model call), then each due team in turn while
 * `budgetMs` allows. Every team run stops starting calls at the budget's end.
 */
export async function runOptimizerSweep(
  opts: { teamIds: readonly string[]; budgetMs: number; trigger: 'cron' | 'manual'; callCap?: number },
  deps: OptimizerDeps,
): Promise<SweepResult> {
  const now = deps.now ?? Date.now;
  const end = now() + opts.budgetMs;
  const reverts = await checkAutoReverts(deps);
  const teams: TeamOptimizeResult[] = [];
  const deferred: string[] = [];
  for (const teamId of opts.teamIds) {
    if (end - now() < SWEEP_MIN_TEAM_MS) { deferred.push(teamId); continue; }
    try {
      teams.push(await optimizeTeam(teamId, { trigger: opts.trigger, deadlineAt: end, ...(opts.callCap !== undefined ? { callCap: opts.callCap } : {}) }, deps));
    } catch (err) {
      teams.push({ teamId, status: 'skipped', reason: `failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  }
  return { reverts, teams, deferred };
}
