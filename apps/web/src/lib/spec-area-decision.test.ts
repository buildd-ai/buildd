import { describe, expect, it, mock } from 'bun:test';

mock.module('@buildd/core/db', () => ({ db: {} }));

const {
  selectAreasForState, specAreaState, interpretArea, classifySpecArea, specAreaKind,
  AREA_FILE_P, AREA_SLOTS, TOP_SIMILAR_AREAS, BIG_AREA_MEMBERS, AREA_STATE_CHARS,
} = await import('./spec-area-decision');
const { specCard } = await import('./specs/card');
import type { AreaInfo } from './specs/areas';

const WS = 'ws-a';
const area = (id: string, title: string, charter: string, memberTitles: string[] = [], extra: Partial<AreaInfo> = {}): AreaInfo => ({
  id, workspaceId: WS, title, scope: 'domain', charter, memberCount: memberTitles.length, memberTitles, ...extra,
});
const PAYMENTS = area('pay', 'Payments', 'Charging cards, refunds and payouts.', ['Refunds', 'Card capture']);
const SEARCH = area('search', 'Search', 'Finding products by text and filters.', ['Facets']);
const ACCOUNTS = area('acct', 'Accounts', 'Sign in, profiles and passwords.', ['Password reset']);
const CARD = specCard('Partial refunds', '# Partial refunds\nRefund part of a card payment.\n- **AC-1** A refund of part of a payment returns that amount to the card.\n');

const answered = (choice: string, p: number, extra: Record<string, unknown> = {}) => ({
  judge: async (features: any) => ({ response: { decision: interpretArea({ area: { choice, probabilities: { [choice]: p } } }, features).decision, confidence: p, source: 'model', fallbackCause: null, model: 'typesafe/jev-1', ...extra } as any, recordId: 'rec-1' }),
  teamOf: async () => 'team',
});

describe('the state (R-6)', () => {
  it('AC-67: three areas are all in the state, with id order, title and charter', () => {
    const { areas, omitted } = selectAreasForState(CARD, [SEARCH, PAYMENTS, ACCOUNTS]);
    expect(areas.map((a) => a.id).sort()).toEqual(['acct', 'pay', 'search']);
    expect(omitted).toBe(0);
    const state = specAreaState({ card: CARD, areas, omitted });
    for (const a of [SEARCH, PAYMENTS, ACCOUNTS]) {
      expect(state).toContain(a.title);
      expect(state).toContain(a.charter);
    }
    expect(state).toContain('New spec: Partial refunds');
    expect(state).toContain('Holds 2 specs, such as: Refunds; Card capture.');
    expect(state).not.toContain('not shown');
  });

  it('AC-91: with 40 areas it holds the product, the most similar areas and every big one within the budget, and says how many it left out', () => {
    const product: AreaInfo = { ...area('prod', 'Shop', 'Everything the shop does.'), scope: 'product' };
    const many = Array.from({ length: 38 }, (_, i) => area(`a${i}`, `Area ${i} zebra${i}`, `Things about topic${i} only.`, [`Member ${i}`]));
    const big = area('big', 'Warehouse', 'Stock levels and shipping.', Array.from({ length: BIG_AREA_MEMBERS + 3 }, (_, i) => `Ship ${i}`));
    const { areas, omitted } = selectAreasForState(CARD, [...many, PAYMENTS, big, product]);
    expect(areas[0]!.id).toBe('prod');
    expect(areas[1]!.id).toBe('pay'); // the most similar area comes right after the product
    expect(areas.map((a) => a.id)).toContain('big'); // big, though not similar
    expect(areas.length).toBeLessThanOrEqual(Math.min(AREA_SLOTS, 1 + TOP_SIMILAR_AREAS + 1));
    expect(areas.length + omitted).toBe(41);
    const state = specAreaState({ card: CARD, areas, omitted });
    expect(state).toContain(`${omitted} more not shown`);
    expect(state.length).toBeLessThan(AREA_STATE_CHARS + 2600);
  });

  it('R-8: an area in another workspace is never in the state', () => {
    const foreign = area('far', 'Payments elsewhere', 'Charging cards, refunds and payouts.', [], { workspaceId: 'ws-b' });
    const { areas } = selectAreasForState(CARD, [PAYMENTS, foreign], { workspaceId: WS });
    expect(areas.map((a) => a.id)).toEqual(['pay']);
  });
});

describe('the decision kind (R-5)', () => {
  it('is live under its own capability, measured on Jev and Clef only', async () => {
    expect(specAreaKind.binding).toMatchObject({ capability: 'spec_area', mode: 'live' });
    const { isMeasuredForKind } = await import('@buildd/core/decision-kinds');
    for (const m of ['clef', 'clef-flash', '@cf/cloudflare/clef']) expect(isMeasuredForKind(specAreaKind.binding, m)).toBe(true);
    expect(isMeasuredForKind(specAreaKind.binding, 'openai/gpt-5-nano')).toBe(false);
    expect(Object.keys(specAreaKind.questions.area.criteria)).toEqual([...Array.from({ length: AREA_SLOTS }, (_, i) => `area_${i + 1}`), 'new_area', 'unsure']);
  });

  it('AC-69: a number past the list reads as unsure', () => {
    const f = { areas: [{ id: 'pay' }, { id: 'search' }] as any };
    expect(interpretArea({ area: { choice: 'area_2', probabilities: { area_2: 0.95 } } }, f)).toMatchObject({ decision: 'area_2', confidence: 0.95 });
    expect(interpretArea({ area: { choice: 'area_7', probabilities: { area_7: 0.99 } } }, f)).toMatchObject({ decision: 'unsure', reasonCode: 'model_out_of_list' });
    expect(interpretArea({ area: { choice: 'new_area', probabilities: { new_area: 0.8 } } }, f)).toMatchObject({ decision: 'new_area' });
  });
});

describe('classifySpecArea', () => {
  const input = { workspaceId: WS, specId: 'spec-1', card: CARD, areas: [SEARCH, PAYMENTS, ACCOUNTS] };

  it('AC-68: an area answer at the bar is confident and names that area', async () => {
    const { areas } = selectAreasForState(CARD, input.areas, { workspaceId: WS });
    const slot = `area_${areas.findIndex((a) => a.id === 'pay') + 1}`;
    const r = await classifySpecArea(input, answered(slot, AREA_FILE_P));
    expect(r).toMatchObject({ ran: true, answer: 'area', areaId: 'pay', confident: true, decisionRecordId: 'rec-1' });
    const low = await classifySpecArea(input, answered(slot, AREA_FILE_P - 0.01));
    expect(low).toMatchObject({ ran: true, answer: 'area', areaId: 'pay', confident: false });
  });

  it('AC-69: new_area and unsure are never confident', async () => {
    expect(await classifySpecArea(input, answered('new_area', 0.99))).toMatchObject({ ran: true, answer: 'new_area', areaId: null, confident: false });
    expect(await classifySpecArea(input, answered('unsure', 0.99))).toMatchObject({ ran: true, answer: 'unsure', confident: false });
  });

  it('the measured state is unchanged without a hint, even when areas declare domains', async () => {
    const pinned = specAreaState({ card: { title: 'Partial refunds', summary: 'Refund part of a card payment.', criteria: ['A refund returns that amount.'] }, areas: [
      { id: 'p', title: 'Shop', scope: 'product', charter: 'Everything the shop does.', members: [], memberCount: 0 },
      { id: 'pay', title: 'Payments', scope: 'domain', charter: 'Charging cards.', members: ['Refunds', 'Card capture'], memberCount: 2 },
    ], omitted: 3 });
    expect(pinned).toBe('New spec: Partial refunds\nRefund part of a card payment.\n- A refund returns that amount.\n\nAreas of this product (2 shown, 3 more not shown):\n'
      + '[1] Shop (the whole product): Everything the shop does. Holds no specs yet.\n'
      + '[2] Payments: Charging cards. Holds 2 specs, such as: Refunds; Card capture.\n');
    let seen: any = null;
    const judge = async (features: any) => { seen = features; return answered('unsure', 0.5).judge(features); };
    await classifySpecArea({ ...input, areas: [{ ...PAYMENTS, domains: ['payments'] }, SEARCH] }, { judge, teamOf: async () => 'team' });
    const state = specAreaState(seen);
    expect(state).not.toContain('domain');
    expect(seen.hint).toBeUndefined();
  });

  it('an import passes its domain and the areas\' declared domains as a hint in the state, the question unchanged', async () => {
    let seen: any = null;
    const judge = async (features: any) => { seen = features; return answered('unsure', 0.5).judge(features); };
    await classifySpecArea({ ...input, areas: [{ ...PAYMENTS, domains: ['payments', 'billing'] }, SEARCH], hint: { domain: 'billing' } }, { judge, teamOf: async () => 'team' });
    const state = specAreaState(seen);
    expect(state).toContain('The repo file names its domain: billing');
    expect(state).toContain('Payments: Charging cards, refunds and payouts. Holds 2 specs, such as: Refunds; Card capture. Declares domains: payments, billing.');
    expect(state).not.toContain('Search: Finding products by text and filters. Holds 1 spec, such as: Facets. Declares');
    // The measured question text (AREA_FILE_P was set on it) is not touched by the hint.
    expect(specAreaKind.questions.area.instructions).toBe('A team keeps its specs in one tree: the product, its areas, and the specs under each area. Decide which listed entry the New spec belongs under, by the part of the product it is about (the entry\'s description and the specs it already holds), not by shared words. Choose the whole-product entry only when no single area covers the spec. Choose a number only if that entry is in the list.');
  });

  it('AC-69/AC-70: an unmeasured model, no key, a provider error or a throw does not run, and says why', async () => {
    const fb = (cause: string) => ({ judge: async () => ({ response: { decision: 'unsure', confidence: null, source: 'fallback', fallbackCause: cause } as any, recordId: null }), teamOf: async () => 'team' });
    expect(await classifySpecArea(input, fb('unmeasured_model'))).toMatchObject({ ran: false, reason: expect.stringContaining('not measured') });
    expect(await classifySpecArea(input, fb('no_provider'))).toMatchObject({ ran: false, reason: expect.stringContaining('no decision-model key') });
    expect(await classifySpecArea(input, fb('provider_failure'))).toMatchObject({ ran: false });
    expect(await classifySpecArea(input, { teamOf: async () => 'team', judge: async () => { throw new Error('boom'); } })).toEqual({ ran: false, reason: 'the area check failed' });
    expect(await classifySpecArea({ ...input, areas: [] }, answered('area_1', 1))).toMatchObject({ ran: false, reason: 'the workspace has no areas' });
  });
});
