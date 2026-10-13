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
  siblings: [] as Array<{ id: string; title: string }>,
  repoRefs: [{ path: 'docs/specs/checkout.md', sha: 'abcdef123456', href: 'https://github.com/acme/shop/blob/abc/docs/specs/checkout.md' }],
  design: null as any,
  comments: [] as any[],
  commentAnchors: [{ kind: 'criterion' as const, id: 'R-1', label: 'R-1' }],
  canComment: true,
  nearby: [] as any[],
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

  it('names the design the revision is built to, and says when it changed since approval', () => {
    const design = { label: 'Cart prototype', href: '/app/artifacts/a1', version: '3', screens: ['Empty cart'], changedSince: null };
    act(() => root.render(<SpecPage view={{ ...base, design }} />));
    const d = q('spec-page-design')!;
    expect(d.textContent).toContain('Built to the design Cart prototype, version 3.');
    expect(d.querySelector('a')!.getAttribute('href')).toBe('/app/artifacts/a1');
    expect(d.textContent).toContain('Screens: Empty cart');
    expect(q('spec-page-design-changed')).toBeNull();
    act(() => root.render(<SpecPage view={{ ...base, design: { ...design, changedSince: { pinned: '3', current: '5' } } }} />));
    expect(q('spec-page-design-changed')!.textContent).toBe('The design changed since approval: it is at version 5, and revision 1 was approved with version 3.');
    act(() => root.render(<SpecPage view={base} />));
    expect(q('spec-page-design')).toBeNull();
  });

  it('lists nearby specs with why each is near, strongest kind first', () => {
    const nearby = [
      { specId: 'n1', title: 'Refunds', kind: 'shares_files', score: 0.5, reason: "Changes 3 files this spec's work changed" },
      { specId: 'n2', title: 'Pricing', kind: 'similar', score: 0.7, reason: 'Similar in what it asks for' },
    ];
    act(() => root.render(<SpecPage view={{ ...base, nearby }} />));
    const items = [...container.querySelectorAll('[data-testid="spec-page-nearby-item"]')];
    expect(items.map((i) => [i.getAttribute('data-kind'), i.querySelector('a')!.getAttribute('href'), i.querySelector('span')!.textContent]))
      .toEqual([['shares_files', '/app/specs/n1', "Changes 3 files this spec's work changed"], ['similar', '/app/specs/n2', 'Similar in what it asks for']]);
    act(() => root.render(<SpecPage view={base} />));
    expect(q('spec-page-nearby')).toBeNull();
  });

  it('AC-83: the neighbour graph shows the spec, its parent, both siblings and 8 of 10 neighbours; the list is the default', () => {
    const siblings = [{ id: 's1', title: 'Refunds' }, { id: 's2', title: 'Invoices' }];
    const nearby = Array.from({ length: 10 }, (_, i) => ({ specId: `n${i}`, title: `Near ${i}`, kind: i < 2 ? 'overlaps' : 'similar', score: 0.9 - i / 20, reason: 'Similar in what it asks for' }));
    act(() => root.render(<SpecPage view={{ ...base, siblings, nearby }} />));
    // List first: parent, siblings and neighbours in words, no graph mounted.
    expect(q('spec-graph')).toBeNull();
    const list = q('spec-page-related-list')!;
    expect(list.querySelector('[data-testid="spec-page-parent"]')!.textContent).toContain('Shop');
    expect([...list.querySelectorAll('[data-testid="spec-page-siblings"] a')].map((a) => a.textContent)).toEqual(['Refunds', 'Invoices']);
    const radio = [...container.querySelectorAll('[role="radio"]')].find((b) => b.textContent === 'Graph') as HTMLElement;
    expect(container.querySelector('[role="radio"][aria-checked="true"]')!.textContent).toBe('List');
    act(() => radio.click());
    const nodes = [...container.querySelectorAll('[data-testid="spec-graph-node"]')];
    expect(nodes.map((n) => n.getAttribute('data-spec-id'))).toEqual(['parent-id', SPEC, 's1', 's2', 'n0', 'n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7']);
    expect(nodes.map((n) => n.getAttribute('data-relation'))).toEqual(['part of', 'this spec', 'sibling', 'sibling', 'overlaps', 'overlaps', ...Array(6).fill('similar')]);
    expect(q('spec-graph')!.textContent).toContain('2 more neighbours');
    // Below md the list stays in place of the graph (R-29).
    expect(q('spec-page-graph')!.className).toContain('hidden md:block');
    expect(list.className).toContain('md:hidden');
  });

  it('with no parent, siblings or neighbours, Related offers no graph', () => {
    act(() => root.render(<SpecPage view={{ ...base, parent: null }} />));
    expect([...container.querySelectorAll('[role="radio"]')]).toHaveLength(0);
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

  it('reads as approved on the press, before the server answers', async () => {
    let answer!: (r: Response) => void;
    globalThis.fetch = (() => new Promise<Response>(r => { answer = r; })) as unknown as typeof fetch;
    const review = { replaces: null, revision: 2, omittedLines: 0, sectionCount: 0, linesAdded: 0, linesRemoved: 0, body: base.body, hunks: [] };
    act(() => root.render(<SpecPage view={{ ...base, review }} />));
    expect(q('spec-page-review-panel')!.querySelector('h2')!.textContent).toBe('Revision 2 (nothing approved yet)');
    // Approve sits right under the heading, before the text: no scrolling to find it.
    const panel = q('spec-page-review-panel')!;
    const kids = [...panel.children];
    const approveAt = kids.findIndex((k) => k.querySelector('[data-testid="spec-page-approve"]'));
    expect(approveAt).toBe(1);
    await act(async () => { q('spec-page-approve')!.click(); });
    expect(q('spec-page-approve-result')!.textContent).toBe('Approved. Revision 2 is in force.');
    expect(q('spec-page-approve')).toBeNull();
    expect(refreshes).toBe(0);
    await act(async () => { answer(new Response(JSON.stringify({ spec: {}, revision: {} }), { status: 200 })); });
    expect(q('spec-page-approve-result')!.textContent).toBe('Approved. Revision 2 is in force.');
    expect(refreshes).toBe(1);
  });

  it('a failed approval rolls back to the action with the error beside it', async () => {
    let answer!: (r: Response) => void;
    globalThis.fetch = (() => new Promise<Response>(r => { answer = r; })) as unknown as typeof fetch;
    const review = { replaces: null, revision: 2, omittedLines: 0, sectionCount: 0, linesAdded: 0, linesRemoved: 0, body: base.body, hunks: [] };
    act(() => root.render(<SpecPage view={{ ...base, review }} />));
    await act(async () => { q('spec-page-approve')!.click(); });
    expect(q('spec-page-approve-result')!.textContent).toContain('Approved');
    await act(async () => { answer(new Response(JSON.stringify({}), { status: 500 })); });
    expect(q('spec-page-approve-result')!.textContent).toBe('Approval failed. Try again.');
    expect(q('spec-page-approve')).not.toBeNull();
    expect(refreshes).toBe(0);
  });

  it('a network failure rolls back the same way', async () => {
    globalThis.fetch = (async () => { throw new TypeError('offline'); }) as unknown as typeof fetch;
    const review = { replaces: null, revision: 2, omittedLines: 0, sectionCount: 0, linesAdded: 0, linesRemoved: 0, body: base.body, hunks: [] };
    act(() => root.render(<SpecPage view={{ ...base, review }} />));
    await act(async () => { q('spec-page-approve')!.click(); });
    expect(q('spec-page-approve-result')!.textContent).toBe('Approval failed. Try again.');
    expect(q('spec-page-approve')).not.toBeNull();
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
