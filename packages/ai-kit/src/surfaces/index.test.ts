import { describe, expect, it } from 'bun:test';
import { DECIDE_ENGINE_VERSION, expectDecisionPinned, JEV_MODEL } from '@builddai/ai-kit/decide';
import { DEFAULT_RANK_LEVELS, defineRankSurface, MIN_GATE_EVAL_ROWS, RANK_SLOT, type SlotGate } from './index';

const catalogue = [
  { id: 'cash', label: 'Why did cash move?' },
  { id: 'due', label: "What's due?" },
  { id: 'sync', label: 'Accounts not syncing?' },
  { id: 'classify', label: 'Classify the rest' },
] as const;
type State = { stale: number; weekday: string };
const fallback = (s: State) => (s.stale > 0 ? ['sync', 'cash', 'due'] : ['cash', 'due']);

const base = {
  id: 'test.chips', promptVersion: '2026-09-28.a', candidates: catalogue,
  question: (c: typeof catalogue[number]) => `Offer "${c.label}"?`, fallback, max: 2,
};
const fingerprint = () => defineRankSurface<typeof catalogue[number], State>({ ...base, mode: 'shadow' }).slotFingerprint(RANK_SLOT);
/** What gateFromEval returns for this surface: bound to its fingerprint, from enough rows. */
const gate = (over: Partial<SlotGate> = {}): SlotGate => ({
  slot: RANK_SLOT, fingerprint: fingerprint(), minConfidence: 0.6, evalRows: MIN_GATE_EVAL_ROWS, heldOutAccuracy: 0.95, coverage: 0.8, ...over,
});
const surface = (over: Record<string, unknown> = {}) => defineRankSurface<typeof catalogue[number], State>({
  ...base, mode: 'gated', gate: gate(),
  ...(over as object),
});

const answer = (score: number, confidence = 0.9) => ({ type: 'score', score, legend: {}, probabilities: {}, confidence });
const reply = (answers: Record<string, unknown>) => async () => new Response(JSON.stringify({ model: 'typesafe/jev', answers, usage: { input_tokens: 10, output_tokens: 5, cost: 0.00001 } }), { status: 200, headers: { 'content-type': 'application/json' } });
const noSleep = () => Promise.resolve();
const quiet: State = { stale: 0, weekday: 'Tuesday' };

describe('defineRankSurface', () => {
  it('one score question per candidate, on the default levels; versioned like any decision', () => {
    const s = surface();
    expect(Object.keys(s.decision.questions)).toEqual(['cash', 'due', 'sync', 'classify']);
    expect(s.decision.questions.cash).toMatchObject({ type: 'score', instructions: 'Offer "Why did cash move?"?' });
    expect(s.decision.questions.cash.criteria).toEqual([...DEFAULT_RANK_LEVELS]);
    expect(s.version).toBe(`2026-09-28.a|${JEV_MODEL}|engine-${DECIDE_ENGINE_VERSION}`);
    expectDecisionPinned(s.decision, { fingerprint: s.decision.fingerprint });
  });

  it('rejects duplicate ids and a gated surface without an eval gate', () => {
    expect(() => surface({ candidates: [{ id: 'a' }, { id: 'a' }] as never })).toThrow(/unique/);
    expect(() => surface({ gate: undefined })).toThrow(/gateFromEval/);
  });

  // The P7 gate cannot be skipped through the single-slot surface (0.14.0).
  it('refuses a hand-typed threshold, gated or not', () => {
    expect(() => surface({ gate: undefined, minConfidence: 0.6 })).toThrow(/hand-typed minConfidence/);
    expect(() => surface({ mode: 'shadow', gate: undefined, minConfidence: 0.6 })).toThrow(/hand-typed minConfidence/);
  });

  it("refuses 'live', which would apply Jev at any confidence", () => {
    expect(() => surface({ mode: 'live', gate: undefined })).toThrow(/'shadow' or 'gated'/);
    expect(() => surface({ mode: 'live' })).toThrow(/'shadow' or 'gated'/);
  });

  it('refuses a gate from too few rows, for another slot, or for a changed surface', () => {
    expect(() => surface({ gate: gate({ evalRows: MIN_GATE_EVAL_ROWS - 1 }) })).toThrow(/at least 700/);
    expect(() => surface({ gate: gate({ slot: 'chips' }) })).toThrow(/evaluated for slot/);
    expect(() => surface({ question: (c: typeof catalogue[number]) => `Show "${c.label}"?` })).toThrow(/re-run/);
  });

  it('a gate from the shadow surface gates it: the fingerprint ignores mode', () => {
    expect(surface().slotFingerprint(RANK_SLOT)).toBe(fingerprint());
    expect(surface().decision.policyOf('cash')).toEqual({ mode: 'gated', minConfidence: 0.6 });
  });

  it('no key ⇒ no call, the fallback order, filled from the catalogue, capped at max', async () => {
    let called = false;
    const r = await surface().pick(quiet, { apiKey: null, fetch: async () => { called = true; return new Response('{}'); } });
    expect(called).toBe(false);
    expect(r).toMatchObject({ ids: ['cash', 'due'], order: ['cash', 'due', 'sync', 'classify'], source: 'fallback', reason: 'no_key' });
    expect(surface().rank({ stale: 1, weekday: 'Monday' }, null).ids).toEqual(['sync', 'cash']);
  });

  it('gated: applied scores reorder, ties and unapplied follow the fallback order', async () => {
    const r = await surface().pick(quiet, {
      apiKey: 'k', sleep: noSleep,
      fetch: reply({ cash: answer(0.2), due: answer(0.2), sync: answer(1.8), classify: answer(1.9, 0.3) }) as never,
    });
    expect(r.source).toBe('jev');
    // classify is below the threshold: it doesn't count, so it sorts after the applied ones.
    expect(r.order).toEqual(['sync', 'cash', 'due', 'classify']);
    expect(r.ids).toEqual(['sync', 'cash']);
    expect(r.scores).toEqual({ cash: 0.2, due: 0.2, sync: 1.8 });
  });

  it('too few confident answers, a failed call or shadow mode ⇒ the fallback, with the reason', async () => {
    const low = await surface().pick(quiet, { apiKey: 'k', sleep: noSleep, fetch: reply({ cash: answer(2, 0.9), due: answer(2, 0.1), sync: answer(2, 0.1), classify: answer(2, 0.1) }) as never });
    expect(low).toMatchObject({ source: 'fallback', reason: 'low_confidence', ids: ['cash', 'due'] });
    const failed = await surface().pick(quiet, { apiKey: 'k', sleep: noSleep, fetch: (async () => new Response('no', { status: 500 })) as never });
    expect(failed).toMatchObject({ source: 'fallback', reason: 'call_failed' });
    const shadow = await surface({ mode: 'shadow', gate: undefined }).pick(quiet, { apiKey: 'k', sleep: noSleep, fetch: reply({ cash: answer(0), due: answer(0), sync: answer(2), classify: answer(2) }) as never });
    expect(shadow).toMatchObject({ source: 'fallback', reason: 'shadow', ids: ['cash', 'due'] });
  });

  it('a throwing fallback still renders the catalogue; resolve returns registered candidates only', () => {
    const s = surface({ fallback: () => { throw new Error('boom'); } });
    expect(s.rank(quiet, null).order).toEqual(['cash', 'due', 'sync', 'classify']);
    expect(s.resolve(['sync', 'nope', 'cash']).map(c => c.label)).toEqual(['Accounts not syncing?', 'Why did cash move?']);
  });
});
