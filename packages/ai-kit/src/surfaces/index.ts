/**
 * `@builddai/ai-kit/surfaces`: Jev picks which of the app's own chips and cards
 * to show, and in what order (server; builds on `/decide`).
 *
 * - `defineSurface` (0.14.0): several slots (rank chips, a choice card) in one
 *   call, shadow first; a slot is gated only with a gate from `gateFromEval`
 *   over at least `MIN_GATE_EVAL_ROWS` held-out labelled rows. See `./surface`.
 * - `defineRankSurface`: one rank slot with a code fallback (0.3.0).
 *
 * Safety property: the output space is closed. Jev returns only candidate ids
 * the app registered; chip text, card props and URLs come from app code. A
 * low-confidence answer, a timeout, a missing key or shadow mode renders the
 * app's fallback order.
 */

import {
  defineDecision,
  score,
  JEV_MODEL,
  type Decision,
  type DecisionQuestions,
  type DecisionRun,
  type DecisionText,
  type RunOptions,
  type ScoreQuestion,
} from '@builddai/ai-kit/decide';

export * from './surface';
import { checkGate, MIN_GATE_EVAL_ROWS, slotFingerprintOf, type EvaluableSurface, type SlotGate, type SurfaceCandidate } from './surface';

/** The one slot of a rank surface, for `runSurfaceEval` / `gateFromEval`. */
export const RANK_SLOT = 'rank';

// ── Rank surface ──────────────────────────────────────────────────────────────

/** Default score levels: how useful offering the candidate is right now. */
export const DEFAULT_RANK_LEVELS = [
  'Not useful right now: the state gives no reason to offer this',
  'Somewhat useful: a reasonable thing to offer',
  'Clearly useful now: the state shows this needs attention',
] as const;

/** The state Jev sees. Keep it small (counts, flags, the weekday), never content. */
export type RankState = Record<string, unknown>;

export interface RankSurfaceConfig<C extends SurfaceCandidate, S extends RankState = RankState> {
  /** Namespaced decision id, `app.surface_name`. */
  id: string;
  /** Bump when a candidate, a question, the levels, the mode or the threshold changes. */
  promptVersion: string;
  /** The app's catalogue. Order is the last tie-break. */
  candidates: readonly C[];
  /** The `score` instructions for one candidate. */
  question: (candidate: C) => DecisionText;
  /** Score levels, lowest first. Default `DEFAULT_RANK_LEVELS`. */
  levels?: readonly DecisionText[];
  /**
   * The code order for a state, best first. Always computed: it is what shows
   * when Jev is off, unsure or unreachable, and the tie-break when Jev answers.
   * Unknown ids are dropped; candidates it leaves out follow in catalogue order.
   */
  fallback: (state: S) => readonly string[];
  /** How many ids `pick` returns (e.g. 4 chips). Default: all. */
  max?: number;
  /**
   * `shadow` logs Jev's order and shows the fallback; `gated` applies scores
   * at or above the gate's threshold. There is no `live` (0.14.0).
   */
  mode: 'shadow' | 'gated';
  /**
   * Required for `gated`: `gateFromEval` over `runSurfaceEval({ surface, slot: RANK_SLOT })`,
   * at least `MIN_GATE_EVAL_ROWS` held-out rows. A hand-typed `minConfidence`
   * is refused (0.14.0).
   */
  gate?: SlotGate;
  /**
   * Fraction of candidates whose score must be applied for Jev's order to be
   * used at all; below it the fallback stands. Default 0.5.
   */
  minAppliedShare?: number;
  /** Per-call deadline. Default 3s: this runs on a page render. */
  timeoutMs?: number;
  model?: string;
}

export interface RankPick {
  /** The top `max` ids, best first. Always registered candidates. */
  ids: string[];
  /** Every candidate, best first. */
  order: string[];
  /** `jev` when Jev's scores ordered it; `fallback` otherwise. */
  source: 'jev' | 'fallback';
  /** Why the fallback stood, when it did. */
  reason?: 'no_key' | 'call_failed' | 'shadow' | 'low_confidence';
  /** The decision version; stamp it on anything you log. */
  version: string;
  /** Applied scores by id (the ones that counted). */
  scores: Record<string, number>;
}

export interface RankSurface<C extends SurfaceCandidate, S extends RankState = RankState> extends EvaluableSurface {
  readonly id: string;
  readonly candidates: readonly C[];
  /** The `/decide` definition: pin it with `expectDecisionPinned`, eval it with `runDecisionEval`. */
  readonly decision: Decision<Record<string, ScoreQuestion>>;
  readonly version: string;
  /** Combine a run (or none) with the fallback. Pure, for tests and for replaying logged runs. */
  rank(state: S, run: Pick<DecisionRun<Record<string, ScoreQuestion>>, 'ok' | 'outcomes'> | null): RankPick;
  /**
   * One Jev call (all candidates in one request), then `rank`. Never throws.
   * No `apiKey` ⇒ no call, fallback order.
   */
  pick(state: S, opts?: Omit<RunOptions<Record<string, ScoreQuestion>>, 'state'>): Promise<RankPick>;
  /** The registered candidates for ids, in order (unknown ids dropped). */
  resolve(ids: readonly string[]): C[];
}

/**
 * Order an app's own candidates (empty-state chips) with Jev, gated, with a
 * code fallback:
 *
 * ```ts
 * const chips = defineRankSurface({
 *   id: 'money.chat_chips', promptVersion: '2026-09-28.a',
 *   candidates: CHIP_CATALOGUE,
 *   question: c => `Offer "${c.label}" (${c.purpose})? Judge by the counts.`,
 *   fallback: codeOrder, max: 4, mode: 'shadow',   // 'gated' needs gate: gateFromEval(…)
 * });
 * const { ids, source } = await chips.pick(stateCounts, { apiKey, onUsage });
 * ```
 */
export function defineRankSurface<const C extends SurfaceCandidate, S extends RankState = RankState>(
  config: RankSurfaceConfig<C, S>,
): RankSurface<C, S> {
  const ids = config.candidates.map(c => c.id);
  if (ids.length === 0) throw new Error(`surface '${config.id}': needs at least one candidate`);
  if (new Set(ids).size !== ids.length) throw new Error(`surface '${config.id}': candidate ids must be unique`);
  const share = config.minAppliedShare ?? 0.5;
  if (!(share >= 0 && share <= 1)) throw new Error(`surface '${config.id}': minAppliedShare must be in [0, 1]`);
  const levels = config.levels ?? DEFAULT_RANK_LEVELS;
  const questions = Object.fromEntries(config.candidates.map(c => [c.id, score(config.question(c), levels)])) as Record<string, ScoreQuestion>;
  const where = `surface '${config.id}'`;
  if (config.mode !== 'shadow' && config.mode !== 'gated') {
    throw new Error(`${where}: mode must be 'shadow' or 'gated' (got '${String(config.mode)}'); a surface never applies Jev without an eval gate`);
  }
  if ((config as { minConfidence?: unknown }).minConfidence !== undefined) {
    throw new Error(`${where}: a hand-typed minConfidence is not accepted; gate the surface with gateFromEval (at least ${MIN_GATE_EVAL_ROWS} held-out rows)`);
  }
  const model = config.model ?? JEV_MODEL;
  const fingerprint = slotFingerprintOf(config.id, RANK_SLOT, questions, model);
  if (config.mode === 'gated') checkGate(where, RANK_SLOT, fingerprint, config.gate);
  const timeoutMs = config.timeoutMs ?? 3_000;
  const decision = defineDecision({
    id: config.id,
    promptVersion: config.promptVersion,
    questions,
    mode: config.mode,
    ...(config.mode === 'gated' ? { minConfidence: config.gate!.minConfidence } : {}),
    ...(config.model ? { model: config.model } : {}),
    timeoutMs,
  });
  let shadowDecision: Decision<DecisionQuestions> | null = null;
  const slotOnly = (slot: string) => {
    if (slot !== RANK_SLOT) throw new Error(`${where}: a rank surface has one slot, '${RANK_SLOT}' (got '${slot}')`);
  };
  const known = new Set(ids);
  const byId = new Map(config.candidates.map(c => [c.id, c]));
  const max = config.max ?? ids.length;

  const fallbackOrder = (state: S): string[] => {
    let preferred: readonly string[] = [];
    try { preferred = config.fallback(state); } catch { /* a broken fallback still renders the catalogue */ }
    const seen = new Set<string>();
    const out: string[] = [];
    for (const id of [...preferred, ...ids]) {
      if (known.has(id) && !seen.has(id)) { seen.add(id); out.push(id); }
    }
    return out;
  };

  const rank: RankSurface<C, S>['rank'] = (state, run) => {
    const code = fallbackOrder(state);
    const done = (order: string[], source: RankPick['source'], scores: Record<string, number>, reason?: RankPick['reason']): RankPick => ({
      ids: order.slice(0, max), order, source, version: decision.version, scores, ...(reason ? { reason } : {}),
    });
    if (!run) return done(code, 'fallback', {}, 'no_key');
    if (!run.ok) return done(code, 'fallback', {}, 'call_failed');
    const applied = new Map<string, number>();
    for (const id of code) {
      const o = run.outcomes[id];
      if (o?.status === 'applied' && typeof o.value === 'number') applied.set(id, o.value);
    }
    const scores = Object.fromEntries(applied);
    if (applied.size === 0 || applied.size < Math.ceil(code.length * share)) {
      return done(code, 'fallback', scores, config.mode === 'shadow' ? 'shadow' : 'low_confidence');
    }
    const pos = new Map(code.map((id, i) => [id, i]));
    const order = [...code].sort((a, b) => (applied.get(b) ?? -1) - (applied.get(a) ?? -1) || pos.get(a)! - pos.get(b)!);
    return done(order, 'jev', scores);
  };

  return {
    id: config.id,
    candidates: config.candidates,
    decision,
    version: decision.version,
    rank,
    slotFingerprint(slot) { slotOnly(slot); return fingerprint; },
    slotQuestions(slot) { slotOnly(slot); return [...ids]; },
    candidateOf(slot, q) { slotOnly(slot); return known.has(q) ? q : undefined; },
    slotDecision(slot) {
      slotOnly(slot);
      shadowDecision ??= defineDecision({
        id: config.id, promptVersion: config.promptVersion, questions, mode: 'shadow',
        ...(config.model ? { model: config.model } : {}), timeoutMs,
      }) as Decision<DecisionQuestions>;
      return shadowDecision;
    },
    async pick(state, opts = {} as Omit<RunOptions<Record<string, ScoreQuestion>>, 'state'>) {
      if (!opts.apiKey) return rank(state, null);
      let run: DecisionRun<Record<string, ScoreQuestion>> | null = null;
      try {
        run = await decision.run({ ...opts, state: { ...state } });
      } catch {
        run = null;
      }
      return run ? rank(state, run) : { ...rank(state, null), reason: 'call_failed' };
    },
    resolve(list) {
      return list.flatMap(id => (byId.has(id) ? [byId.get(id)!] : []));
    },
  };
}
