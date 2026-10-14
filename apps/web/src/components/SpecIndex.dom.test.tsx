/**
 * The spec index, mounted (happy-dom), living-specs.md §19 AC-80..AC-89:
 * the outline groups by product and area with counts in words, Unfiled
 * comes last with each suggestion, the map sizes blocks by spec count with a
 * floor, collapses to one line with one area or none, and a tap filters the
 * outline in place.
 *
 * Runs in its own process (scripts/run-unit-tests.ts), so the DOM globals stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/workspaces/w/specs' });

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: SpecIndex } = await import('./SpecIndex');
const { MAP_BLOCK_MIN_WIDTH_PX, MAP_BLOCK_MIN_HEIGHT_PX } = await import('@/lib/specs/index-view');
type Input = import('@/lib/specs/index-view').SpecIndexInput;

let container: HTMLElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const now = new Date('2026-10-01T12:00:00Z');
const spec = (id: string, over: Partial<Input> = {}): Input => ({
  id, title: id, scope: 'feature', parentSpecId: null, status: 'draft', approvedRevision: null, headRevision: 1, updatedAt: now, ...over,
});
const approved = (id: string, parent: string | null, over: Partial<Input> = {}) => spec(id, { parentSpecId: parent, status: 'approved', approvedRevision: 1, ...over });
const draft = (id: string, parent: string | null, over: Partial<Input> = {}) => spec(id, { parentSpecId: parent, ...over });
const area = (id: string, title: string, parent: string | null = null) => spec(id, { title, scope: 'domain', parentSpecId: parent });

/** `n` approved features under `areaId`, named `<areaId>-<i>`. */
const many = (areaId: string, n: number) => Array.from({ length: n }, (_, i) => approved(`${areaId}-${i}`, areaId));

type Actions = import('./SpecIndex').IndexActions;
const render = (specs: Input[], options?: Parameters<typeof SpecIndex>[0]['options'], actions?: Partial<Actions>, canAct = true) =>
  act(() => root.render(<SpecIndex specs={specs} options={{ now: now.getTime(), ...options }} actions={actions} canAct={canAct} />));
/** Records every action; each answers ok. */
function recorder() {
  const calls: Array<[string, ...unknown[]]> = [];
  const ok = (name: string) => async (...a: unknown[]) => { calls.push([name, ...a]); return { ok: true }; };
  const actions: Actions = { acceptSuggestion: ok('accept'), dismissSuggestion: ok('dismiss'), undoFiling: ok('undo'), acceptProposal: ok('proposal'), confirmImports: ok('confirm') };
  return { calls, actions };
}

const q = (sel: string) => container.querySelector(sel);
const qa = (sel: string) => [...container.querySelectorAll(sel)];
const rowIds = (scope: Element | null) => [...(scope?.querySelectorAll(':scope > ul > [data-testid="spec-index-row"]') ?? [])].map((r) => r.getAttribute('data-spec-id'));
const click = (el: Element | null) => act(() => { (el as HTMLElement).click(); });

describe('SpecIndex outline', () => {
  it('AC-80: a product heads its areas; each area says its mix in words and lists its features', () => {
    render([
      spec('p', { title: 'Shop', scope: 'product' }),
      area('a1', 'Checkout', 'p'), area('a2', 'Catalog', 'p'),
      approved('f1', 'a1', { title: 'Totals' }), draft('f2', 'a1', { title: 'Refunds' }),
      approved('f3', 'a2'),
    ]);
    const product = q('[data-testid="spec-index-product"]')!;
    expect(product.getAttribute('data-product-id')).toBe('p');
    expect(product.textContent).toContain('Shop');
    const groups = qa('[data-testid="spec-index-area"]');
    expect(groups.map((g) => g.getAttribute('data-area-id'))).toEqual(['a1', 'a2']);
    expect(groups[0].querySelector('[data-testid="spec-index-area-words"]')!.textContent).toBe('2 specs, 1 approved, 1 draft');
    expect(rowIds(groups[0])).toEqual(['f1', 'f2']);
    expect(groups[0].textContent).toContain('feature · draft, never approved');
    expect(q('[data-testid="spec-index-unfiled"]')).toBeNull();
  });

  it('AC-21: a child sits under its parent and each row says where it stands in words', () => {
    render([
      area('a1', 'Checkout'),
      approved('f1', 'a1', { title: 'Totals', headRevision: 2 }),
      approved('c1', 'f1', { approvedRevision: 3, headRevision: 3 }),
      draft('f2', 'a1'),
    ]);
    const f1 = q('[data-spec-id="f1"]')!;
    expect(f1.querySelector('a')!.getAttribute('href')).toBe('/app/specs/f1');
    expect(f1.querySelector('[data-testid="spec-index-children"] [data-spec-id="c1"]')).not.toBeNull();
    expect(f1.querySelector('[data-testid="spec-index-standing"]')!.textContent).toContain('approved at revision 1');
    expect(f1.querySelector('[data-testid="spec-index-waiting"]')!.textContent).toBe('Revision 2 waiting for approval');
    expect(q('[data-spec-id="c1"] [data-testid="spec-index-waiting"]')).toBeNull();
    expect(q('[data-spec-id="f2"]')!.textContent).toContain('draft, never approved');
  });

  it('AC-50: a product heads its own group and a feature with no parent is Unfiled; with no product or area every spec is', () => {
    render([spec('p', { title: 'Shop', scope: 'product' }), approved('c', 'p'), draft('d', null)]);
    expect(q('[data-testid="spec-index-product"]')!.getAttribute('data-product-id')).toBe('p');
    expect(q('[data-testid="spec-index-area"]')!.getAttribute('data-area-id')).toBe('p');
    expect(rowIds(q('[data-testid="spec-index-area"]'))).toEqual(['c']);
    expect(rowIds(q('[data-testid="spec-index-unfiled"]'))).toEqual(['d']);
    render([draft('a', null), draft('b', null)]);
    expect(q('[data-testid="spec-index-product"]')).toBeNull();
    expect(rowIds(q('[data-testid="spec-index-unfiled"]'))).toEqual(['a', 'b']);
  });

  it('AC-81: what buildd could not place is Unfiled, last, with its suggestion and accept/dismiss', async () => {
    const { calls, actions } = recorder();
    const toCheckout = { kind: 'parent' as const, specId: 'a1', title: 'Checkout', reason: 'Closest area by what it asks for', filingId: 'fl1' };
    const billing = { kind: 'new_area' as const, title: 'Billing', filingId: 'fl2' };
    render([
      draft('u1', null, { title: 'Invoices', suggestion: toCheckout }),
      area('a1', 'Checkout'), approved('f1', 'a1'),
      draft('u2', null, { suggestion: billing }),
    ], undefined, actions);
    const outline = q('[data-testid="spec-index-outline"]')!;
    expect(outline.lastElementChild!.getAttribute('data-testid')).toBe('spec-index-unfiled');
    const unfiled = q('[data-testid="spec-index-unfiled"]')!;
    expect(rowIds(unfiled)).toEqual(['u1', 'u2']);
    const u1 = unfiled.querySelector('[data-spec-id="u1"]')!;
    expect(u1.querySelector('[data-testid="spec-index-suggestion"]')!.textContent).toContain('Suggested: under Checkout');
    expect(unfiled.querySelector('[data-spec-id="u2"] [data-testid="spec-index-suggestion"]')!.textContent).toContain('a new area, Billing');
    // A new-area suggestion has nothing to file under yet: dismiss only.
    expect(unfiled.querySelector('[data-spec-id="u2"] [data-testid="spec-index-accept"]')).toBeNull();
    await act(async () => { (u1.querySelector('[data-testid="spec-index-accept"]') as HTMLElement).click(); });
    expect(calls).toEqual([['accept', 'u1', toCheckout]]);
    expect(u1.querySelector('[data-testid="spec-index-filed"]')!.textContent).toBe('Filed under Checkout.');
    // Dismissing a recorded suggestion is recorded too (§17: the filing route), then it leaves the row.
    await act(async () => { (unfiled.querySelector('[data-spec-id="u2"] [data-testid="spec-index-dismiss"]') as HTMLElement).click(); });
    expect(calls[1]).toEqual(['dismiss', 'u2', billing]);
    expect(unfiled.querySelector('[data-spec-id="u2"] [data-testid="spec-index-suggestion"]')).toBeNull();
  });

  it('AC-81: with every spec filed, no Unfiled group renders', () => {
    render([area('a1', 'Checkout'), approved('f1', 'a1'), draft('f2', 'a1')]);
    expect(q('[data-testid="spec-index-unfiled"]')).toBeNull();
  });

  it('nests children under a feature and says failing, imported and filed-by-buildd in words', () => {
    render([
      area('a1', 'Runners'),
      approved('f1', 'a1', { filedBy: 'buildd', filingId: 'fl9' }),
      approved('c1', 'f1', { failing: 'a pinned task failed AC-3' }),
      draft('f2', 'a1', { imported: true }),
    ]);
    const f1 = q('[data-spec-id="f1"]')!;
    expect(f1.querySelector('[data-testid="spec-index-children"] [data-spec-id="c1"]')).not.toBeNull();
    expect(f1.querySelector('[data-testid="spec-index-row-filed-by"]')!.textContent).toBe('Filed by builddUndo');
    expect(q('[data-spec-id="c1"] [data-testid="spec-index-row-failing"]')!.textContent).toBe('Failing: a pinned task failed AC-3');
    expect(q('[data-spec-id="f2"] [data-testid="spec-index-row-imported"]')!.textContent).toBe('Imported, awaiting confirmation');
    expect(q('[data-testid="spec-index-area-words"]')!.textContent).toBe('3 specs, 1 approved, 1 imported, 1 failing');
  });
});

describe('SpecIndex filings (§17)', () => {
  it('"Filed by buildd" has an undo that names the filing, and says so in place', async () => {
    const { calls, actions } = recorder();
    render([area('a1', 'Runners'), approved('f1', 'a1', { filedBy: 'buildd', filingId: 'fl1' })], undefined, actions);
    await act(async () => { (q('[data-spec-id="f1"] [data-testid="spec-index-undo"]') as HTMLElement).click(); });
    expect(calls).toEqual([['undo', 'f1', 'fl1']]);
    expect(q('[data-testid="spec-index-undone"]')!.textContent).toContain('back where it was');
  });

  it('a reader without write access sees the words but no accept, dismiss or undo', () => {
    render([
      area('a1', 'Runners'), approved('f1', 'a1', { filedBy: 'buildd', filingId: 'fl1' }),
      draft('u1', null, { suggestion: { kind: 'parent', specId: 'a1', title: 'Runners', reason: 'r', filingId: 'fl2' } }),
    ], undefined, undefined, false);
    expect(q('[data-testid="spec-index-row-filed-by"]')!.textContent).toBe('Filed by buildd');
    expect(q('[data-testid="spec-index-suggestion"]')!.textContent).toContain('Suggested: under Runners');
    expect(q('[data-testid="spec-index-undo"]')).toBeNull();
    expect(q('[data-testid="spec-index-accept"]')).toBeNull();
    expect(q('[data-testid="spec-index-dismiss"]')).toBeNull();
  });

  it('with no area yet, the taxonomy proposal shows as possible areas under the line, each accepted by its key', async () => {
    const { calls, actions } = recorder();
    render(Array.from({ length: 12 }, (_, i) => draft(`u${i}`, null)), {
      proposals: [{ key: 'cooking', title: 'Cooking', specIds: ['u0', 'u1', 'u2'] }, { key: 'plans', title: 'Planning', specIds: ['u3', 'u4'] }],
    }, actions);
    expect(q('[data-testid="spec-index-map"]')).toBeNull();
    expect(q('[data-testid="spec-index-line"]')!.textContent).toBe('12 specs, none filed yet. buildd proposes 2 areas for them:');
    const groups = qa('[data-testid="spec-index-proposals"] [data-testid="spec-index-possible"]');
    expect(groups.map((g) => g.querySelector('[data-testid="spec-index-possible-label"]')!.textContent)).toEqual(['possible area: Cooking', 'possible area: Planning']);
    click(groups[0]);
    expect(rowIds(q('[data-testid="spec-index-unfiled"]'))).toEqual(['u0', 'u1', 'u2']);
    await act(async () => { (q('[data-testid="spec-index-possible-accept"]') as HTMLElement).click(); });
    expect(calls).toEqual([['proposal', 'cooking']]);
    expect(q('[data-testid="spec-index-possible-done"]')!.textContent).toContain('Cooking is an area now');
  });
});

describe('SpecIndex imports (§18, R-19)', () => {
  it('lists imported specs per area, and a person confirms one area in one act', async () => {
    const calls: unknown[] = [];
    const specs = [area('a1', 'Billing'), draft('f1', 'a1', { imported: true, title: 'Invoices' }), draft('f2', 'a1', { imported: true, title: 'Refunds' }), draft('f3', null, { imported: true, title: 'Loose' })];
    act(() => root.render(<SpecIndex specs={specs} options={{ now: now.getTime() }} canConfirm actions={{ confirmImports: async (ids) => { calls.push(ids); return { ok: true, confirmed: 1, stale: 1 }; } }} />));
    expect(q('[data-testid="spec-index-imported"] h2')!.textContent).toContain('Imported, waiting for confirmation');
    const groups = qa('[data-testid="spec-index-imported-group"]');
    expect(groups.map((g) => g.getAttribute('data-area-id'))).toEqual(['a1', '']);
    expect(groups[0]!.textContent).toContain('Billing: 2 specs');
    await act(async () => { (groups[0]!.querySelector('[data-testid="spec-index-confirm-imports"]') as HTMLElement).click(); });
    expect(calls).toEqual([['f1', 'f2']]);
    expect(groups[0]!.querySelector('[data-testid="spec-index-confirm-done"]')!.textContent).toContain('1 spec changed in the repo since the import');
  });

  it('a reader who cannot approve sees the imports but no confirm button; with none imported there is no group', () => {
    render([area('a1', 'Billing'), draft('f1', 'a1', { imported: true })]);
    expect(q('[data-testid="spec-index-imported"]')).not.toBeNull();
    expect(q('[data-testid="spec-index-confirm-imports"]')).toBeNull();
    render([area('a1', 'Billing'), draft('f1', 'a1')]);
    expect(q('[data-testid="spec-index-imported"]')).toBeNull();
  });
});

describe('filingFacts', () => {
  it('reads a filing in effect as Filed by buildd, an open suggestion as the suggestion, and nothing stale', async () => {
    const { filingFacts, proposalAreas } = await import('@/lib/specs/index-view');
    const base = { id: 'fl', source: 'model', p: 0.91, newArea: null };
    expect(filingFacts({ parentSpecId: 'a1' }, { ...base, kind: 'filed', status: 'applied', parent: { specId: 'a1', title: 'Runners' } })).toEqual({ filedBy: 'buildd', filingId: 'fl' });
    // Moved since buildd filed it: no claim, no undo.
    expect(filingFacts({ parentSpecId: 'a2' }, { ...base, kind: 'filed', status: 'applied', parent: { specId: 'a1', title: 'Runners' } })).toEqual({});
    expect(filingFacts({ parentSpecId: null }, { ...base, kind: 'suggested', status: 'open', parent: { specId: 'a1', title: 'Runners' } }))
      .toEqual({ suggestion: { kind: 'parent', specId: 'a1', title: 'Runners', reason: "buildd's area check, 91% sure", filingId: 'fl' } });
    expect(filingFacts({ parentSpecId: null }, { ...base, kind: 'suggested', status: 'open', parent: null, source: 'model', p: null, newArea: { title: 'Billing', charter: 'Money in' } }))
      .toEqual({ suggestion: { kind: 'new_area', title: 'Billing', reason: 'Money in', filingId: 'fl' } });
    expect(filingFacts({ parentSpecId: null }, { ...base, kind: 'suggested', status: 'open', parent: { specId: 'a1', title: 'R' }, source: 'similarity' }).suggestion)
      .toMatchObject({ reason: 'Closest area by what it asks for' });
    expect(filingFacts({ parentSpecId: null }, null)).toEqual({});
    expect(proposalAreas({ areas: [{ key: 'k', title: 'Cooking', members: [{ specId: 'u1' }] }] })).toEqual([{ key: 'k', title: 'Cooking', specIds: ['u1'] }]);
  });
});

describe('SpecIndex map', () => {
  it('AC-82: a failing outcome counts as failing in the map and the outline', () => {
    render([area('a1', 'Runners'), ...many('a1', 6), approved('bad', 'a1', { failing: 'outcome failed' }), area('a2', 'Billing'), ...many('a2', 3)]);
    const block = q('[data-testid="spec-index-block"][data-area-id="a1"]')!;
    expect(block.querySelector('[data-testid="spec-index-block-words"]')!.textContent).toBe('7 specs, 6 approved, 1 failing');
    expect(block.querySelector('[data-state="failing"]')).not.toBeNull();
    expect(q('[data-testid="spec-index-area"][data-area-id="a1"] [data-testid="spec-index-area-words"]')!.textContent).toBe('7 specs, 6 approved, 1 failing');
    expect(q('[data-testid="spec-index-legend"]')!.textContent).toContain('failing');
  });

  it('AC-85: blocks are sized by spec count, labelled in words, and the small one keeps the floor', () => {
    render([area('a1', 'Runners'), ...many('a1', 8), area('a2', 'Billing'), ...many('a2', 2)]);
    const [big, small] = qa('[data-testid="spec-index-block"]') as HTMLElement[];
    expect(big.getAttribute('data-area-id')).toBe('a1');
    // Wide: a share of all filed specs. Phone: a share of the largest area. Never grown to fill a row.
    expect(parseFloat(big.style.getPropertyValue('--block-share'))).toBe(80);
    expect(parseFloat(small.style.getPropertyValue('--block-share'))).toBe(20);
    expect(parseFloat(big.style.getPropertyValue('--block-rel'))).toBe(100);
    expect(parseFloat(small.style.getPropertyValue('--block-rel'))).toBe(25);
    expect(big.className).toContain('grow-0');
    expect(big.getAttribute('aria-label')).toContain('Runners · 8 specs, 8 approved');
    expect(small.getAttribute('aria-label')).toContain('Billing · 2 specs, 2 approved');
    expect(small.querySelector('[data-testid="spec-index-block-title"]')!.textContent).toBe('Billing');
    expect(small.style.minWidth).toBe(`${MAP_BLOCK_MIN_WIDTH_PX}px`);
    expect(MAP_BLOCK_MIN_HEIGHT_PX).toBeGreaterThanOrEqual(44);
    expect(small.style.minHeight).toBe(`${MAP_BLOCK_MIN_HEIGHT_PX}px`);
    // Two floors and the gap fit a 320px screen less its padding, so blocks wrap rather than scroll (AC-84).
    expect(MAP_BLOCK_MIN_WIDTH_PX * 2 + 8).toBeLessThanOrEqual(320 - 32);
    expect(q('[data-testid="spec-index-map"] > div')!.className).toContain('flex-wrap');
  });

  it('AC-86: two unfiled specs answering new_area "Billing" form a dashed group; the third is a loose dot', () => {
    render([
      area('a1', 'Runners'), ...many('a1', 4), area('a2', 'Checkout'), ...many('a2', 3),
      draft('u1', null, { suggestion: { kind: 'new_area', title: 'Billing' } }),
      draft('u2', null, { suggestion: { kind: 'new_area', title: 'billing ' } }),
      draft('u3', null),
    ]);
    const groups = qa('[data-testid="spec-index-possible"]');
    expect(groups).toHaveLength(1);
    expect(groups[0].querySelector('[data-testid="spec-index-possible-label"]')!.textContent).toBe('possible area: Billing');
    expect(groups[0].className).toContain('outline-dashed');
    expect([...groups[0].querySelectorAll('[data-testid="spec-index-dot"]')].map((d) => d.getAttribute('data-spec-id'))).toEqual(['u1', 'u2']);
    const loose = q('[data-testid="spec-index-loose"]')!;
    expect([...loose.querySelectorAll('[data-testid="spec-index-dot"]')].map((d) => d.getAttribute('data-spec-id'))).toEqual(['u3']);
    expect(loose.textContent).toContain('1 unfiled');
  });

  it('a taxonomy proposal area forms a possible group whose filter offers its accept action', () => {
    render([
      area('a1', 'Runners'), ...many('a1', 5), area('a2', 'Checkout'), ...many('a2', 3),
      draft('u1', null), draft('u2', null),
    ], { proposals: [{ title: 'Billing', specIds: ['u1', 'u2'], acceptHref: '/app/specs/proposal' }] });
    click(q('[data-testid="spec-index-possible"]'));
    expect(rowIds(q('[data-testid="spec-index-unfiled"]'))).toEqual(['u1', 'u2']);
    expect(q('[data-testid="spec-index-area"]')).toBeNull();
    expect(q('[data-testid="spec-index-possible-accept"]')!.getAttribute('href')).toBe('/app/specs/proposal');
  });

  it('AC-87: tapping a block filters the outline in place; a second tap shows all', () => {
    render([area('a1', 'Runners'), ...many('a1', 5), area('a2', 'Billing'), ...many('a2', 4), draft('u1', null)]);
    const path = window.location.pathname;
    const block = q('[data-testid="spec-index-block"][data-area-id="a2"]')!;
    click(block);
    expect(qa('[data-testid="spec-index-area"]').map((g) => g.getAttribute('data-area-id'))).toEqual(['a2']);
    expect(q('[data-testid="spec-index-unfiled"]')).toBeNull();
    expect(block.getAttribute('aria-pressed')).toBe('true');
    expect(q('[data-testid="spec-index-filter-line"]')!.textContent).toBe('Showing Billing only.');
    expect(window.location.pathname).toBe(path);
    click(block);
    expect(qa('[data-testid="spec-index-area"]').map((g) => g.getAttribute('data-area-id'))).toEqual(['a1', 'a2']);
    expect(q('[data-testid="spec-index-unfiled"]')).not.toBeNull();
    // The clear action does the same.
    click(block);
    click(q('[data-testid="spec-index-filter-clear"]'));
    expect(qa('[data-testid="spec-index-area"]')).toHaveLength(2);
    // The dot cloud filters to the unfiled specs.
    click(q('[data-testid="spec-index-loose"]'));
    expect(q('[data-testid="spec-index-area"]')).toBeNull();
    expect(rowIds(q('[data-testid="spec-index-unfiled"]'))).toEqual(['u1']);
  });

  it('AC-88: with one area, no map renders and one line states the counts', () => {
    render([area('a1', 'Runners'), ...many('a1', 9), draft('u1', null), draft('u2', null), draft('u3', null)]);
    expect(q('[data-testid="spec-index-map"]')).toBeNull();
    expect(q('[data-testid="spec-index-line"]')!.textContent).toBe('12 specs: 9 in Runners, 3 unfiled');
  });

  it('AC-88: with one area and nothing unfiled, the line says all are in it', () => {
    render([area('a1', 'Runners'), ...many('a1', 12)]);
    expect(q('[data-testid="spec-index-line"]')!.textContent).toBe('12 specs, all in Runners');
  });

  it('AC-88: with no area, the line says none are filed and links the taxonomy proposal', () => {
    render(Array.from({ length: 12 }, (_, i) => draft(`u${i}`, null)), { taxonomyHref: '/app/specs/taxonomy' });
    expect(q('[data-testid="spec-index-map"]')).toBeNull();
    const line = q('[data-testid="spec-index-line"]')!;
    expect(line.textContent).toContain('12 specs, none filed yet');
    expect(line.querySelector('a')!.getAttribute('href')).toBe('/app/specs/taxonomy');
  });

  it('AC-89: 10 specs in three areas render three labelled blocks', () => {
    render([area('a1', 'Runners'), ...many('a1', 5), area('a2', 'Billing'), ...many('a2', 3), area('a3', 'Specs'), ...many('a3', 2)]);
    const blocks = qa('[data-testid="spec-index-block"]');
    expect(blocks.map((b) => b.querySelector('[data-testid="spec-index-block-title"]')!.textContent)).toEqual(['Runners', 'Billing', 'Specs']);
    expect(blocks.every((b) => /\d+ specs?, /.test(b.querySelector('[data-testid="spec-index-block-words"]')!.textContent ?? ''))).toBe(true);
  });

  it('below about 10 specs, two areas still read as one line', () => {
    render([area('a1', 'Runners'), ...many('a1', 3), area('a2', 'Billing'), ...many('a2', 2)]);
    expect(q('[data-testid="spec-index-map"]')).toBeNull();
    expect(q('[data-testid="spec-index-line"]')!.textContent).toBe('5 specs: 3 in Runners, 2 in Billing');
  });

  it('AC-22: an empty workspace says how specs get made and shows no count', () => {
    render([]);
    const text = q('[data-testid="spec-list-empty"]')!.textContent ?? '';
    expect(text).toContain('MCP');
    expect(text).toContain('chat');
    expect(container.textContent).not.toMatch(/\d/);
  });
});

describe('titleLines', () => {
  it('breaks a graph title at words into two lines and marks a cut', async () => {
    const { titleLines } = await import('@/lib/specs/index-view');
    expect(titleLines('Step timers')).toEqual(['Step timers']);
    expect(titleLines('Scaling a recipe by servings')).toEqual(['Scaling a recipe by', 'servings']);
    expect(titleLines('Metric and imperial switch for the pantry shelves')).toEqual(['Metric and imperial', 'switch for the pantry…']);
    expect(titleLines('Supercalifragilisticexpialidocious')).toEqual(['Supercalifragilistice…']);
  });
});
