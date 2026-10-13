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

const render = (specs: Input[], options?: Parameters<typeof SpecIndex>[0]['options'], accept?: Parameters<typeof SpecIndex>[0]['accept']) =>
  act(() => root.render(<SpecIndex specs={specs} options={{ now: now.getTime(), ...options }} accept={accept} />));

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
    const calls: Array<[string, string]> = [];
    render([
      draft('u1', null, { title: 'Invoices', suggestion: { kind: 'parent', specId: 'a1', title: 'Checkout', reason: 'Closest area by what it asks for' } }),
      area('a1', 'Checkout'), approved('f1', 'a1'),
      draft('u2', null, { suggestion: { kind: 'new_area', title: 'Billing' } }),
    ], undefined, async (id, parent) => { calls.push([id, parent]); return { ok: true }; });
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
    expect(calls).toEqual([['u1', 'a1']]);
    expect(u1.querySelector('[data-testid="spec-index-filed"]')!.textContent).toBe('Filed under Checkout.');
    click(unfiled.querySelector('[data-spec-id="u2"] [data-testid="spec-index-dismiss"]'));
    expect(unfiled.querySelector('[data-spec-id="u2"] [data-testid="spec-index-suggestion"]')).toBeNull();
  });

  it('AC-81: with every spec filed, no Unfiled group renders', () => {
    render([area('a1', 'Checkout'), approved('f1', 'a1'), draft('f2', 'a1')]);
    expect(q('[data-testid="spec-index-unfiled"]')).toBeNull();
  });

  it('nests children under a feature and says failing, imported and filed-by-buildd in words', () => {
    render([
      area('a1', 'Runners'),
      approved('f1', 'a1', { filedBy: 'buildd' }),
      approved('c1', 'f1', { failing: 'a pinned task failed AC-3' }),
      draft('f2', 'a1', { imported: true }),
    ]);
    const f1 = q('[data-spec-id="f1"]')!;
    expect(f1.querySelector('[data-testid="spec-index-children"] [data-spec-id="c1"]')).not.toBeNull();
    expect(f1.querySelector('[data-testid="spec-index-row-filed-by"]')!.textContent).toBe('Filed by buildd');
    expect(q('[data-spec-id="c1"] [data-testid="spec-index-row-failing"]')!.textContent).toBe('Failing: a pinned task failed AC-3');
    expect(q('[data-spec-id="f2"] [data-testid="spec-index-row-imported"]')!.textContent).toBe('Imported, awaiting confirmation');
    expect(q('[data-testid="spec-index-area-words"]')!.textContent).toBe('3 specs, 1 approved, 1 imported, 1 failing');
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
