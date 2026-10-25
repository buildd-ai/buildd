import { describe, expect, it, mock } from 'bun:test';

mock.module('@buildd/core/db', () => ({ db: {} }));

const { specCard, specPairState, sideBySide, interpretRelation, checkSpecDuplicates, specDuplicateKind, DUPLICATE_BLOCK_P } = await import('./spec-duplicate-decision');
const { parseDuplicateOverride: parseOverride } = await import('./specs/duplicates');

const CART = '# Cart\nTotals and the empty state.\n- **AC-1** An empty cart shows the empty state.\n- **AC-2** Totals are in the shopper currency.\n';
const CART_AGAIN = '# Basket\nThe basket page.\n- **R-1** Prices in the buyer currency.\n- **AC-1** No items: show the empty basket message.\n';
const LOGIN = '# Sign in\n- **AC-1** A wrong password says so and keeps the email.\n';

describe('specCard and state', () => {
  it('keeps title, the first prose line and the criteria, in the measured format', () => {
    const c = specCard('Cart', CART);
    expect(c).toEqual({ title: 'Cart', summary: 'Totals and the empty state.', criteria: ['AC-1: An empty cart shows the empty state.', 'AC-2: Totals are in the shopper currency.'] });
    expect(specPairState({ a: c, b: specCard('Sign in', LOGIN) })).toBe('Spec A: Cart\nTotals and the empty state.\n- AC-1: An empty cart shows the empty state.\n- AC-2: Totals are in the shopper currency.\n\nSpec B: Sign in\n\n- AC-1: A wrong password says so and keeps the email.\n');
  });
});

describe('sideBySide (R-104: the judge reads the matched criteria side by side)', () => {
  it('puts the matched criteria first on both cards, in pair order, so the card cap never cuts them', () => {
    const a = specCard('Cart', CART);
    const b = specCard('Basket', CART_AGAIN);
    const { a: a2, b: b2 } = sideBySide({ a, b }, [{ here: 'AC-1', there: 'AC-1' }, { here: 'R-1', there: 'AC-2' }]);
    expect(a2.criteria).toEqual(['AC-1: An empty cart shows the empty state.', 'AC-2: Totals are in the shopper currency.']);
    expect(b2.criteria).toEqual(['AC-1: No items: show the empty basket message.', 'R-1: Prices in the buyer currency.']);
    expect(sideBySide({ a, b }, [])).toEqual({ a, b });
  });
});

describe('the decision kind', () => {
  it('asks the question the eval measured, live, under its own capability', async () => {
    expect(specDuplicateKind.binding).toMatchObject({ capability: 'spec_duplicate', mode: 'live' });
    // Measured beside Jev in the eval; Clef Flash matches the clef prefix, nothing else does.
    const { isMeasuredForKind } = await import('@buildd/core/decision-kinds');
    for (const m of ['clef', 'clef-flash', '@cf/cloudflare/clef', '@cf/cloudflare/clef-flash']) expect(isMeasuredForKind(specDuplicateKind.binding, m)).toBe(true);
    expect(isMeasuredForKind(specDuplicateKind.binding, 'openai/gpt-5-nano')).toBe(false);
    expect(specDuplicateKind.questions.relation.instructions).toContain('by what they REQUIRE, not by topic or wording');
    expect(Object.keys(specDuplicateKind.questions.relation.criteria)).toEqual(['duplicate', 'overlap', 'distinct']);
  });
  it('reads the chosen label and its probability', () => {
    expect(interpretRelation({ relation: { choice: 'duplicate', probabilities: { duplicate: 0.97, overlap: 0.02, distinct: 0.01 } } })).toMatchObject({ decision: 'duplicate', confidence: 0.97 });
    expect(interpretRelation({ relation: { choice: 'weird', probabilities: { distinct: 0.4 } } })).toMatchObject({ decision: 'distinct', confidence: 0.4 });
  });
});

describe('parseDuplicateOverride', () => {
  it('takes a spec id or a reason of 10+ characters', () => {
    expect(parseOverride({})).toBeNull();
    expect(parseOverride({ supersedes: '11111111-1111-4111-8111-111111111111' })).toEqual({ supersedes: '11111111-1111-4111-8111-111111111111' });
    expect(parseOverride({ distinctBecause: 'too short' })).toMatchObject({ error: expect.stringContaining('10 characters') });
    expect(parseOverride({ supersedes: 'cart' })).toMatchObject({ error: expect.any(String) });
  });
});

const response = (decision: string, confidence: number | null, source = 'model', fallbackCause: string | null = null) => ({ response: { decision, confidence, source, fallbackCause } as any, recordId: `rec-${decision}` });

describe('checkSpecDuplicates', () => {
  const cand = (specId: string, title: string, body: string, extra: Record<string, unknown> = {}) =>
    ({ specId, title, card: specCard(title, body), similarity: 0.8, draft: false, pairs: [] as Array<{ here: string; there: string }>, ...extra });
  const shortlist = async () => [cand('cart', 'Cart', CART, { pairs: [{ here: 'AC-1', there: 'AC-1' }] }), cand('login', 'Sign in', LOGIN)];
  const base = { teamOf: async () => 'team', shortlist };

  it('a duplicate at the bar blocks; one below, or an overlap, warns', async () => {
    const at = await checkSpecDuplicates({ workspaceId: 'w', title: 'Basket', body: CART_AGAIN }, { ...base, judge: async (p) => response(p.a.title === 'Cart' ? 'duplicate' : 'distinct', DUPLICATE_BLOCK_P) });
    expect(at).toMatchObject({ ran: true, blocking: [{ specId: 'cart', relation: 'duplicate', decisionRecordId: 'rec-duplicate' }], warnings: [] });
    const below = await checkSpecDuplicates({ workspaceId: 'w', title: 'Basket', body: CART_AGAIN }, { ...base, judge: async () => response('duplicate', 0.89) });
    expect(below).toMatchObject({ ran: true, blocking: [] });
    expect((below as any).warnings.length).toBeGreaterThan(0);
    const overlap = await checkSpecDuplicates({ workspaceId: 'w', title: 'Basket', body: CART_AGAIN }, { ...base, judge: async () => response('overlap', 0.7) });
    expect(overlap).toMatchObject({ ran: true, blocking: [] });
  });

  it('AC-141: the candidate names the matched pair, and the judge read those criteria first', async () => {
    const seen: string[] = [];
    const r = await checkSpecDuplicates({ workspaceId: 'w', title: 'Basket', body: CART_AGAIN }, {
      teamOf: async () => 'team',
      shortlist: async () => [cand('cart', 'Cart', CART, { pairs: [{ here: 'R-1', there: 'AC-2' }] })],
      judge: async (p) => { seen.push(p.a.criteria[0]!, p.b.criteria[0]!); return response('overlap', 0.8); },
    });
    expect(r).toMatchObject({ ran: true, warnings: [{ specId: 'cart', pairs: [{ here: 'R-1', there: 'AC-2' }] }] });
    expect(seen).toEqual(['AC-2: Totals are in the shopper currency.', 'R-1: Prices in the buyer currency.']);
  });

  it('R-106: a draft candidate is compared but only ever warns', async () => {
    const r = await checkSpecDuplicates({ workspaceId: 'w', title: 'Basket', body: CART_AGAIN }, {
      teamOf: async () => 'team', shortlist: async () => [cand('d', 'Cart draft', CART, { draft: true })], judge: async () => response('duplicate', 0.99),
    });
    expect(r).toMatchObject({ ran: true, blocking: [], warnings: [{ specId: 'd', relation: 'duplicate', draft: true }] });
  });

  it('R-105: a revise is judged on the criteria it added or changed only', async () => {
    let judged: string[] = [];
    let asked: unknown;
    await checkSpecDuplicates({ workspaceId: 'w', title: 'Basket', body: CART_AGAIN, criteria: ['AC-1'], excludeSpecId: 'me' }, {
      teamOf: async () => 'team',
      shortlist: async (input) => { asked = input; return [cand('cart', 'Cart', CART)]; },
      judge: async (p) => { judged = p.b.criteria; return response('overlap', 0.8); },
    });
    expect(asked).toMatchObject({ criteria: ['AC-1'], excludeSpecId: 'me' });
    expect(judged).toEqual(['AC-1: No items: show the empty basket message.']);
  });

  it('a model nobody measured, the capability off, or a throw lets the spec through and says why', async () => {
    expect(await checkSpecDuplicates({ workspaceId: 'w', title: 'Basket', body: CART_AGAIN }, { ...base, judge: async () => response('distinct', null, 'fallback', 'disabled') }))
      .toEqual({ ran: false, reason: 'spec duplicate checks are off for this team' });
    expect(await checkSpecDuplicates({ workspaceId: 'w', title: 'Basket', body: CART_AGAIN }, { ...base, judge: async () => response('distinct', null, 'fallback', 'no_provider') }))
      .toEqual({ ran: false, reason: 'this team has no decision model set up' });
    expect(await checkSpecDuplicates({ workspaceId: 'w', title: 'Basket', body: CART_AGAIN }, { ...base, judge: async () => { throw new Error('boom'); } }))
      .toEqual({ ran: false, reason: 'the duplicate check failed' });
  });

  it('nothing similar in the knowledge base: ran, nothing found, no model call', async () => {
    let calls = 0;
    expect(await checkSpecDuplicates({ workspaceId: 'w', title: 'x', body: CART }, { teamOf: async () => 'team', shortlist: async () => [], judge: async () => { calls++; return response('duplicate', 1); } }))
      .toEqual({ ran: true, blocking: [], warnings: [], compared: 0 });
    expect(calls).toBe(0);
  });
});
