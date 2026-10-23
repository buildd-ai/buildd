/**
 * The spec page fixture shows what Visual QA cannot get from the scrubbed
 * clone: a spec body with six sections and Contents, the four page states,
 * no empty Comments or Files tab, and the /approve page's replaces line.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/dev/fixtures?state=spec-page' });

import { afterEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

mock.module('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  usePathname: () => '/app/dev/fixtures',
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: SpecPageFixture, SPEC_PAGE_VARIANTS, SPEC_PAGE_FIXTURE_BODY, SPEC_PAGE_APPROVAL_VIEW, parseSpecPageVariant } = await import('./SpecPageFixture');

async function render(v: string) {
  window.history.replaceState(null, '', `/app/dev/fixtures?state=spec-page&v=${v}`);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(<SpecPageFixture />); });
  return { container, root };
}

let mounted: Array<{ container: HTMLElement; root: { unmount: () => void } }> = [];
afterEach(() => {
  for (const m of mounted) { act(() => m.root.unmount()); m.container.remove(); }
  mounted = [];
});

describe('SpecPageFixture', () => {
  it('has six numbered sections and a body long enough to scroll', () => {
    expect(SPEC_PAGE_FIXTURE_BODY.match(/^## \d+\. /gm)).toHaveLength(6);
    expect(SPEC_PAGE_FIXTURE_BODY.split('\n').length).toBeGreaterThan(60);
  });

  it('ends every requirement with one full stop', () => {
    const reqs = SPEC_PAGE_FIXTURE_BODY.split('\n').filter((l) => /^- (R|AC)-\d+: /.test(l));
    expect(reqs).toHaveLength(18);
    for (const r of reqs) expect(r).toMatch(/[^.]\.$/);
  });

  it('approve-replaces: the diff has no empty added line', () => {
    const rows = SPEC_PAGE_APPROVAL_VIEW.hunks.flatMap((h) => h.rows);
    expect(rows.filter((r) => r.text.trim() === '')).toEqual([]);
    for (const h of SPEC_PAGE_APPROVAL_VIEW.hunks) {
      expect(h.linesAdded).toBe(h.rows.filter((r) => r.op === '+').length);
      expect(h.linesRemoved).toBe(h.rows.filter((r) => r.op === '-').length);
    }
  });

  it('falls back to approved for an unknown variant', () => {
    expect(parseSpecPageVariant(null)).toBe('approved');
    expect(parseSpecPageVariant('nope')).toBe('approved');
    expect(parseSpecPageVariant('retired')).toBe('retired');
  });

  for (const v of SPEC_PAGE_VARIANTS.filter((x) => x !== 'approve-replaces')) {
    it(`${v}: renders the body text, Contents, and no empty Comments or Files tab`, async () => {
      const m = await render(v);
      mounted.push(m);
      const { container } = m;
      expect(container.querySelector('[data-testid="spec-page-fixture"]')!.getAttribute('data-variant')).toBe(v);
      expect(container.textContent).toContain('A shopper places an order from a cart');
      expect(container.textContent).toContain('Gift cards, split payments');
      expect(container.querySelector('[data-testid="spec-page-contents"]')).not.toBeNull();
      const tabs = [...container.querySelectorAll('[role="tab"]')].map((t) => t.getAttribute('data-tab'));
      expect(tabs).not.toContain('comments');
      expect(tabs).not.toContain('files');
    });
  }

  it('says each state on the status line', async () => {
    const said: Record<string, string> = {};
    for (const v of ['waiting', 'retired', 'imported']) {
      const m = await render(v);
      mounted.push(m);
      said[v] = m.container.textContent ?? '';
    }
    expect(said.waiting).toContain('Revision 3 waiting');
    expect(said.retired).toContain('Replaced by');
    expect(said.imported).toContain('Repo file is the source until you confirm');
    expect(mounted[2]!.container.querySelector('[data-testid="spec-page-confirm-import"]')).not.toBeNull();
  });

  it('approve-replaces: the /approve page offers to retire each replaced spec above Approve', async () => {
    const m = await render('approve-replaces');
    mounted.push(m);
    const items = [...m.container.querySelectorAll('[data-testid="spec-approve-replaced-item"]')];
    expect(items.map((i) => i.textContent)).toEqual([
      'Replaces Order cancellation (2025). Retire it.',
      'Replaces Refunds to the original card, before and after packing. Retire it.',
    ]);
    expect(m.container.querySelector('[data-testid="spec-approval-approve"]')!.textContent).toBe('Approve and retire');
    expect(m.container.textContent).not.toContain('This approval link is not valid.');
  });
});
