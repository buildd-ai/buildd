/**
 * Review all (spec b7fc9316 R-24 to R-26, AC-24 to AC-26) as rendered: one
 * line per waiting revision with its summary and a diff one tap away, one
 * Approve all, and pressing it sends one confirm request per revision, each
 * with its own signed request; a stale one is named and the rest approved.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/dev/fixtures?state=spec-review-all' });

import { afterEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

mock.module('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  usePathname: () => '/app/dev/fixtures',
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: SpecReviewAllFixture, SPEC_REVIEW_ALL_ROWS } = await import('./SpecReviewAllFixture');

async function render(v: string) {
  window.history.replaceState(null, '', `/app/dev/fixtures?state=spec-review-all&v=${v}`);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(<SpecReviewAllFixture />); });
  return { container, root };
}

let mounted: Array<{ container: HTMLElement; root: { unmount: () => void } }> = [];
const realFetch = globalThis.fetch;
afterEach(() => {
  for (const m of mounted) { act(() => m.root.unmount()); m.container.remove(); }
  mounted = [];
  globalThis.fetch = realFetch;
});

describe('Review all', () => {
  it('AC-24: lists each waiting revision with a one-line summary, a diff behind a toggle, and one Approve all', async () => {
    const m = await render('list');
    mounted.push(m);
    const rows = m.container.querySelectorAll('[data-testid="spec-review-all-row"]');
    expect(rows).toHaveLength(SPEC_REVIEW_ALL_ROWS.length);
    expect(rows[0]!.querySelector('[data-testid="spec-review-all-summary"]')!.textContent).toBe(SPEC_REVIEW_ALL_ROWS[0]!.summary!);
    // A revision with no summary says so rather than showing nothing.
    expect(rows[2]!.querySelector('[data-testid="spec-review-all-summary"]')!.textContent).toContain('No summary');
    expect(m.container.querySelectorAll('[data-testid="spec-review-all-diff"]')).toHaveLength(0);
    expect(m.container.querySelectorAll('[data-testid="spec-review-all-approve"]')).toHaveLength(1);
    expect(m.container.querySelector('[data-testid="spec-review-all-approve"]')!.textContent).toBe('Approve all 4');
  });

  it('opens a diff in place', async () => {
    const m = await render('diff');
    mounted.push(m);
    const diffs = m.container.querySelectorAll('[data-testid="spec-review-all-diff"]');
    expect(diffs).toHaveLength(1);
    expect(diffs[0]!.textContent).toContain('from the confirmation email');
  });

  it('AC-25, AC-26: Approve all sends one request per revision, each its own; one stale is named with its new head, the other three approved', async () => {
    const sent: Array<{ url: string; body: { request?: string } }> = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { request?: string };
      sent.push({ url, body });
      const stale = url.includes('fixture-spec-2');
      return new Response(JSON.stringify(stale ? { error: 'The spec changed since this approval was asked for.', code: 'request_stale', currentVersion: 9, headRevision: 6 } : { already: false }), { status: stale ? 409 : 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    const m = await render('list');
    mounted.push(m);
    const button = m.container.querySelector('[data-testid="spec-review-all-approve"]') as HTMLButtonElement;
    await act(async () => { button.click(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

    expect(sent.map((s) => s.url)).toEqual(SPEC_REVIEW_ALL_ROWS.map((r) => `/api/specs/${r.specId}/approve/confirm`));
    expect(sent.map((s) => s.body.request)).toEqual(SPEC_REVIEW_ALL_ROWS.map((r) => r.request));
    // No request names more than one revision.
    for (const s of sent) expect(Object.keys(s.body)).toEqual(['request']);

    const result = m.container.querySelector('[data-testid="spec-review-all-result"]')!.textContent!;
    expect(result).toContain('3 approved, 1 stale.');
    expect(result).toContain('Refunds to the original card, before and after packing changed since this page loaded (now at revision 6)');
    const outcomes = [...m.container.querySelectorAll('[data-testid="spec-review-all-row"]')].map((r) => r.getAttribute('data-outcome'));
    expect(outcomes).toEqual(['approved', 'stale', 'approved', 'approved']);
  });

  it('the result variant shows the same report without pressing anything', async () => {
    const m = await render('result');
    mounted.push(m);
    expect(m.container.querySelector('[data-testid="spec-review-all-result"]')!.textContent).toContain('1 stale');
    expect(m.container.querySelector('[data-testid="spec-review-all-approve"]')).toBeNull();
  });
});
