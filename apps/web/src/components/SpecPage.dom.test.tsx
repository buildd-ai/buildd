/**
 * One spec's page, mounted (happy-dom), living-specs.md §9 AC-24/27: the
 * reading line names the revision and what waits; an approver reviewing the
 * waiting revision sends exactly one approve for that revision and version;
 * a reader who may not approve sees no approve action.
 *
 * Runs in its own process (scripts/run-unit-tests.ts), so the DOM globals stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app' });

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let refreshes = 0;
mock.module('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => { refreshes++; } }),
  usePathname: () => '/app/specs/x',
  useSearchParams: () => new URLSearchParams(),
}));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: SpecPage, readingLine } = await import('./SpecPage');

const SPEC = '11111111-1111-4111-8111-111111111111';
let container: HTMLElement;
let root: ReturnType<typeof createRoot>;
const realFetch = globalThis.fetch;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  refreshes = 0;
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  globalThis.fetch = realFetch;
});

const iso = new Date().toISOString();
const base = {
  state: 'ok' as const,
  spec: { id: SPEC, title: 'Checkout', scope: 'feature', status: 'draft', workspaceId: 'w', workspaceName: 'shop', version: 4, headRevision: 2, approvedRevision: 1 as number | null },
  standing: 'approved at revision 1',
  reading: { revision: 1, approved: true, isHead: false },
  waiting: 2 as number | null,
  body: '# Checkout\n\n- R-1: **Totals** in the shopper currency.\n',
  revisions: [
    { revision: 2, author: 'agent' as const, changeSummary: 'Pick the currency', approvedBy: null, approvedAt: null, createdAt: iso, createdAgo: '2h ago', approvedAgo: null },
    { revision: 1, author: 'person' as const, changeSummary: null, approvedBy: 'Max', approvedAt: iso, createdAt: iso, createdAgo: '3d ago', approvedAgo: '2d ago' },
  ],
  parent: { id: 'parent-id', title: 'Shop' } as { id: string; title: string } | null,
  children: [] as Array<{ id: string; title: string }>,
  repoRefs: [{ path: 'docs/specs/checkout.md', sha: 'abcdef123456', href: 'https://github.com/acme/shop/blob/abc/docs/specs/checkout.md' }],
  compare: null,
  canApprove: true,
  review: null as any,
};
const q = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

describe('readingLine', () => {
  it('names the approved revision and the one waiting', () => {
    expect(readingLine(base)).toBe("You're reading revision 1, the approved one. Revision 2 is waiting for approval.");
  });
  it('says nothing is approved yet for a never-approved draft', () => {
    expect(readingLine({ ...base, spec: { ...base.spec, approvedRevision: null }, reading: { revision: 2, approved: false, isHead: true }, waiting: 2 }))
      .toBe("You're reading revision 2, a draft. Nothing is approved yet.");
  });
  it('names the revision in force when reading another one', () => {
    expect(readingLine({ ...base, reading: { revision: 2, approved: false, isHead: true } }))
      .toBe("You're reading revision 2, which is not approved. Revision 1 is in force.");
  });
});

describe('SpecPage', () => {
  it('renders the approved revision, its history, parent and repo references', () => {
    act(() => root.render(<SpecPage view={base} />));
    expect(q('spec-page-reading')!.textContent).toContain('revision 1, the approved one');
    expect(q('spec-page-body')!.querySelector('strong')!.textContent).toBe('Totals');
    expect(q('spec-page-parent')!.querySelector('a')!.getAttribute('href')).toBe('/app/specs/parent-id');
    const ref = q('spec-page-repo-refs')!.querySelector('a')!;
    expect(ref.textContent).toBe('docs/specs/checkout.md @ abcdef123456');
    expect(ref.getAttribute('href')).toContain('/blob/abc/docs/specs/checkout.md');
    const revs = [...container.querySelectorAll('[data-testid="spec-page-revision"]')];
    expect(revs.map((r) => r.getAttribute('data-revision'))).toEqual(['2', '1']);
    expect(revs[0].textContent).toContain('by an agent');
    expect(revs[0].textContent).toContain('Pick the currency');
    expect(revs[1].querySelector('[data-testid="spec-page-approved-by"]')!.textContent).toContain('Approved by Max');
    expect(q('spec-page-review')!.getAttribute('href')).toBe(`/app/specs/${SPEC}?review=1`);
    expect(q('spec-page-approve')).toBeNull();
  });

  it('a reader who may not approve sees no approve action', () => {
    act(() => root.render(<SpecPage view={{ ...base, canApprove: false }} />));
    expect(q('spec-page-review')).toBeNull();
    expect(q('spec-page-approve')).toBeNull();
  });

  it('reviewing sends exactly one approve for the waiting revision at the rendered version', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ spec: {}, revision: {} }), { status: 200 });
    }) as typeof fetch;
    const review = {
      replaces: 1, revision: 2, omittedLines: 0, sectionCount: 1, linesAdded: 1, linesRemoved: 1, body: base.body,
      hunks: [{ kind: 'changed' as const, path: 'Checkout', linesAdded: 1, linesRemoved: 1, rows: [
        { op: '-' as const, oldLine: 3, newLine: null, text: 'old' },
        { op: '+' as const, oldLine: null, newLine: 3, text: 'new' },
      ] }],
    };
    act(() => root.render(<SpecPage view={{ ...base, review }} />));
    expect(q('spec-page-review')).toBeNull();
    expect(q('spec-approval-diff')).not.toBeNull();
    await act(async () => { q('spec-page-approve')!.click(); });
    expect(calls).toEqual([{ url: `/api/specs/${SPEC}/approve`, body: { revision: 2, expectedVersion: 4 } }]);
    expect(q('spec-page-approve-result')!.textContent).toContain('Revision 2 is in force');
    expect(refreshes).toBe(1);
  });

  it('a moved spec says so and approves nothing more', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: 'The spec changed while you were deciding: it is now at version 5. Re-read it before deciding.' }), { status: 409 })) as unknown as typeof fetch;
    const review = { replaces: null, revision: 2, omittedLines: 0, sectionCount: 0, linesAdded: 0, linesRemoved: 0, body: base.body, hunks: [] };
    act(() => root.render(<SpecPage view={{ ...base, review }} />));
    await act(async () => { q('spec-page-approve')!.click(); });
    expect(q('spec-page-approve-result')!.textContent).toContain('version 5');
    expect(q('spec-page-approve')).toBeNull();
  });
});
