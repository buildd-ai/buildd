/**
 * `defineSurface` (0.14.0): Jev picks which of the app's own chips and card to
 * show, over several slots in one call, shadow first and gated per slot after
 * an eval. docs/design/shared-ai-kit.md §1d and P7.
 *
 * - A `rank` slot is one `score` question per candidate; a `choice` slot is
 *   one `choice` question over the app's labels. Question names are
 *   `<slot>__<candidate>` and `<slot>`.
 * - Shadow (every slot's default): the slot renders its `default`, always, and
 *   Jev's would-be pick goes to `onPick` so the app can log it next to what
 *   the person then tapped. Those rows are the eval's labels.
 * - Gated: only with a `SlotGate` from `gateFromEval`, which needs at least
 *   `MIN_GATE_EVAL_ROWS` held-out labelled rows and takes the threshold from
 *   them. The gate is bound to the slot's fingerprint, so changing a question,
 *   a candidate, a level, a label or the model invalidates it.
 *
 * The output space is closed: registered ids and labels only. Chip text, card
 * props and URLs stay in app code.
 */

import {
  canonicalJson,
  choice as choiceQuestion,
  DECIDE_ENGINE_VERSION,
  defineDecision,
  idParity,
  JEV_MODEL,
  KIT_VERSION,
  predictionLabel,
  score,
  shortHash,
  summarizeDecisionEval,
  type AnswerFor,
  type Decision,
  type DecisionMode,
  type DecisionQuestion,
  type DecisionQuestions,
  type DecisionRun,
  type DecisionText,
  type EvalPrediction,
  type EvalSplit,
  type EvalSummary,
  type RunOptions,
} from '@builddai/ai-kit/decide';

export interface SurfaceCandidate {
  id: string;
}

/**
 * Labelled rows a slot's eval needs before it can be gated: held-out rows,
 * not the tuning half. At 700 the 95% interval on a ~90% accuracy is about
 * ±2.2 points, tight enough to tell a threshold that works from one that
 * doesn't. Below it a gate is noise dressed as a number.
 */
export const MIN_GATE_EVAL_ROWS = 700;

/** Default score levels for a rank slot: how useful offering the candidate is right now. */
export const SURFACE_RANK_LEVELS = [
  'Not useful right now: the state gives no reason to offer this',
  'Somewhat useful: a reasonable thing to offer',
  'Clearly useful now: the state shows this needs attention',
] as const;

/** What `gateFromEval` returns. Commit it as a constant next to the surface. */
export interface SlotGate {
  slot: string;
  /** `surface.slotFingerprint(slot)` the eval ran against. */
  fingerprint: string;
  /** From the held-out rows: the lowest observed confidence that met the target. */
  minConfidence: number;
  /** Held-out labelled rows (distinct ids). At least `MIN_GATE_EVAL_ROWS`. */
  evalRows: number;
  /** Held-out accuracy at `minConfidence`. */
  heldOutAccuracy: number;
  /** Share of held-out answers at or above `minConfidence`. */
  coverage: number;
}

type SlotMode = Extract<DecisionMode, 'shadow' | 'gated'>;

export interface RankSlotConfig<C extends SurfaceCandidate = SurfaceCandidate, S = unknown> {
  type: 'rank';
  /** The app's catalogue. */
  candidates: readonly C[];
  /** The `score` instructions for one candidate. (Method syntax, so a slot over your own candidate type fits `SurfaceSlots`.) */
  question(candidate: C): DecisionText;
  /** Score levels, lowest first. Default `SURFACE_RANK_LEVELS`. */
  levels?: readonly DecisionText[];
  /** How many ids the slot shows. */
  max: number;
  /** What shows in shadow, without a key, on a failure or when Jev is unsure. Registered ids; the rest follow in catalogue order. */
  default: readonly string[] | ((state: S) => readonly string[]);
  /** Default `shadow`. `gated` needs `gate`. */
  mode?: SlotMode;
  gate?: SlotGate;
  /** Share of candidates whose score must clear the gate for Jev's order to be used. Default 0.5. */
  minAppliedShare?: number;
}

export interface ChoiceSlotConfig<L extends string = string, S = unknown> {
  type: 'choice';
  question: DecisionText;
  /** Label → definition (null when it needs none), or just the labels. Define them contrastively. */
  labels: Record<L, DecisionText | null> | readonly L[];
  default: L | ((state: S) => L);
  mode?: SlotMode;
  gate?: SlotGate;
}

export type SurfaceSlotConfig<S = unknown> = RankSlotConfig<SurfaceCandidate, S> | ChoiceSlotConfig<string, S>;

/** The state Jev sees. Keep it small (counts, flags, the weekday), never content. */
export type SurfaceState = Record<string, unknown>;

export interface SurfaceConfig<S extends SurfaceState = SurfaceState> {
  /** Namespaced decision id, `app.surface_name`. */
  id: string;
  /** Bump when a slot's questions, candidates, labels, mode or gate change. */
  promptVersion: string;
  slots: Record<string, SurfaceSlotConfig<S>>;
  /** Per-call deadline. Default 3s: this runs on a page render. */
  timeoutMs?: number;
  model?: string;
}

export type SurfaceReason = 'no_key' | 'call_failed' | 'shadow' | 'low_confidence';

export interface RankSlotPick {
  type: 'rank';
  /** What to render: the top `max` ids, registered only. */
  ids: string[];
  order: string[];
  source: 'jev' | 'default';
  reason?: SurfaceReason;
}

export interface ChoiceSlotPick {
  type: 'choice';
  /** What to render: a registered label. */
  label: string;
  source: 'jev' | 'default';
  reason?: SurfaceReason;
}

export type SlotPick = RankSlotPick | ChoiceSlotPick;

/** A slot's pick type from its config: rank ⇒ `RankSlotPick`, choice ⇒ `ChoiceSlotPick`. */
export type SlotPickFor<T> = T extends { type: 'rank' } ? RankSlotPick : T extends { type: 'choice' } ? ChoiceSlotPick : SlotPick;

export type SurfaceSlots<S = unknown> = Record<string, SurfaceSlotConfig<S>>;

export interface SurfacePick<Slots = SurfaceSlots> {
  surfaceId: string;
  version: string;
  slots: { [K in keyof Slots]: SlotPickFor<Slots[K]> };
}

/** One slot's line in a `SurfaceLog`. */
export interface SlotLog {
  mode: SlotMode;
  /** What was shown. */
  rendered: string[] | string;
  /** What Jev would show, ignoring the gate (rank: top `max`). Null when there was no answer. */
  jev: string[] | string | null;
  /** Rank: confidence per candidate. Choice: the picked label's confidence. */
  confidences: Record<string, number>;
  /** `rendered` equals `jev`. */
  agreed: boolean;
  source: 'jev' | 'default';
  reason?: SurfaceReason;
}

/**
 * What `onPick` receives on every call that was attempted. Metadata only:
 * never the state. Log it with the id of what the person then tapped; those
 * rows are what `runSurfaceEval` labels from.
 */
export interface SurfaceLog {
  surfaceId: string;
  version: string;
  kitVersion: string;
  ok: boolean;
  slots: Record<string, SlotLog>;
  costUsd: number | null;
  latencyMs: number;
}

export type SurfacePickOptions = Omit<RunOptions<DecisionQuestions>, 'state'> & {
  /** Called once per attempted call, shadow or gated. Awaited; a throw is swallowed. */
  onPick?: (log: SurfaceLog) => void | Promise<void>;
};

export interface Surface<S extends SurfaceState = SurfaceState, Slots extends SurfaceSlots<S> = SurfaceSlots<S>> {
  readonly id: string;
  readonly version: string;
  /** All slots' questions in one `/decide` definition. Pin it with `expectDecisionPinned`. */
  readonly decision: Decision<DecisionQuestions>;
  readonly slotNames: readonly (keyof Slots & string)[];
  /** Over the slot's questions and the model, not its mode or gate: shadow and gated share it. */
  slotFingerprint(slot: string): string;
  /** The slot's questions alone, in shadow. What `runSurfaceEval` calls. */
  slotDecision(slot: string): Decision<DecisionQuestions>;
  /** The question names of a slot. */
  slotQuestions(slot: string): string[];
  /** Pure: a run (or none) combined with the defaults and gates. For tests and replays. */
  combine(state: S, run: Pick<DecisionRun<DecisionQuestions>, 'ok' | 'outcomes'> | null): { pick: SurfacePick<Slots>; log: SurfaceLog };
  /** One Jev call for every slot, then `combine`. Never throws. No key ⇒ no call, defaults, no log. */
  pick(state: S, opts?: SurfacePickOptions): Promise<SurfacePick<Slots>>;
  /** A rank slot's registered candidates for ids, in order. */
  resolve<K extends keyof Slots & string>(slot: K, ids: readonly string[]): Slots[K] extends RankSlotConfig<infer C, S> ? C[] : never;
}

const SEP = '__';

interface CompiledSlot {
  name: string;
  config: SurfaceSlotConfig<never>;
  questions: Record<string, DecisionQuestion>;
  /** Rank: question name → candidate id. */
  byQuestion: Map<string, string>;
  ids: string[];
  labels: string[];
  mode: SlotMode;
  fingerprint: string;
}

/**
 * Several slots (chips, one optional card) picked in one Jev call:
 *
 * ```ts
 * const EMPTY = defineSurface({
 *   id: 'cue.chat_empty', promptVersion: '2026-09-30.a',
 *   slots: {
 *     chips: { type: 'rank', candidates: CHIPS, question: c => `Offer "${c.label}" now?`, max: 4, default: ['what_needs_me', 'plan_today', 'recap_week', 'start_new'] },
 *     card:  { type: 'choice', question: 'Which card belongs above the chips?', labels: { none: '…', overdue_items: '…' }, default: 'none' },
 *   },
 * });
 * const pick = await EMPTY.pick(counts, { apiKey, onUsage, onPick: log => saveShadowRow(log) });
 * ```
 */
export function defineSurface<S extends SurfaceState = SurfaceState, const Slots extends SurfaceSlots<S> = SurfaceSlots<S>>(
  config: Omit<SurfaceConfig<S>, 'slots'> & { slots: Slots },
): Surface<S, Slots> {
  const where = `surface '${config.id}'`;
  const model = config.model ?? JEV_MODEL;
  const names = Object.keys(config.slots);
  if (names.length === 0) throw new Error(`${where}: needs at least one slot`);

  const compiled: CompiledSlot[] = names.map(name => {
    if (!name || name.includes(SEP)) throw new Error(`${where}: slot name '${name}' must be non-empty with no '${SEP}'`);
    const slot = config.slots[name] as SurfaceSlotConfig<never>;
    const questions: Record<string, DecisionQuestion> = {};
    const byQuestion = new Map<string, string>();
    let ids: string[] = [];
    let labels: string[] = [];
    if (slot.type === 'rank') {
      ids = slot.candidates.map(c => c.id);
      if (ids.length === 0) throw new Error(`${where}: rank slot '${name}' needs at least one candidate`);
      if (new Set(ids).size !== ids.length) throw new Error(`${where}: slot '${name}' candidate ids must be unique`);
      if (!(Number.isInteger(slot.max) && slot.max >= 1)) throw new Error(`${where}: slot '${name}' max must be a positive integer`);
      const share = slot.minAppliedShare ?? 0.5;
      if (!(share >= 0 && share <= 1)) throw new Error(`${where}: slot '${name}' minAppliedShare must be in [0, 1]`);
      if (Array.isArray(slot.default)) {
        const unknown = (slot.default as readonly string[]).filter(id => !ids.includes(id));
        if (unknown.length) throw new Error(`${where}: slot '${name}' default names unregistered ids: ${unknown.join(', ')}`);
      }
      for (const c of slot.candidates) {
        const q = `${name}${SEP}${c.id}`;
        questions[q] = score(slot.question(c), slot.levels ?? SURFACE_RANK_LEVELS);
        byQuestion.set(q, c.id);
      }
    } else {
      const criteria = (Array.isArray(slot.labels)
        ? Object.fromEntries((slot.labels as readonly string[]).map(l => [l, null]))
        : slot.labels) as Record<string, DecisionText | null>;
      labels = Object.keys(criteria);
      if (typeof slot.default === 'string' && !labels.includes(slot.default)) {
        throw new Error(`${where}: slot '${name}' default '${slot.default}' is not one of its labels`);
      }
      questions[name] = choiceQuestion(slot.question, criteria);
    }
    const fingerprint = shortHash(canonicalJson({ surface: config.id, slot: name, questions, model, engine: DECIDE_ENGINE_VERSION }));
    const mode: SlotMode = slot.mode ?? 'shadow';
    if (mode !== 'shadow' && mode !== 'gated') throw new Error(`${where}: slot '${name}' mode must be 'shadow' or 'gated'`);
    if (mode === 'gated') checkGate(where, name, fingerprint, slot.gate);
    return { name, config: slot, questions, byQuestion, ids, labels, mode, fingerprint };
  });

  const allQuestions: Record<string, DecisionQuestion> = {};
  for (const s of compiled) {
    for (const [q, def] of Object.entries(s.questions)) {
      if (q in allQuestions) throw new Error(`${where}: question name '${q}' collides across slots; rename a slot or candidate`);
      allQuestions[q] = def;
    }
  }
  const modes: Record<string, DecisionMode> = {};
  const minConfidence: Record<string, number> = {};
  for (const s of compiled) {
    if (s.mode !== 'gated') continue;
    for (const q of Object.keys(s.questions)) {
      modes[q] = 'gated';
      minConfidence[q] = s.config.gate!.minConfidence;
    }
  }
  const timeoutMs = config.timeoutMs ?? 3_000;
  const decision = defineDecision({
    id: config.id,
    promptVersion: config.promptVersion,
    questions: allQuestions,
    mode: 'shadow',
    modes,
    minConfidence,
    ...(config.model ? { model: config.model } : {}),
    timeoutMs,
  });
  const bySlot = new Map(compiled.map(s => [s.name, s]));
  const slotOf = (name: string): CompiledSlot => {
    const s = bySlot.get(name);
    if (!s) throw new Error(`${where}: no slot '${name}' (one of ${names.join(', ')})`);
    return s;
  };

  const rankDefault = (s: CompiledSlot, state: S): string[] => {
    const cfg = s.config as RankSlotConfig<SurfaceCandidate, S>;
    let preferred: readonly string[] = [];
    try { preferred = typeof cfg.default === 'function' ? cfg.default(state) : cfg.default; } catch { /* the catalogue still renders */ }
    const seen = new Set<string>();
    return [...preferred, ...s.ids].filter(id => s.ids.includes(id) && !seen.has(id) && !!seen.add(id));
  };
  const choiceDefault = (s: CompiledSlot, state: S): string => {
    const cfg = s.config as ChoiceSlotConfig<string, S>;
    let label: string | undefined;
    try { label = typeof cfg.default === 'function' ? cfg.default(state) : cfg.default; } catch { /* fall through */ }
    return label && s.labels.includes(label) ? label : s.labels[0];
  };

  const combine: Surface<S, Slots>['combine'] = (state, run) => {
    const pickSlots: Record<string, SlotPick> = {};
    const logSlots: Record<string, SlotLog> = {};
    const fail: SurfaceReason | null = !run ? 'no_key' : !run.ok ? 'call_failed' : null;
    for (const s of compiled) {
      if (s.config.type === 'rank') {
        const code = rankDefault(s, state);
        const max = (s.config as RankSlotConfig).max;
        const share = (s.config as RankSlotConfig).minAppliedShare ?? 0.5;
        const all = new Map<string, { value: number; confidence: number; applied: boolean }>();
        if (run && !fail) {
          for (const [q, id] of s.byQuestion) {
            const o = run.outcomes[q];
            if (o && o.status !== 'skipped' && typeof o.value === 'number') {
              all.set(id, { value: o.value, confidence: o.confidence, applied: o.status === 'applied' });
            }
          }
        }
        const pos = new Map(code.map((id, i) => [id, i]));
        const byScore = (m: (id: string) => number) => [...code].sort((a, b) => m(b) - m(a) || pos.get(a)! - pos.get(b)!);
        const jevOrder = all.size ? byScore(id => all.get(id)?.value ?? -1) : null;
        const applied = [...all].filter(([, v]) => v.applied);
        let pick: RankSlotPick;
        if (fail) pick = { type: 'rank', ids: code.slice(0, max), order: code, source: 'default', reason: fail };
        else if (s.mode === 'shadow') pick = { type: 'rank', ids: code.slice(0, max), order: code, source: 'default', reason: 'shadow' };
        else if (applied.length === 0 || applied.length < Math.ceil(code.length * share)) {
          pick = { type: 'rank', ids: code.slice(0, max), order: code, source: 'default', reason: 'low_confidence' };
        } else {
          const scores = new Map(applied.map(([id, v]) => [id, v.value]));
          const order = byScore(id => scores.get(id) ?? -1);
          pick = { type: 'rank', ids: order.slice(0, max), order, source: 'jev' };
        }
        pickSlots[s.name] = pick;
        const jev = jevOrder ? jevOrder.slice(0, max) : null;
        logSlots[s.name] = {
          mode: s.mode, rendered: pick.ids, jev,
          confidences: Object.fromEntries([...all].map(([id, v]) => [id, v.confidence])),
          agreed: !!jev && jev.join('\u0000') === pick.ids.join('\u0000'),
          source: pick.source, ...(pick.reason ? { reason: pick.reason } : {}),
        };
      } else {
        const code = choiceDefault(s, state);
        const o = run && !fail ? run.outcomes[s.name] : undefined;
        const answered = o && o.status !== 'skipped' && typeof o.value === 'string' && s.labels.includes(o.value) ? o : null;
        let pick: ChoiceSlotPick;
        if (fail) pick = { type: 'choice', label: code, source: 'default', reason: fail };
        else if (s.mode === 'shadow') pick = { type: 'choice', label: code, source: 'default', reason: 'shadow' };
        else if (answered?.status === 'applied') pick = { type: 'choice', label: answered.value as string, source: 'jev' };
        else pick = { type: 'choice', label: code, source: 'default', reason: 'low_confidence' };
        pickSlots[s.name] = pick;
        const jev = answered ? (answered.value as string) : null;
        logSlots[s.name] = {
          mode: s.mode, rendered: pick.label, jev,
          confidences: answered ? { [answered.value as string]: answered.confidence } : {},
          agreed: jev === pick.label,
          source: pick.source, ...(pick.reason ? { reason: pick.reason } : {}),
        };
      }
    }
    return {
      pick: { surfaceId: config.id, version: decision.version, slots: pickSlots as SurfacePick<Slots>['slots'] },
      log: { surfaceId: config.id, version: decision.version, kitVersion: KIT_VERSION, ok: !fail, slots: logSlots, costUsd: null, latencyMs: 0 },
    };
  };

  const slotDecisions = new Map<string, Decision<DecisionQuestions>>();

  return {
    id: config.id,
    version: decision.version,
    decision,
    slotNames: names as (keyof Slots & string)[],
    slotFingerprint: name => slotOf(name).fingerprint,
    slotQuestions: name => Object.keys(slotOf(name).questions),
    slotDecision(name) {
      const s = slotOf(name);
      let d = slotDecisions.get(name);
      if (!d) {
        d = defineDecision({
          id: config.id, promptVersion: config.promptVersion, questions: s.questions, mode: 'shadow',
          ...(config.model ? { model: config.model } : {}), timeoutMs,
        });
        slotDecisions.set(name, d);
      }
      return d;
    },
    combine,
    async pick(state, opts = { apiKey: null }) {
      const { onPick, ...runOpts } = opts;
      if (!runOpts.apiKey) return combine(state, null).pick;
      let run: DecisionRun<DecisionQuestions> | null = null;
      try {
        run = await decision.run({ ...runOpts, state: { ...state } });
      } catch {
        run = null;
      }
      const out = combine(state, run ?? { ok: false, outcomes: {} });
      if (onPick) {
        const r = run?.result;
        const log: SurfaceLog = {
          ...out.log,
          costUsd: r?.ok ? r.usage.costUsd : null,
          latencyMs: r?.latencyMs ?? 0,
        };
        try { await onPick(log); } catch { /* logging never fails the render */ }
      }
      return out.pick;
    },
    resolve(name, list) {
      const s = slotOf(name);
      if (s.config.type !== 'rank') throw new Error(`${where}: slot '${name}' is not a rank slot`);
      const byId = new Map((s.config as RankSlotConfig).candidates.map(c => [c.id, c]));
      return list.flatMap(id => (byId.has(id) ? [byId.get(id)!] : [])) as never;
    },
  };
}

function checkGate(where: string, name: string, fingerprint: string, gate: SlotGate | undefined): void {
  if (!gate) {
    throw new Error(`${where}: gated slot '${name}' needs a gate from gateFromEval (a held-out eval of at least ${MIN_GATE_EVAL_ROWS} labelled rows)`);
  }
  if (gate.slot !== name) throw new Error(`${where}: the gate on slot '${name}' was evaluated for slot '${gate.slot}'`);
  if (gate.fingerprint !== fingerprint) {
    throw new Error(`${where}: slot '${name}' changed since its eval (fingerprint ${fingerprint}, gate ${gate.fingerprint}); re-run runSurfaceEval and gateFromEval`);
  }
  if (!(Number.isInteger(gate.evalRows) && gate.evalRows >= MIN_GATE_EVAL_ROWS)) {
    throw new Error(`${where}: slot '${name}' gate comes from ${gate.evalRows} labelled rows; gating needs at least ${MIN_GATE_EVAL_ROWS}`);
  }
  if (!(gate.minConfidence > 0 && gate.minConfidence <= 1)) {
    throw new Error(`${where}: slot '${name}' gate threshold must be in (0, 1]`);
  }
}

// ── Eval ──────────────────────────────────────────────────────────────────────

export interface SurfaceEvalPrediction extends EvalPrediction {
  /** The question scored (`<slot>__<candidate>` or `<slot>`). */
  question: string;
}

export interface SurfaceEvalReport {
  surfaceId: string;
  slot: string;
  version: string;
  /** `surface.slotFingerprint(slot)`: what `gateFromEval` binds the gate to. */
  fingerprint: string;
  kitVersion: string;
  split: EvalSplit;
  /** One per (row, question) that had a label. */
  predictions: SurfaceEvalPrediction[];
  /** Pooled over the slot's questions. */
  summary: EvalSummary;
  perQuestion: Record<string, EvalSummary>;
  /** `even-odd` only. Tune on `even`, gate on `odd`. */
  halves?: { even: EvalSummary; odd: EvalSummary };
}

export interface RunSurfaceEvalParams<T, S extends SurfaceState> {
  surface: Surface<S, SurfaceSlots<S>>;
  slot: string;
  rows: readonly T[];
  stateOf: (row: T) => S;
  /**
   * Ground truth. Choice slot: the label. Rank slot: called per candidate,
   * the score level index it deserved; undefined leaves that candidate unlabelled.
   */
  labelOf: (row: T, candidateId?: string) => string | number | undefined;
  idOf: (row: T) => string | number;
  split?: EvalSplit;
  run: Omit<RunOptions<DecisionQuestions>, 'state' | 'onDecision'>;
  concurrency?: number;
  budgetMs?: number;
}

/**
 * Run one slot's questions over labelled rows (one call per row) and score
 * every question. Never throws on a failed call. Use `split: 'even-odd'`:
 * tune wording on the even half, then `gateFromEval` reads the odd half.
 */
export async function runSurfaceEval<T, S extends SurfaceState>(params: RunSurfaceEvalParams<T, S>): Promise<SurfaceEvalReport> {
  const { surface, slot } = params;
  const decision = surface.slotDecision(slot);
  const questions = surface.slotQuestions(slot);
  const isRank = !(questions.length === 1 && questions[0] === slot);
  const split = params.split ?? 'all';
  const scored = params.rows.filter(r => split === 'all' || split === 'even-odd' || idParity(params.idOf(r)) === split);
  const each = await decision.runEach(scored, {
    ...params.run,
    stateOf: r => ({ ...params.stateOf(r) }),
    concurrency: params.concurrency,
    budgetMs: params.budgetMs,
  });

  const predictions: SurfaceEvalPrediction[] = [];
  const candidateOf = (q: string) => (isRank ? q.slice(slot.length + SEP.length) : undefined);
  for (const { item, run, pool } of each.items) {
    const id = params.idOf(item);
    let costCounted = false;
    for (const q of questions) {
      const truth = params.labelOf(item, candidateOf(q));
      if (truth === undefined) continue;
      const base = { id, question: q, truth: String(truth) };
      if (!run) { predictions.push({ ...base, pred: null, confidence: null, costUsd: 0, latencyMs: 0, error: pool }); continue; }
      const r = run.result;
      if (!r.ok) { predictions.push({ ...base, pred: null, confidence: null, costUsd: 0, latencyMs: r.latencyMs, error: r.error.kind }); continue; }
      const { pred, confidence } = predictionLabel(decision.questions[q] as DecisionQuestion, r.answers[q] as AnswerFor<DecisionQuestion>);
      // One call per row: its cost lands on the row's first labelled question.
      const costUsd = costCounted ? 0 : (r.usage.costUsd ?? 0);
      costCounted = true;
      predictions.push({ ...base, pred, confidence, costUsd, latencyMs: r.latencyMs });
    }
  }

  const report: SurfaceEvalReport = {
    surfaceId: surface.id,
    slot,
    version: surface.version,
    fingerprint: surface.slotFingerprint(slot),
    kitVersion: KIT_VERSION,
    split,
    predictions,
    summary: summarizeDecisionEval(predictions),
    perQuestion: Object.fromEntries(questions.map(q => [q, summarizeDecisionEval(predictions.filter(p => p.question === q))])),
  };
  if (split === 'even-odd') {
    report.halves = {
      even: summarizeDecisionEval(predictions.filter(p => idParity(p.id) === 'even')),
      odd: summarizeDecisionEval(predictions.filter(p => idParity(p.id) === 'odd')),
    };
  }
  return report;
}

export interface GateFromEvalOptions {
  /** Held-out accuracy the applied answers must reach, e.g. 0.95. Scale it with the cost of a wrong pick. */
  targetAccuracy: number;
  /** Least share of held-out answers the gate must still apply. Default 0 (any). */
  minCoverage?: number;
  /** Which half to read. Default `odd` for an `even-odd` report, else every row. */
  heldOut?: 'even' | 'odd' | 'all';
}

/**
 * A slot's gate from its eval: the lowest confidence observed on the held-out
 * rows at which the answers at or above it reach `targetAccuracy` (and
 * `minCoverage`). Throws with fewer than `MIN_GATE_EVAL_ROWS` held-out labelled
 * rows, or when no threshold meets the target: then the slot stays in shadow.
 * The threshold is a confidence the model actually produced, never a round
 * number someone typed.
 */
export function gateFromEval(report: SurfaceEvalReport, opts: GateFromEvalOptions): SlotGate {
  const heldOut = opts.heldOut ?? (report.split === 'even-odd' ? 'odd' : 'all');
  const rows = report.predictions.filter(p => !p.error && p.pred !== null && p.confidence !== null)
    .filter(p => heldOut === 'all' || idParity(p.id) === heldOut);
  const evalRows = new Set(rows.map(p => String(p.id))).size;
  if (evalRows < MIN_GATE_EVAL_ROWS) {
    throw new Error(
      `gateFromEval '${report.surfaceId}' slot '${report.slot}': ${evalRows} held-out labelled rows (${heldOut}); ` +
      `gating needs at least ${MIN_GATE_EVAL_ROWS}. Keep the slot in shadow and collect more.`,
    );
  }
  if (!(opts.targetAccuracy > 0 && opts.targetAccuracy <= 1)) throw new Error('gateFromEval: targetAccuracy must be in (0, 1]');
  const minCoverage = opts.minCoverage ?? 0;
  const byConfidence = [...rows].sort((a, b) => b.confidence! - a.confidence!);
  let best: { t: number; acc: number; cov: number } | null = null;
  let correct = 0;
  for (let i = 0; i < byConfidence.length; i++) {
    if (byConfidence[i].pred === byConfidence[i].truth) correct++;
    const t = byConfidence[i].confidence!;
    // Only at the last row of a run of equal confidences: a threshold takes all of them.
    if (i + 1 < byConfidence.length && byConfidence[i + 1].confidence === t) continue;
    const n = i + 1;
    const acc = correct / n;
    const cov = n / byConfidence.length;
    if (acc >= opts.targetAccuracy && cov >= minCoverage) best = { t, acc, cov };
  }
  if (!best) {
    throw new Error(
      `gateFromEval '${report.surfaceId}' slot '${report.slot}': no threshold reaches the target ` +
      `${opts.targetAccuracy} accuracy at ${minCoverage} coverage on ${evalRows} held-out rows. Keep the slot in shadow.`,
    );
  }
  return {
    slot: report.slot,
    fingerprint: report.fingerprint,
    minConfidence: best.t,
    evalRows,
    heldOutAccuracy: best.acc,
    coverage: best.cov,
  };
}

