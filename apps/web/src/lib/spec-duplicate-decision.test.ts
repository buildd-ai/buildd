import { describe, expect, it, mock } from 'bun:test';

mock.module('@buildd/core/db', () => ({ db: {} }));

const { tfidfShortlist, specCard, specPairState, interpretRelation, checkSpecDuplicates, specDuplicateKind, DUPLICATE_BLOCK_P } = await import('./spec-duplicate-decision');
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

describe('tfidfShortlist', () => {
  it('ranks the related spec first and drops what shares nothing', () => {
    const pool = [{ id: 'login', card: specCard('Sign in', LOGIN) }, { id: 'cart', card: specCard('Cart', CART) }, { id: 'none', card: specCard('Zebra', '- AC-1: Xylophone quartz.') }];
    const got = tfidfShortlist(specCard('Cart page', CART), pool);
    expect(got[0]!.id).toBe('cart');
    expect(got.map((g) => g.id)).not.toContain('none');
  });
  it('keeps at most k', () => {
    const pool = Array.from({ length: 9 }, (_, i) => ({ id: String(i), card: specCard(`Cart ${i}`, CART) }));
    expect(tfidfShortlist(specCard('Cart', CART), pool)).toHaveLength(5);
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
  const approved = async () => [
    { specId: 'cart', title: 'Cart', card: specCard('Cart', CART) },
    { specId: 'login', title: 'Sign in', card: specCard('Sign in', LOGIN) },
  ];
  const base = { teamOf: async () => 'team', approved };

  it('a duplicate at the bar blocks; one below, or an overlap, warns', async () => {
    const at = await checkSpecDuplicates({ workspaceId: 'w', title: 'Basket', body: CART_AGAIN }, { ...base, judge: async (p) => response(p.a.title === 'Cart' ? 'duplicate' : 'distinct', DUPLICATE_BLOCK_P) });
    expect(at).toMatchObject({ ran: true, blocking: [{ specId: 'cart', relation: 'duplicate', decisionRecordId: 'rec-duplicate' }], warnings: [] });
    const below = await checkSpecDuplicates({ workspaceId: 'w', title: 'Basket', body: CART_AGAIN }, { ...base, judge: async () => response('duplicate', 0.89) });
    expect(below).toMatchObject({ ran: true, blocking: [] });
    expect((below as any).warnings.length).toBeGreaterThan(0);
    const overlap = await checkSpecDuplicates({ workspaceId: 'w', title: 'Basket', body: CART_AGAIN }, { ...base, judge: async () => response('overlap', 0.7) });
    expect(overlap).toMatchObject({ ran: true, blocking: [] });
  });

  it('a model nobody measured, the capability off, or a throw lets the spec through and says why', async () => {
    expect(await checkSpecDuplicates({ workspaceId: 'w', title: 'Basket', body: CART_AGAIN }, { ...base, judge: async () => response('distinct', null, 'fallback', 'disabled') }))
      .toEqual({ ran: false, reason: 'spec duplicate checks are off for this team' });
    expect(await checkSpecDuplicates({ workspaceId: 'w', title: 'Basket', body: CART_AGAIN }, { ...base, judge: async () => { throw new Error('boom'); } }))
      .toEqual({ ran: false, reason: 'the duplicate check failed' });
  });

  it('no approved spec to compare with: ran, nothing found, no model call', async () => {
    let calls = 0;
    expect(await checkSpecDuplicates({ workspaceId: 'w', title: 'x', body: CART }, { teamOf: async () => 'team', approved: async () => [], judge: async () => { calls++; return response('duplicate', 1); } }))
      .toEqual({ ran: true, blocking: [], warnings: [], compared: 0 });
    expect(calls).toBe(0);
  });
});
