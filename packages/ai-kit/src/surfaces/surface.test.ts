import { describe, expect, it } from 'bun:test';
import { idParity, JEV_MODEL } from '@builddai/ai-kit/decide';
import {
  defineSurface,
  gateFromEval,
  MIN_GATE_EVAL_ROWS,
  runSurfaceEval,
  type SlotGate,
  type Surface,
  type SurfaceLog,
} from './index';

const chips = [
  { id: 'what_needs_me', label: 'What needs me?' },
  { id: 'plan_today', label: 'Plan today' },
  { id: 'recap_week', label: 'Recap my week' },
  { id: 'start_new', label: 'Start something new' },
  { id: 'bills', label: 'Bills due' },
] as const;
type State = { overdue: number; weekday: string };
const quiet: State = { overdue: 0, weekday: 'Tuesday' };

const slots = {
  chips: {
    type: 'rank' as const,
    candidates: chips,
    question: (c: typeof chips[number]) => `Offer "${c.label}" now?`,
    max: 4,
    default: ['what_needs_me', 'plan_today', 'recap_week', 'start_new'],
  },
  card: {
    type: 'choice' as const,
    question: 'Which card, if any, belongs above the chips?',
    labels: { none: 'Nothing is pressing', overdue_items: 'Items are overdue', unread_bills: 'Bills are unread' },
    default: 'none' as const,
  },
};

const surface = (over: Record<string, unknown> = {}) => defineSurface({
  id: 'cue.chat_empty', promptVersion: '2026-09-30.a', slots, ...over,
} as never) as unknown as Surface<State, typeof slots>;

const scoreA = (score: number, confidence = 0.9) => ({ type: 'score', score, legend: {}, probabilities: {}, confidence });
const choiceA = (choice: string, confidence = 0.9) => ({ type: 'choice', choice, probabilities: { [choice]: confidence }, confidence });
const reply = (answers: Record<string, unknown>) => async () => new Response(
  JSON.stringify({ model: 'typesafe/jev', answers, usage: { input_tokens: 10, output_tokens: 5, cost: 0.00001 } }),
  { status: 200, headers: { 'content-type': 'application/json' } },
);
const noSleep = () => Promise.resolve();

/** Jev would put bills and recap first and show the overdue card. */
const jevAnswers = {
  chips__what_needs_me: scoreA(0.5), chips__plan_today: scoreA(0.2), chips__recap_week: scoreA(1.6),
  chips__start_new: scoreA(0.1), chips__bills: scoreA(1.9),
  card: choiceA('overdue_items', 0.95),
};

describe('defineSurface', () => {
  it('one call: a score question per rank candidate and a choice per choice slot', () => {
    const s = surface();
    expect(Object.keys(s.decision.questions)).toEqual([
      'chips__what_needs_me', 'chips__plan_today', 'chips__recap_week', 'chips__start_new', 'chips__bills', 'card',
    ]);
    expect(s.decision.questions.card).toMatchObject({ type: 'choice', criteria: { none: 'Nothing is pressing' } });
    expect(s.version).toBe(`2026-09-30.a|${JEV_MODEL}|engine-1`);
    expect(s.slotFingerprint('chips')).toMatch(/^[0-9a-f]{12}$/);
    expect(s.slotFingerprint('chips')).not.toBe(s.slotFingerprint('card'));
  });

  it('types each slot from its config with no casts (rank ⇒ ids, choice ⇒ label, resolve ⇒ your candidate)', () => {
    const typed = defineSurface({ id: 'cue.chat_empty', promptVersion: '2026-09-30.a', slots });
    const { pick } = typed.combine({ overdue: 0 }, null);
    const ids: string[] = pick.slots.chips.ids;
    const label: string = pick.slots.card.label;
    const labels: string[] = typed.resolve('chips', ids).map(c => c.label);
    expect([ids.length, label, labels[0]]).toEqual([4, 'none', 'What needs me?']);
  });

  it('rejects a default outside the registered set, and a slot name that could collide', () => {
    expect(() => surface({ slots: { ...slots, card: { ...slots.card, default: 'banner' } } })).toThrow(/default/);
    expect(() => surface({ slots: { ...slots, chips: { ...slots.chips, default: ['nope'] } } })).toThrow(/default/);
    expect(() => surface({ slots: { a__b: { ...slots.card }, a: { ...slots.chips, candidates: [{ id: 'b' }, { id: 'c' }], default: ['b'] } } })).toThrow(/no '__'/);
  });

  describe('shadow (the default mode)', () => {
    it('renders `default` in every slot and logs what Jev would have picked', async () => {
      const logs: SurfaceLog[] = [];
      const p = await surface().pick(quiet, { apiKey: 'k', sleep: noSleep, fetch: reply(jevAnswers) as never, onPick: l => { logs.push(l); } });
      expect(p.slots.chips).toMatchObject({ ids: ['what_needs_me', 'plan_today', 'recap_week', 'start_new'], source: 'default', reason: 'shadow' });
      expect(p.slots.card).toMatchObject({ label: 'none', source: 'default', reason: 'shadow' });
      expect(logs).toHaveLength(1);
      const log = logs[0];
      expect(log).toMatchObject({ surfaceId: 'cue.chat_empty', version: s0().version, ok: true });
      expect(log.slots.chips).toMatchObject({
        mode: 'shadow', rendered: ['what_needs_me', 'plan_today', 'recap_week', 'start_new'],
        jev: ['bills', 'recap_week', 'what_needs_me', 'plan_today'], agreed: false,
      });
      expect(log.slots.chips.confidences).toEqual({ what_needs_me: 0.9, plan_today: 0.9, recap_week: 0.9, start_new: 0.9, bills: 0.9 });
      expect(log.slots.card).toMatchObject({ mode: 'shadow', rendered: 'none', jev: 'overdue_items', agreed: false, confidences: { overdue_items: 0.95 } });
    });

    it('never shows Jev, however confident, and the log holds no state', async () => {
      const logs: SurfaceLog[] = [];
      const secret: State = { overdue: 3, weekday: 'SECRET-weekday' };
      const p = await surface().pick(secret, { apiKey: 'k', sleep: noSleep, fetch: reply({ ...jevAnswers, card: choiceA('unread_bills', 1) }) as never, onPick: l => { logs.push(l); } });
      expect(p.slots.card).toMatchObject({ label: 'none', source: 'default' });
      expect(JSON.stringify(logs)).not.toContain('SECRET');
    });

    it('no key ⇒ no call, no log, defaults; a failed call logs ok:false with no pick', async () => {
      let called = false;
      const logs: SurfaceLog[] = [];
      const none = await surface().pick(quiet, { apiKey: null, fetch: (async () => { called = true; return new Response('{}'); }) as never, onPick: l => { logs.push(l); } });
      expect(called).toBe(false);
      expect(logs).toHaveLength(0);
      expect(none.slots.chips).toMatchObject({ source: 'default', reason: 'no_key' });
      const failed = await surface().pick(quiet, { apiKey: 'k', sleep: noSleep, fetch: (async () => new Response('no', { status: 500 })) as never, onPick: l => { logs.push(l); } });
      expect(failed.slots.card).toMatchObject({ label: 'none', reason: 'call_failed' });
      expect(logs[0]).toMatchObject({ ok: false });
      expect(logs[0].slots.chips.jev).toBeNull();
    });

    it('a throwing onPick never fails the render; a state-dependent default is honoured', async () => {
      const s = surface({ slots: { ...slots, card: { ...slots.card, default: (st: State) => (st.overdue > 0 ? 'overdue_items' : 'none') } } });
      const p = await s.pick({ overdue: 2, weekday: 'Monday' }, { apiKey: 'k', sleep: noSleep, fetch: reply(jevAnswers) as never, onPick: () => { throw new Error('db down'); } });
      expect(p.slots.card).toMatchObject({ label: 'overdue_items', source: 'default' });
    });
  });

  describe('gated', () => {
    const gateFor = (slot: 'chips' | 'card', over: Partial<SlotGate> = {}): SlotGate => ({
      slot, fingerprint: s0().slotFingerprint(slot), minConfidence: 0.8731, evalRows: 742, heldOutAccuracy: 0.93, coverage: 0.81, ...over,
    });

    it('a gated slot without an eval gate does not define', () => {
      expect(() => surface({ slots: { ...slots, card: { ...slots.card, mode: 'gated' } } })).toThrow(/gateFromEval/);
    });

    it(`rejects a gate from fewer than ${MIN_GATE_EVAL_ROWS} labelled rows`, () => {
      expect(MIN_GATE_EVAL_ROWS).toBeGreaterThanOrEqual(700);
      expect(() => surface({ slots: { ...slots, card: { ...slots.card, mode: 'gated', gate: gateFor('card', { evalRows: 699 }) } } })).toThrow(/699/);
    });

    it('rejects a gate evaluated against a different question set, or another slot', () => {
      expect(() => surface({ slots: { ...slots, card: { ...slots.card, mode: 'gated', gate: gateFor('card', { fingerprint: 'abcdefabcdef' }) } } })).toThrow(/re-run/);
      expect(() => surface({ slots: { ...slots, card: { ...slots.card, mode: 'gated', gate: gateFor('chips') } } })).toThrow(/slot/);
    });

    it('applies a confident choice, keeps default below the gate, and gates slots independently', async () => {
      const s = surface({ slots: { ...slots, card: { ...slots.card, mode: 'gated', gate: gateFor('card') } } });
      const logs: SurfaceLog[] = [];
      const p = await s.pick(quiet, { apiKey: 'k', sleep: noSleep, fetch: reply(jevAnswers) as never, onPick: l => { logs.push(l); } });
      expect(p.slots.card).toMatchObject({ label: 'overdue_items', source: 'jev' });
      expect(p.slots.chips).toMatchObject({ source: 'default', reason: 'shadow' });
      expect(logs[0].slots.card).toMatchObject({ mode: 'gated', rendered: 'overdue_items', agreed: true });
      const low = await s.pick(quiet, { apiKey: 'k', sleep: noSleep, fetch: reply({ ...jevAnswers, card: choiceA('overdue_items', 0.8) }) as never });
      expect(p.slots.card.source).toBe('jev');
      expect(low.slots.card).toMatchObject({ label: 'none', source: 'default', reason: 'low_confidence' });
    });

    it('a gated rank slot orders by applied scores, filled from default, capped at max', async () => {
      const s = surface({ slots: { ...slots, chips: { ...slots.chips, mode: 'gated', gate: gateFor('chips') } } });
      const p = await s.pick(quiet, { apiKey: 'k', sleep: noSleep, fetch: reply({ ...jevAnswers, chips__bills: scoreA(1.9, 0.5) }) as never });
      // bills is below the gate, so it doesn't count and sorts after the applied ones.
      expect(p.slots.chips).toMatchObject({ source: 'jev', ids: ['recap_week', 'what_needs_me', 'plan_today', 'start_new'] });
      expect(s.resolve('chips', p.slots.chips.ids).map(c => c.label)).toEqual(['Recap my week', 'What needs me?', 'Plan today', 'Start something new']);
    });

    it('the gate is not part of the slot fingerprint, so a shadow eval can gate the slot', () => {
      const gated = surface({ slots: { ...slots, card: { ...slots.card, mode: 'gated', gate: gateFor('card') } } });
      expect(gated.slotFingerprint('card')).toBe(s0().slotFingerprint('card'));
    });
  });
});

describe('runSurfaceEval + gateFromEval', () => {
  // Rows with string ids: even-parity rows tune, odd-parity rows are held out.
  const makeRows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `row-${i}`, truth: i % 3 === 0 ? 'overdue_items' : 'none' }));
  // Jev answers right with confidence 0.97 on two thirds of rows, wrong at 0.61 on the rest.
  const evalFetch = async (_url: unknown, init?: { body?: string }) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    const st = (typeof body.state === 'string' ? JSON.parse(body.state) : body.state) as { t: string; n: number };
    const truth = st.t;
    const wrong = st.n % 3 === 1;
    return reply({ card: choiceA(wrong ? (truth === 'none' ? 'unread_bills' : 'none') : truth, wrong ? 0.61 : 0.97) })();
  };

  const evalRows = async (n: number) => runSurfaceEval({
    surface: s0() as unknown as Surface<{ t: string; n: number }>, slot: 'card', rows: makeRows(n),
    stateOf: r => ({ t: r.truth, n: Number(r.id.slice(4)) }),
    labelOf: r => r.truth, idOf: r => r.id,
    split: 'even-odd', run: { apiKey: 'k', sleep: noSleep, fetch: evalFetch as never },
  });

  it('scores every question of the slot in one call per row and reports both halves', async () => {
    const report = await evalRows(30);
    expect(report).toMatchObject({ surfaceId: 'cue.chat_empty', slot: 'card', fingerprint: s0().slotFingerprint('card') });
    expect(report.predictions).toHaveLength(30);
    expect(report.halves?.odd.n).toBe(report.predictions.filter(p => idParity(p.id) === 'odd').length);
  });

  it(`refuses to gate on fewer than ${MIN_GATE_EVAL_ROWS} held-out labelled rows`, async () => {
    const report = await evalRows(900); // ~450 held out
    expect(() => gateFromEval(report, { targetAccuracy: 0.95 })).toThrow(/held-out/);
  });

  it('takes the threshold from the held-out data (an observed confidence, not a round number)', async () => {
    const report = await evalRows(1600);
    const gate = gateFromEval(report, { targetAccuracy: 0.95 });
    expect(gate.slot).toBe('card');
    expect(gate.fingerprint).toBe(s0().slotFingerprint('card'));
    expect(gate.evalRows).toBeGreaterThanOrEqual(MIN_GATE_EVAL_ROWS);
    expect(gate.minConfidence).toBe(0.97);
    expect(gate.heldOutAccuracy).toBe(1);
    expect(gate.coverage).toBeCloseTo(2 / 3, 1);
    // …and the gate defines a gated slot.
    const s = surface({ slots: { ...slots, card: { ...slots.card, mode: 'gated', gate } } });
    expect(s.decision.policyOf('card')).toEqual({ mode: 'gated', minConfidence: 0.97 });
  });

  it('no threshold reaches the target ⇒ throws rather than inventing one', async () => {
    const report = await evalRows(1600);
    expect(() => gateFromEval(report, { targetAccuracy: 0.95, minCoverage: 0.9 })).toThrow(/target/);
  });
});

function s0() {
  return surface();
}
