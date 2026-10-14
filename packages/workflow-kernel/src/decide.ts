/**
 * Decision points and the Decide port's one entry (docs/specs/
 * workflow-kernel-library.md §2 "Decide", AC-27–AC-29).
 *
 * Where the kernel wants a judgment it may ask the host's decider at a named
 * decision point. Every point has a deterministic default here; no decider,
 * no answer, an error, a timeout or an answer outside the point's verdicts
 * takes the default and records why. The answer is a fact on the delivery,
 * written before the transition that uses it, and a replay reads that fact
 * and calls no decider, so a delivery's history stays deterministic.
 *
 * `decideAt` / `decideAndRecord` are called from the command and effect
 * layer only. The reducer and the landing gate never call them and never read
 * a decision fact: a decider's answer can choose between paths the kernel
 * already allows, it cannot open one (the gate reads review verdicts, heads
 * and CI, §4).
 */
import type { Decide, DecideAnswer, Store } from './ports';

export interface DecisionPoint<I = Record<string, unknown>> {
  name: string;
  verdicts: readonly string[];
  /** Below this confidence an answer is not taken. */
  minConfidence?: number;
  /** The package default: what the kernel does with no usable answer. */
  fallback(input: I): { verdict: string; reason: string };
  /** The question's identity, for the fact key: the same input asks the same question. */
  inputKey(input: I): string;
}

/**
 * `visual_impact`: does a head change anything a person can see? The
 * default is fail-safe, `review_required`: only a confident answer can skip
 * a visual review. (buildd's classifier, apps/web visual-review-impact-load.ts,
 * asks it through `decideAndRecord` with its decision model as the decider.)
 */
export const VISUAL_IMPACT_POINT: DecisionPoint<{ headSha: string; [k: string]: unknown }> = {
  name: 'visual_impact',
  verdicts: ['no_visual_impact', 'review_required', 'insufficient_evidence'],
  minConfidence: 0.8,
  fallback: () => ({ verdict: 'review_required', reason: 'fail_safe' }),
  inputKey: (input) => String(input.headSha),
};

export const DECISION_POINTS = { visual_impact: VISUAL_IMPACT_POINT } as const;

/**
 * Why the default was taken. `invalid_record`: the fact recorded for this
 * question cannot be read as a decision (a malformed payload), so the replay
 * takes the default instead of failing, and records that it did.
 */
export type DecisionFallback = 'no_decider' | 'no_answer' | 'error' | 'timeout' | 'invalid_answer' | 'low_confidence' | 'invalid_record';

/** The recorded decision: the fact a transition that uses it links. */
export interface DecisionFact {
  point: string;
  inputKey: string;
  /** The decider that answered, or null when the default was taken without one. */
  deciderId: string | null;
  verdict: string;
  confidence: number | null;
  reason: string;
  source: 'decider' | 'default';
  /** Why the default was taken; null when the decider's answer was used. */
  fallback: DecisionFallback | null;
  /** What went wrong, bounded, when `fallback` is `error`. */
  error?: string;
}

export const DECIDE_TIMEOUT_MS = 5_000;

export interface DecideDeps {
  decide?: Decide;
  timeoutMs?: number;
  /** A recorded fact for this question: replay uses it and calls no decider (AC-28). */
  recorded?: DecisionFact | null;
}

const TIMEOUT = Symbol('timeout');

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMEOUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<typeof TIMEOUT>((resolve) => { timer = setTimeout(() => resolve(TIMEOUT), ms); });
  try { return await Promise.race([p, t]); } finally { if (timer !== undefined) clearTimeout(timer); }
}

function usable<I>(point: DecisionPoint<I>, a: DecideAnswer): DecisionFallback | null {
  if (!a || typeof a.verdict !== 'string' || !point.verdicts.includes(a.verdict)) return 'invalid_answer';
  if (typeof a.confidence !== 'number' || !Number.isFinite(a.confidence) || a.confidence < 0 || a.confidence > 1) return 'invalid_answer';
  if (point.minConfidence !== undefined && a.confidence < point.minConfidence) return 'low_confidence';
  return null;
}

/**
 * Ask the decider at `point` with a bounded timeout, or take the default.
 * Returns the fact to record; never throws for the decider's sake (AC-29).
 */
export async function decideAt<I extends Record<string, unknown>>(point: DecisionPoint<I>, input: I, deps: DecideDeps = {}): Promise<{ fact: DecisionFact; replayed: boolean }> {
  const inputKey = point.inputKey(input);
  if (deps.recorded) return { fact: deps.recorded, replayed: true };
  const byDefault = (fallback: DecisionFallback, deciderId: string | null, error?: string): { fact: DecisionFact; replayed: boolean } => {
    const d = point.fallback(input);
    return {
      fact: { point: point.name, inputKey, deciderId, verdict: d.verdict, confidence: null, reason: d.reason, source: 'default', fallback, ...(error ? { error } : {}) },
      replayed: false,
    };
  };
  const decider = deps.decide;
  if (!decider) return byDefault('no_decider', null);
  let answer: DecideAnswer | null | typeof TIMEOUT;
  try {
    answer = await withTimeout(decider.decide(point.name, input), deps.timeoutMs ?? DECIDE_TIMEOUT_MS);
  } catch (err) {
    return byDefault('error', decider.id, String((err as Error)?.message ?? err).slice(0, 200));
  }
  if (answer === TIMEOUT) return byDefault('timeout', decider.id);
  if (answer == null) return byDefault('no_answer', decider.id);
  const bad = usable(point, answer);
  if (bad) return byDefault(bad, decider.id);
  return {
    fact: { point: point.name, inputKey, deciderId: decider.id, verdict: answer.verdict, confidence: answer.confidence, reason: String(answer.reason ?? '').slice(0, 500), source: 'decider', fallback: null },
    replayed: false,
  };
}

/** One decision fact per (delivery, point, question). */
export function decisionFactKey(deliveryId: string, point: string, inputKey: string): string {
  return `decide:${point}:${deliveryId}:${inputKey}`;
}

export function toDecisionFact(payload: Record<string, unknown>): DecisionFact | null {
  const p = payload as Partial<DecisionFact>;
  if (typeof p.point !== 'string' || typeof p.verdict !== 'string' || typeof p.inputKey !== 'string') return null;
  return {
    point: p.point, inputKey: p.inputKey, deciderId: p.deciderId ?? null, verdict: p.verdict,
    confidence: typeof p.confidence === 'number' ? p.confidence : null, reason: String(p.reason ?? ''),
    source: p.source === 'decider' ? 'decider' : 'default', fallback: p.fallback ?? null, ...(p.error ? { error: p.error } : {}),
  };
}

export interface DecisionSubject {
  workspaceId: string;
  deliveryId: string;
  repoFullName?: string | null;
  prNumber?: number | null;
  /** Who asked (the effect or command), recorded as the fact's source. */
  source: string;
}

/**
 * The decision as a recorded fact (AC-27): read the recorded one if this
 * question was decided before (replay, AC-28), else decide and record it.
 * Returns the fact id; the transition that uses the decision passes it as
 * its `factId`, so the fact is written first and linked by that transition.
 */
export async function decideAndRecord<I extends Record<string, unknown>>(
  store: Store, subject: DecisionSubject, point: DecisionPoint<I>, input: I, deps: Omit<DecideDeps, 'recorded'> = {},
): Promise<{ fact: DecisionFact; factId: string; replayed: boolean }> {
  const factKey = decisionFactKey(subject.deliveryId, point.name, point.inputKey(input));
  const prior = await store.findFact(subject.workspaceId, factKey);
  const recorded = prior ? toDecisionFact(prior.payload) : null;
  if (prior && recorded) return { fact: recorded, factId: prior.id, replayed: true };
  if (prior) return recordInvalid(store, subject, point, input, factKey);

  const { fact } = await decideAt(point, input, deps);
  const inserted = await store.insertFact({
    workspaceId: subject.workspaceId, kind: 'decision', factKey, source: subject.source,
    repoFullName: subject.repoFullName ?? null, prNumber: subject.prNumber ?? null, payload: { ...fact, deliveryId: subject.deliveryId },
  });
  if (inserted) return { fact, factId: inserted.id, replayed: false };
  // Another caller recorded this question between the read and the write: its answer is the decision.
  const winner = await store.findFact(subject.workspaceId, factKey);
  if (!winner) throw new Error(`decideAndRecord: fact ${factKey} neither inserted nor found`);
  const won = toDecisionFact(winner.payload);
  if (!won) return recordInvalid(store, subject, point, input, factKey);
  return { fact: won, factId: winner.id, replayed: true };
}

/** Where the default taken for an unreadable recorded decision is itself recorded. */
export function invalidRecordFactKey(factKey: string): string {
  return `${factKey}#invalid_record`;
}

/**
 * The recorded fact for this question is not a decision: take the package
 * default without asking the decider (a replay never does), record it beside
 * the unreadable one with the reason, and answer with that record. A later
 * replay finds it and answers the same, so history stays deterministic.
 */
async function recordInvalid<I extends Record<string, unknown>>(
  store: Store, subject: DecisionSubject, point: DecisionPoint<I>, input: I, factKey: string,
): Promise<{ fact: DecisionFact; factId: string; replayed: boolean }> {
  const key = invalidRecordFactKey(factKey);
  const already = await store.findFact(subject.workspaceId, key);
  const readBack = already ? toDecisionFact(already.payload) : null;
  if (already && readBack) return { fact: readBack, factId: already.id, replayed: true };
  const d = point.fallback(input);
  const fact: DecisionFact = {
    point: point.name, inputKey: point.inputKey(input), deciderId: null, verdict: d.verdict, confidence: null,
    reason: d.reason, source: 'default', fallback: 'invalid_record', error: `the fact recorded under ${factKey} is not a decision`.slice(0, 200),
  };
  const inserted = await store.insertFact({
    workspaceId: subject.workspaceId, kind: 'decision', factKey: key, source: subject.source,
    repoFullName: subject.repoFullName ?? null, prNumber: subject.prNumber ?? null, payload: { ...fact, deliveryId: subject.deliveryId },
  });
  if (inserted) return { fact, factId: inserted.id, replayed: false };
  const winner = await store.findFact(subject.workspaceId, key);
  if (!winner) throw new Error(`decideAndRecord: fact ${key} neither inserted nor found`);
  return { fact: toDecisionFact(winner.payload) ?? fact, factId: winner.id, replayed: true };
}
