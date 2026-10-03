/**
 * Explore mode: buildd moves a pool's traffic once a day
 * (knowledge-base: buildd/design/tier-weights.md §3, §4c, §5).
 *
 * Pure: every input is an argument, including the date that seeds the
 * Thompson draws, so a step replays exactly from its stored evidence. The
 * stores half (`./tier-explore-source.ts`) loads evidence and writes the
 * result through `writeAllocation`.
 *
 * Order of a step (§3c, §4c):
 *
 *   1. Posterior per live arm: Beta(1 + Σw·q + popularity, 1 + Σw·(1−q) + popularity).
 *   2. Target = P(arm is best) from 10,000 seeded Thompson draws per arm.
 *   3. Caps: the arm's stage range, then succession and expiry (only lower),
 *      then the incumbent floor.
 *   4. Harm cut overrides a challenger to 0.
 *   5. Project the target onto the caps, then limit each move to the stage's
 *      max step.
 *   6. Quantize to 0.05. Learning arms keep exactly 0.10.
 *   7. Write only if the result differs from the current allocation, and not
 *      when popularity is the only reason it differs.
 *
 * Signals are attributed counterfactually: each one present is removed in
 * turn and the step recomputed; a signal whose removal changes the result is a
 * cause.
 */
import { hashUnitInterval } from './experiment-randomizer';
import { MIN_GRADED_UNITS, QUALITY_BY_SEVERITY, type Allocation, type PoolSurface, type Severity } from './tier-pool';

export const EXPLORE_POLICY = {
  version: 1,
  /** A learning challenger's fixed share. */
  learnShare: 0.1,
  quantum: 0.05,
  /** The incumbent never drops below this in explore. */
  incumbentFloor: 0.2,
  challengerMin: 0.05,
  draws: 10_000,
  learnMinDays: 7,
  /** Stage n applies from `minMultiple · M` graded units. */
  stages: [
    { stage: 1, minMultiple: 1, max: 0.25, step: 0.1 },
    { stage: 2, minMultiple: 2, max: 0.45, step: 0.15 },
    { stage: 3, minMultiple: 4, max: 0.7, step: 0.2 },
  ],
  spread: { agent: { units: 5 }, chat: { conversations: 10, users: 3 } },
  /** Popularity is worth at most this many pseudo-units. */
  popularityUnits: 4,
  harm: { earlyWindow: 20, earlyCritical: 2, minGraded: 10, pWorse: 0.9 },
  /** P(old beats successor) at which succession decay freezes. */
  successionHold: 0.9,
  /** Below this multiplier a decaying challenger gets a removal suggestion. */
  successionRemoveBelow: 0.1,
  /** P(successor beats incumbent) before a promotion is suggested. */
  promoteAt: 0.95,
} as const;

export const EXPLORE_POLICY_TAG = `explore-v${EXPLORE_POLICY.version}` as const;

export type ExploreStage = 'incumbent' | 'learning' | 1 | 2 | 3;

export type ExploreActor = 'system:harm-cut' | 'system:expiry' | 'system:succession' | 'system:explore';

/** Highest precedence first (§4c). */
const ACTOR_PRECEDENCE: ReadonlyArray<[SignalKind, ExploreActor]> = [
  ['harm-cut', 'system:harm-cut'],
  ['expiry', 'system:expiry'],
  ['succession', 'system:succession'],
];

export type SignalKind = 'popularity' | 'succession' | 'expiry' | 'harm-cut';

export interface ArmEvidence {
  /** Graded units counted toward the stage. */
  graded: number;
  /** Σ w·q over graded units. */
  successes: number;
  /** Σ w·(1 − q) over graded units. */
  failures: number;
  /** Critical grades among the arm's first 20 graded units. */
  earlyCritical: number;
  spread: { units: number; conversations: number; users: number };
}

export const EMPTY_EVIDENCE: ArmEvidence = {
  graded: 0, successes: 0, failures: 0, earlyCritical: 0,
  spread: { units: 0, conversations: 0, users: 0 },
};

export interface ExploreArmInput {
  id: string;
  role: 'incumbent' | 'challenger';
  model: string;
  /** Whole days since the arm joined the pool. */
  ageDays: number;
  evidence: ArmEvidence;
  /** Popularity prior mean m ∈ [0.45, 0.55], or null for the neutral prior. */
  popularity: { m: number; views: string[]; asOf: string } | null;
  /** A successor of this arm's model is live in the pool. */
  succession: { successorArmId: string; multiplier: number; held: boolean } | null;
  /** The arm's model expires within the expiry horizon. */
  expiring: { expiresAt: string } | null;
}

export interface ExploreStepInput {
  poolId: string;
  surface: PoolSurface;
  /** UTC `yyyy-mm-dd` of the step. */
  date: string;
  /** The pool experiment's policy version (salts the seed with the pool id and date). */
  policyVersion: number;
  current: Allocation;
  /** Live arms in `armOrder`: incumbent first, then challengers by join time. */
  arms: readonly ExploreArmInput[];
  gradingHealthy: boolean;
}

export interface ExploreArmEvidence {
  stage: ExploreStage;
  g: number;
  alpha: number;
  beta: number;
  pBest: number;
  capBefore: number;
  capAfter: number;
  share: number;
  prior?: { signal: 'popularity'; views: string[]; asOf: string; m: number };
}

export interface ExploreSignal {
  kind: SignalKind | 'succession_held';
  armId: string;
  asOf?: string;
  views?: string[];
  successorArmId?: string;
  multiplier?: number;
}

export interface ExploreSuggestion {
  /** Stable key, so a suggestion is written once, not every day. */
  key: string;
  action: 'remove' | 'promote';
  armId: string;
  signal: 'succession';
}

export interface ExploreStepResult {
  allocation: Allocation;
  /** Write it: it differs from the current allocation, and not for popularity alone. */
  write: boolean;
  actorSystem: ExploreActor;
  causes: SignalKind[];
  /** Arms whose succession decay freezes at this step's multiplier. */
  holds: Record<string, number>;
  suggestions: ExploreSuggestion[];
  evidence: {
    policy: typeof EXPLORE_POLICY_TAG;
    policyVersion: number;
    date: string;
    seed: string;
    arms: Record<string, ExploreArmEvidence>;
    signals: ExploreSignal[];
    causes: SignalKind[];
  };
}

// ── Stages ──────────────────────────────────────────────────────────────────

/** An arm's stage (§3a, §3b). The incumbent has none. */
export function armStage(arm: Pick<ExploreArmInput, 'role' | 'ageDays' | 'evidence'>, surface: PoolSurface, gradingHealthy: boolean): ExploreStage {
  if (arm.role === 'incumbent') return 'incumbent';
  const M = MIN_GRADED_UNITS[surface];
  const g = arm.evidence.graded;
  const s = arm.evidence.spread;
  const spreadOk = surface === 'agent'
    ? s.units >= EXPLORE_POLICY.spread.agent.units
    : s.conversations >= EXPLORE_POLICY.spread.chat.conversations && s.users >= EXPLORE_POLICY.spread.chat.users;
  if (g < M || !spreadOk || arm.ageDays < EXPLORE_POLICY.learnMinDays || !gradingHealthy) return 'learning';
  let stage: 1 | 2 | 3 = 1;
  for (const st of EXPLORE_POLICY.stages) if (g >= st.minMultiple * M) stage = st.stage as 1 | 2 | 3;
  return stage;
}

function stageRow(stage: 1 | 2 | 3) {
  return EXPLORE_POLICY.stages[stage - 1];
}

// ── Seeded Beta / Thompson ─────────────────────────────────────────────────

/** The seed key for a step: pool, policy version and day. */
export function stepSeedKey(poolId: string, policyVersion: number, date: string): string {
  return `${poolId}:${policyVersion}:${date}`;
}

/** mulberry32 over the 32-bit seed `hashUnitInterval(key)` names. */
export function seededRandom(key: string): () => number {
  let a = Math.floor(hashUnitInterval(key) * 0x100000000) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
  };
}

function normal(rand: () => number): number {
  // Box–Muller; 1 − u keeps log() off 0.
  const u = 1 - rand();
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Marsaglia–Tsang. */
function gamma(shape: number, rand: () => number): number {
  if (shape < 1) return gamma(shape + 1, rand) * Math.pow(1 - rand(), 1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = normal(rand);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = 1 - rand();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

export function sampleBeta(alpha: number, beta: number, rand: () => number): number {
  const x = gamma(alpha, rand);
  const y = gamma(beta, rand);
  return x / (x + y);
}

export interface ThompsonResult {
  /** P(arm is best), per index. Ties go to the earlier arm. */
  pBest: number[];
  /** beats[i][j] = P(θ_i > θ_j). */
  beats: number[][];
}

/** `draws` joint draws from each arm's Beta posterior. */
export function thompson(params: ReadonlyArray<{ alpha: number; beta: number }>, draws: number, rand: () => number): ThompsonResult {
  const n = params.length;
  const best = new Array<number>(n).fill(0);
  const beats = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  const theta = new Array<number>(n);
  for (let k = 0; k < draws; k++) {
    let top = 0;
    for (let i = 0; i < n; i++) {
      theta[i] = sampleBeta(params[i].alpha, params[i].beta, rand);
      if (theta[i] > theta[top]) top = i;
    }
    best[top] += 1;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (theta[i] > theta[j]) beats[i][j] += 1;
  }
  return { pBest: best.map(b => b / draws), beats: beats.map(r => r.map(b => b / draws)) };
}

// ── Popularity prior ────────────────────────────────────────────────────────

/** m = 0.5 + 0.1·(pctile − 0.5), in [0.45, 0.55] (§4a). */
export function popularityMean(pctile: number): number {
  const p = Math.min(1, Math.max(0, pctile));
  return 0.5 + 0.1 * (p - 0.5);
}

// ── Projection, step limit, quantize ───────────────────────────────────────

interface Box { lo: number; hi: number }

/**
 * Project `target` onto the boxes with Σ = 1: the renormalised target,
 * clamped to each box, with the scale found by bisection so the clamped
 * shares sum to 1 (clamp, renormalise, repeat, to a fixed point). Arms with no
 * target take their floor; if the target cannot fill 1 on its own, the
 * remainder is spread evenly over arms with room.
 */
export function projectOntoBounds(target: readonly number[], boxes: readonly Box[]): number[] {
  const n = target.length;
  const clamp = (v: number, i: number) => Math.min(boxes[i].hi, Math.max(boxes[i].lo, v));
  const total = target.reduce((s, v) => s + Math.max(0, v), 0);
  const t = target.map(v => (total > 0 ? Math.max(0, v) / total : 1 / n));
  const sumAt = (lambda: number) => t.reduce((s, v, i) => s + clamp(lambda * v, i), 0);
  let lo = 0;
  let hi = 1;
  while (sumAt(hi) < 1 && hi < 1e6) hi *= 2;
  for (let k = 0; k < 100; k++) {
    const mid = (lo + hi) / 2;
    if (sumAt(mid) < 1) lo = mid; else hi = mid;
  }
  const out = t.map((v, i) => clamp(hi * v, i));
  let left = 1 - out.reduce((s, v) => s + v, 0);
  for (let pass = 0; pass < n && left > 1e-12; pass++) {
    const room = out.map((v, i) => boxes[i].hi - v);
    const open = room.map((r, i) => i).filter(i => room[i] > 1e-12);
    if (open.length === 0) break;
    const each = left / open.length;
    for (const i of open) {
      const add = Math.min(each, room[i]);
      out[i] += add;
      left -= add;
    }
  }
  return out;
}

/**
 * Largest remainder onto a `quantum` grid. `fixedUnits[i]` pins an arm (a
 * learning arm's 0.10, a cut arm's 0). Ties go to the earlier arm.
 */
export function quantize(shares: readonly number[], fixedUnits: ReadonlyArray<number | null>, quantum: number = EXPLORE_POLICY.quantum): number[] {
  const total = Math.round(1 / quantum);
  const units = shares.map((s, i) => fixedUnits[i] ?? Math.floor(s * total + 1e-9));
  const free = shares.map((_, i) => i).filter(i => fixedUnits[i] == null);
  let left = total - units.reduce((s, u) => s + u, 0);
  const order = [...free].sort((a, b) => {
    const fa = shares[a] * total - units[a];
    const fb = shares[b] * total - units[b];
    return fb - fa || a - b;
  });
  for (let k = 0; left > 0 && order.length > 0; k = (k + 1) % order.length, left--) units[order[k]] += 1;
  return units.map(u => Math.round(u * quantum * 10_000) / 10_000);
}

export function sameAllocation(a: Allocation, b: Allocation): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if (Math.abs((a[k] ?? 0) - (b[k] ?? 0)) > 1e-6) return false;
  return true;
}

// ── The step ────────────────────────────────────────────────────────────────

interface Drop { popularity?: boolean; succession?: boolean; expiry?: boolean; 'harm-cut'?: boolean }

interface Computed {
  allocation: Allocation;
  arms: Record<string, ExploreArmEvidence>;
  harmCut: string[];
  thompson: ThompsonResult;
}

function compute(input: ExploreStepInput, drop: Drop): Computed {
  const arms = input.arms;
  const n = arms.length;
  const incIdx = arms.findIndex(a => a.role === 'incumbent');
  const stages = arms.map(a => armStage(a, input.surface, input.gradingHealthy));

  const params = arms.map(a => {
    const pop = !drop.popularity && a.popularity ? a.popularity.m : null;
    return {
      alpha: 1 + a.evidence.successes + (pop != null ? EXPLORE_POLICY.popularityUnits * pop : 0),
      beta: 1 + a.evidence.failures + (pop != null ? EXPLORE_POLICY.popularityUnits * (1 - pop) : 0),
    };
  });
  const rand = seededRandom(stepSeedKey(input.poolId, input.policyVersion, input.date));
  const ts = thompson(params, EXPLORE_POLICY.draws, rand);

  // Harm cut (pools §6): challengers only.
  const cut = arms.map((a, i) => {
    if (drop['harm-cut'] || a.role !== 'challenger') return false;
    if (a.evidence.earlyCritical >= EXPLORE_POLICY.harm.earlyCritical) return true;
    return incIdx >= 0 && a.evidence.graded >= EXPLORE_POLICY.harm.minGraded && ts.beats[incIdx][i] >= EXPLORE_POLICY.harm.pWorse;
  });

  const boxes: Box[] = [];
  const capBefore: number[] = [];
  const steps: Array<number | null> = [];
  for (let i = 0; i < n; i++) {
    const a = arms[i];
    const st = stages[i];
    let box: Box;
    let step: number | null;
    if (st === 'incumbent') {
      box = { lo: EXPLORE_POLICY.incumbentFloor, hi: 1 };
      step = null;
    } else if (st === 'learning') {
      box = { lo: EXPLORE_POLICY.learnShare, hi: EXPLORE_POLICY.learnShare };
      step = null;
    } else {
      box = { lo: EXPLORE_POLICY.challengerMin, hi: stageRow(st).max };
      step = stageRow(st).step;
    }
    capBefore.push(box.hi);
    if (!drop.succession && a.succession && st !== 'learning') {
      const m = a.succession.multiplier;
      box = st === 'incumbent'
        ? { lo: box.lo, hi: EXPLORE_POLICY.incumbentFloor + (1 - EXPLORE_POLICY.incumbentFloor) * m }
        : { lo: box.lo, hi: Math.max(EXPLORE_POLICY.challengerMin, box.hi * m) };
    }
    if (!drop.expiry && a.expiring) box = { lo: 0, hi: 0 };
    if (cut[i]) box = { lo: 0, hi: 0 };
    boxes.push(box);
    steps.push(step);
  }

  const target = ts.pBest.map((p, i) => (cut[i] ? 0 : p));
  const projected = projectOntoBounds(target, boxes);

  // Max step per challenger, from the current share. The incumbent takes the rest.
  const cur = arms.map(a => input.current[a.id] ?? 0);
  const next = projected.map((p, i) => {
    if (i === incIdx) return p;
    if (cut[i] || stages[i] === 'learning') return boxes[i].hi;
    const d = steps[i] ?? 1;
    // Expiry is reached through the normal steps; a cut is immediate.
    return Math.min(cur[i] + d, Math.max(cur[i] - d, p));
  });
  if (incIdx >= 0) {
    const others = next.reduce((s, v, i) => (i === incIdx ? s : s + v), 0);
    next[incIdx] = 1 - others;
    // Below its floor: take back the largest increases first.
    let short = boxes[incIdx].lo - next[incIdx];
    if (short > 1e-9) {
      const inc = next.map((v, i) => ({ i, up: v - cur[i] }))
        .filter(x => x.i !== incIdx && x.up > 0 && stages[x.i] !== 'learning')
        .sort((a, b) => b.up - a.up || a.i - b.i);
      for (const x of inc) {
        if (short <= 1e-9) break;
        const give = Math.min(x.up, short, next[x.i] - boxes[x.i].lo);
        if (give <= 0) continue;
        next[x.i] -= give; next[incIdx] += give; short -= give;
      }
    }
    // Above its cap (succession, expiry): hand the excess to challengers with
    // room within their box and step, best first. What is left stays put.
    let excess = next[incIdx] - boxes[incIdx].hi;
    if (excess > 1e-9) {
      const room = next.map((v, i) => ({ i, room: Math.min(boxes[i].hi, cur[i] + (steps[i] ?? 0)) - v }))
        .filter(x => x.i !== incIdx && x.room > 0 && !cut[x.i] && stages[x.i] !== 'learning')
        .sort((a, b) => ts.pBest[b.i] - ts.pBest[a.i] || a.i - b.i);
      for (const x of room) {
        if (excess <= 1e-9) break;
        const take = Math.min(x.room, excess);
        next[x.i] += take; next[incIdx] -= take; excess -= take;
      }
    }
  }

  const fixedUnits = arms.map((_, i) => {
    if (cut[i]) return 0;
    if (stages[i] === 'learning') return Math.round(boxes[i].hi / EXPLORE_POLICY.quantum);
    return null;
  });
  const q = quantize(next.map(v => Math.max(0, v)), fixedUnits);

  const allocation: Allocation = {};
  const evid: Record<string, ExploreArmEvidence> = {};
  arms.forEach((a, i) => {
    allocation[a.id] = q[i];
    evid[a.id] = {
      stage: stages[i],
      g: a.evidence.graded,
      alpha: round4(params[i].alpha),
      beta: round4(params[i].beta),
      pBest: round4(ts.pBest[i]),
      capBefore: round4(capBefore[i]),
      capAfter: round4(boxes[i].hi),
      share: q[i],
      ...(a.popularity && !drop.popularity
        ? { prior: { signal: 'popularity' as const, views: a.popularity.views, asOf: a.popularity.asOf, m: round4(a.popularity.m) } }
        : {}),
    };
  });
  return { allocation, arms: evid, harmCut: arms.filter((_, i) => cut[i]).map(a => a.id), thompson: ts };
}

function round4(x: number): number {
  return Math.round(x * 10_000) / 10_000;
}

/** One daily step for an explore pool. */
export function exploreStep(input: ExploreStepInput): ExploreStepResult {
  const full = compute(input, {});
  const arms = input.arms;
  const idx = new Map(arms.map((a, i) => [a.id, i]));

  const signals: ExploreSignal[] = [];
  const present = new Set<SignalKind>();
  for (const a of arms) {
    if (a.popularity) { present.add('popularity'); signals.push({ kind: 'popularity', armId: a.id, views: a.popularity.views, asOf: a.popularity.asOf }); }
    if (a.succession) { present.add('succession'); signals.push({ kind: 'succession', armId: a.id, successorArmId: a.succession.successorArmId, multiplier: round4(a.succession.multiplier) }); }
    if (a.expiring) { present.add('expiry'); signals.push({ kind: 'expiry', armId: a.id, asOf: a.expiring.expiresAt }); }
  }
  for (const id of full.harmCut) { present.add('harm-cut'); signals.push({ kind: 'harm-cut', armId: id }); }

  const causes: SignalKind[] = [];
  const cf: Partial<Record<SignalKind, Allocation>> = {};
  for (const kind of ['harm-cut', 'expiry', 'succession', 'popularity'] as SignalKind[]) {
    if (!present.has(kind)) continue;
    cf[kind] = compute(input, { [kind]: true }).allocation;
    if (!sameAllocation(cf[kind]!, full.allocation)) causes.push(kind);
  }

  const differs = !sameAllocation(full.allocation, input.current);
  // Popularity never triggers a change on its own (§4c).
  const popularityOnly = differs && cf.popularity !== undefined && sameAllocation(cf.popularity, input.current);
  const write = differs && !popularityOnly;
  const actorSystem = ACTOR_PRECEDENCE.find(([k]) => causes.includes(k))?.[1] ?? 'system:explore';

  // Succession hold and suggestions.
  const holds: Record<string, number> = {};
  const suggestions: ExploreSuggestion[] = [];
  const stageOf = (id: string) => full.arms[id]?.stage;
  for (const a of arms) {
    if (!a.succession) continue;
    const i = idx.get(a.id)!;
    const j = idx.get(a.succession.successorArmId);
    const bothPast = j !== undefined && stageOf(a.id) !== 'learning' && stageOf(arms[j].id) !== 'learning';
    if (!a.succession.held && bothPast && full.thompson.beats[i][j!] >= EXPLORE_POLICY.successionHold) {
      holds[a.id] = round4(a.succession.multiplier);
      signals.push({ kind: 'succession_held', armId: a.id, successorArmId: a.succession.successorArmId, multiplier: holds[a.id] });
    }
    if (a.role === 'challenger' && a.succession.multiplier < EXPLORE_POLICY.successionRemoveBelow && !a.succession.held) {
      suggestions.push({ key: `succession-remove:${a.id}:${a.succession.successorArmId}`, action: 'remove', armId: a.id, signal: 'succession' });
    }
    if (
      a.role === 'incumbent' && j !== undefined && stageOf(arms[j].id) !== 'learning'
      && full.allocation[a.id] <= EXPLORE_POLICY.incumbentFloor + 1e-9
      && full.thompson.beats[j][i] >= EXPLORE_POLICY.promoteAt
    ) {
      suggestions.push({ key: `succession-promote:${arms[j].id}:${a.id}`, action: 'promote', armId: arms[j].id, signal: 'succession' });
    }
  }

  return {
    allocation: full.allocation,
    write,
    actorSystem,
    causes,
    holds,
    suggestions,
    evidence: {
      policy: EXPLORE_POLICY_TAG,
      policyVersion: EXPLORE_POLICY.version,
      date: input.date,
      seed: stepSeedKey(input.poolId, input.policyVersion, input.date),
      arms: full.arms,
      signals,
      causes,
    },
  };
}

/**
 * Split → explore (§3d): project the current shares onto each arm's stage
 * bounds (learning arms to 0.10) and quantize. No max-step on entry.
 */
export function enterExploreAllocation(args: {
  surface: PoolSurface;
  current: Allocation;
  arms: ReadonlyArray<Pick<ExploreArmInput, 'id' | 'role' | 'ageDays' | 'evidence'>>;
  gradingHealthy: boolean;
}): Allocation {
  const stages = args.arms.map(a => armStage(a, args.surface, args.gradingHealthy));
  const boxes = stages.map(st =>
    st === 'incumbent' ? { lo: EXPLORE_POLICY.incumbentFloor, hi: 1 }
      : st === 'learning' ? { lo: EXPLORE_POLICY.learnShare, hi: EXPLORE_POLICY.learnShare }
        : { lo: EXPLORE_POLICY.challengerMin, hi: stageRow(st).max });
  const projected = projectOntoBounds(args.arms.map(a => args.current[a.id] ?? 0), boxes);
  const q = quantize(projected, stages.map(st => (st === 'learning' ? Math.round(EXPLORE_POLICY.learnShare / EXPLORE_POLICY.quantum) : null)));
  const out: Allocation = {};
  args.arms.forEach((a, i) => { out[a.id] = q[i]; });
  return out;
}

/** Popularity data never leaves the allocate step (§4a licence). */
export function stripPopularity(evidence: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!evidence) return null;
  const out: Record<string, unknown> = { ...evidence };
  if (out.arms && typeof out.arms === 'object') {
    const arms: Record<string, unknown> = {};
    for (const [id, a] of Object.entries(out.arms as Record<string, Record<string, unknown>>)) {
      const { prior: _prior, ...rest } = a ?? {};
      arms[id] = rest;
    }
    out.arms = arms;
  }
  if (Array.isArray(out.signals)) out.signals = (out.signals as Array<{ kind?: string }>).filter(s => s?.kind !== 'popularity');
  if (Array.isArray(out.causes)) out.causes = (out.causes as string[]).filter(c => c !== 'popularity');
  return out;
}

// ── Split guardrails ────────────────────────────────────────────────────────

/**
 * The two automatic changes a split pool accepts (§1, §4b): a harm cut, and an
 * arm whose model has expired. Both move the arm's share onto the incumbent;
 * nothing else in split moves. Null when neither applies.
 */
export function splitGuardrails(input: {
  poolId: string;
  surface: PoolSurface;
  date: string;
  policyVersion: number;
  current: Allocation;
  arms: ReadonlyArray<Pick<ExploreArmInput, 'id' | 'role' | 'evidence'> & { expired: boolean }>;
}): { allocation: Allocation; actorSystem: 'system:harm-cut' | 'system:expiry'; cut: string[]; expired: string[]; evidence: Record<string, unknown> } | null {
  const inc = input.arms.find(a => a.role === 'incumbent');
  if (!inc) return null;
  const params = input.arms.map(a => ({ alpha: 1 + a.evidence.successes, beta: 1 + a.evidence.failures }));
  const seed = stepSeedKey(input.poolId, input.policyVersion, input.date);
  const ts = thompson(params, EXPLORE_POLICY.draws, seededRandom(seed));
  const incIdx = input.arms.indexOf(inc);
  const cut: string[] = [];
  const expired: string[] = [];
  input.arms.forEach((a, i) => {
    if (a.role !== 'challenger' || !((input.current[a.id] ?? 0) > 0)) return;
    const harmed = a.evidence.earlyCritical >= EXPLORE_POLICY.harm.earlyCritical
      || (a.evidence.graded >= EXPLORE_POLICY.harm.minGraded && ts.beats[incIdx][i] >= EXPLORE_POLICY.harm.pWorse);
    if (harmed) cut.push(a.id);
    else if (a.expired) expired.push(a.id);
  });
  if (cut.length === 0 && expired.length === 0) return null;
  const allocation: Allocation = { ...input.current };
  for (const id of [...cut, ...expired]) {
    allocation[inc.id] = round4((allocation[inc.id] ?? 0) + (allocation[id] ?? 0));
    allocation[id] = 0;
  }
  return {
    allocation,
    actorSystem: cut.length ? 'system:harm-cut' : 'system:expiry',
    cut,
    expired,
    evidence: {
      policy: EXPLORE_POLICY_TAG, date: input.date, seed,
      signals: [...cut.map(armId => ({ kind: 'harm-cut', armId })), ...expired.map(armId => ({ kind: 'expiry', armId }))],
    },
  };
}

// ── Evidence ────────────────────────────────────────────────────────────────

export interface GradedUnit {
  severity: Severity | null;
  /** Mission or task the unit belongs to (agent spread). */
  unitId: string | null;
  conversationId: string | null;
  userId: string | null;
}

/**
 * An arm's evidence from its units in assignment order. P1 grades carry
 * weight 1 (pools §5d); ungraded units count for nothing.
 */
export function aggregateEvidence(units: readonly GradedUnit[]): ArmEvidence {
  let graded = 0;
  let successes = 0;
  let failures = 0;
  let earlyCritical = 0;
  const unitIds = new Set<string>();
  const convs = new Set<string>();
  const users = new Set<string>();
  for (const u of units) {
    if (!u.severity) continue;
    const q = QUALITY_BY_SEVERITY[u.severity];
    if (graded < EXPLORE_POLICY.harm.earlyWindow && u.severity === 'critical') earlyCritical += 1;
    graded += 1;
    successes += q;
    failures += 1 - q;
    if (u.unitId) unitIds.add(u.unitId);
    if (u.conversationId) convs.add(u.conversationId);
    if (u.userId) users.add(u.userId);
  }
  return {
    graded, successes: round4(successes), failures: round4(failures), earlyCritical,
    spread: { units: unitIds.size, conversations: convs.size, users: users.size },
  };
}
