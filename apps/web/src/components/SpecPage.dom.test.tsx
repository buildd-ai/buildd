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
const { default: SpecPage, readingLine, withoutRepeatedTitle } = await import('./SpecPage');
const { askButtonHiddenSnapshot } = await import('@/lib/ask-button-hidden');

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
  filing: null as any,
  compare: null,
  canApprove: true,
  review: null as any,
};
const q = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

describe('readingLine', () => {
  it('says nothing when reading the approved revision with nothing waiting: the header already says it', () => {
    expect(readingLine({ ...base, waiting: null })).toBeNull();
  });
  it('names only what waits when reading the approved revision', () => {
    expect(readingLine({ ...base, canApprove: false })).toBe('Revision 2 waits for approval.');
    expect(readingLine(base)).toBe('Revision 2 waits for your approval.');
  });
  it('says nothing is approved yet for a never-approved draft', () => {
    expect(readingLine({ ...base, spec: { ...base.spec, approvedRevision: null }, reading: { revision: 2, approved: false, isHead: true }, waiting: 2 }))
      .toBe('Nothing is approved yet.');
  });
  it('names the approved revision when reading another one', () => {
    expect(readingLine({ ...base, reading: { revision: 2, approved: false, isHead: true } }))
      .toBe('This is revision 2. Revision 1 is the approved one.');
  });
});

describe('withoutRepeatedTitle', () => {
  it('drops a first heading that only repeats the title, and keeps any other', () => {
    expect(withoutRepeatedTitle('# Checkout\n\nBody', 'Checkout')).toBe('Body');
    expect(withoutRepeatedTitle('# **Checkout**\nBody', 'checkout')).toBe('Body');
    expect(withoutRepeatedTitle('# Overview\n\nBody', 'Checkout')).toBe('# Overview\n\nBody');
    expect(withoutRepeatedTitle('Intro\n# Checkout', 'Checkout')).toBe('Intro\n# Checkout');
  });
});

describe('SpecPage', () => {
  it('renders the approved revision, its history, parent and repo references', () => {
    act(() => root.render(<SpecPage view={base} />));
    expect(q('spec-page-reading')!.textContent).toBe('Revision 2 waits for your approval.');
    expect(q('spec-page-body')!.querySelector('strong')!.textContent).toBe('Totals');
    // The body's own "# Checkout" would repeat the page title right under it.
    expect(q('spec-page-body')!.querySelector('h1')).toBeNull();
    expect(q('spec-page-parent')!.querySelector('a')!.getAttribute('href')).toBe('/app/specs/parent-id');
    const ref = q('spec-page-repo-refs')!.querySelector('a')!;
    expect(ref.textContent).toBe('docs/specs/checkout.md @ abcdef123456');
    expect(ref.getAttribute('href')).toContain('/blob/abc/docs/specs/checkout.md');
    const revs = [...container.querySelectorAll('[data-testid="spec-page-revision"]')];
    expect(revs.map((r) => r.getAttribute('data-revision'))).toEqual(['2', '1']);
    expect(revs[0].textContent).toContain('by an agent');
    expect(revs[0].textContent).toContain('Pick the currency');
    expect(revs[1].querySelector('[data-testid="spec-page-approved-by"]')!.textContent).toContain('Approved by Max');
    expect(revs[1].textContent).toContain('in force');
    expect(revs[0].textContent).toContain('waiting');
    expect(revs[1].querySelector('a')!.getAttribute('aria-current')).toBe('page');
    expect(revs[0].querySelector('a')!.getAttribute('aria-current')).toBeNull();
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

  it('with nothing related, there is no Related heading at all', () => {
    act(() => root.render(<SpecPage view={{ ...base, parent: null, repoRefs: [] }} />));
    expect([...container.querySelectorAll('h2')].map((h) => h.textContent)).not.toContain('Related');
    expect(q('spec-page-related-list')).toBeNull();
    act(() => root.render(<SpecPage view={base} />));
    expect([...container.querySelectorAll('h2')].map((h) => h.textContent)).toContain('Related');
  });

  it('with no parent, siblings or neighbours, Related offers no graph', () => {
    act(() => root.render(<SpecPage view={{ ...base, parent: null }} />));
    expect([...container.querySelectorAll('[role="radio"]')]).toHaveLength(0);
  });

  it('says "Filed by buildd" with an undo that posts that filing, and a suggestion with accept and dismiss (§17 R-7)', async () => {
    const calls: Array<{ url: string; body: any }> = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ filing: null }), { status: 200 });
    }) as typeof fetch;
    const filed = { id: 'f1', kind: 'filed', status: 'applied', parent: { specId: 'area-1', title: 'Payments' }, previousParent: null, source: 'model', p: 0.97, newArea: null, createdAt: iso };
    act(() => root.render(<SpecPage view={{ ...base, filing: filed }} />));
    expect(q('spec-page-filing')!.textContent).toContain('Filed by buildd under Payments');
    expect(q('spec-page-filing')!.querySelector('a')!.getAttribute('href')).toBe('/app/specs/area-1');
    await act(async () => { q('spec-page-filing-undo')!.click(); });
    expect(calls).toEqual([{ url: `/api/specs/${SPEC}/filing`, body: { action: 'undo', filingId: 'f1' } }]);
    expect(refreshes).toBe(1);

    act(() => root.render(<SpecPage view={{ ...base, filing: { ...filed, id: 'f2', kind: 'suggested', status: 'open' } }} />));
    expect(q('spec-page-filing')!.textContent).toContain('buildd suggests filing this under Payments');
    expect(q('spec-page-filing-undo')).toBeNull();
    await act(async () => { q('spec-page-filing-accept')!.click(); });
    expect(calls[1]).toEqual({ url: `/api/specs/${SPEC}/filing`, body: { action: 'accept', filingId: 'f2' } });

    act(() => root.render(<SpecPage view={{ ...base, canComment: false, filing: filed }} />));
    expect(q('spec-page-filing-undo')).toBeNull();
    act(() => root.render(<SpecPage view={base} />));
    expect(q('spec-page-filing')).toBeNull();
  });

  it('the approval holds the Ask corner: the Ask button hides while it shows, and comes back after', () => {
    act(() => root.render(<SpecPage view={base} />));
    expect(q('spec-page-action-dock')!.querySelector('[data-testid="spec-page-review"]')).not.toBeNull();
    expect(askButtonHiddenSnapshot()).toBe(true);
    act(() => root.render(<SpecPage view={{ ...base, waiting: null }} />));
    expect(q('spec-page-action-dock')).toBeNull();
    expect(askButtonHiddenSnapshot()).toBe(false);
  });

  it('with nothing waiting, reading the approved revision has no reading line', () => {
    act(() => root.render(<SpecPage view={{ ...base, waiting: null }} />));
    expect(q('spec-page-reading')).toBeNull();
  });

  it('a reader who may not approve sees no approve action', () => {
    act(() => root.render(<SpecPage view={{ ...base, canApprove: false }} />));
    expect(q('spec-page-review')).toBeNull();
    expect(q('spec-page-approve')).toBeNull();
    expect(askButtonHiddenSnapshot()).toBe(false);
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

  it('names the one source and says when the repo copy is behind (living-specs.md §18, R-13, AC-79)', () => {
    act(() => root.render(<SpecPage view={base} />));
    expect(q('spec-page-source')).toBeNull();
    const source = { source: 'Source: buildd, repo copy at docs/specs/checkout.md', copy: 'Repo copy is behind: Lint specs failed on PR #9.', behind: true };
    act(() => root.render(<SpecPage view={{ ...base, source }} />));
    expect(q('spec-page-source')!.textContent).toBe('Source: buildd, repo copy at docs/specs/checkout.md');
    expect(q('spec-page-repo-copy')!.textContent).toContain('Lint specs failed');
  });

  it('shows a failing repo check on review and still offers Approve (R-34, AC-96)', () => {
    const review = { replaces: null, revision: 2, omittedLines: 0, sectionCount: 0, linesAdded: 0, linesRemoved: 0, body: base.body, hunks: [] };
    const preflight = { state: 'ran' as const, path: 'docs/specs/checkout.md', checks: [
      { name: 'specs:lint' as const, ok: false, messages: ['frontmatter missing `summary` (one sentence: what MUST hold)'] },
      { name: 'public-docs:check' as const, ok: true, messages: [] },
      { name: 'no-prod-data' as const, ok: true, messages: [], note: 'The identifier half runs only in CI.' },
    ] };
    act(() => root.render(<SpecPage view={{ ...base, review, preflight }} />));
    expect(q('spec-repo-checks')!.textContent).toContain('fails specs:lint');
    expect(q('spec-repo-checks')!.textContent).toContain('frontmatter missing `summary`');
    expect(q('spec-page-approve')).not.toBeNull();
  });
});

describe('Delivery and verification (Slice 13, R-61, AC-48)', () => {
  const T = '22222222-2222-4222-8222-222222222222';
  const entry = {
    kind: 'task' as const, id: T, title: 'Show totals in euros', href: `/app/tasks/${T}`,
    builtTo: 1, provisional: false, delivered: true, deliveredText: 'Built to revision 1 and delivered.',
    standing: { tone: 'muted' as const, text: 'Not verified yet against revision 2.' },
    criteria: [{ criterionId: 'R-1', text: 'Totals in the shopper currency.', mark: 'pass' as const, evidence: [{ label: 'ci', href: 'https://example.test/run/1' }] }],
    links: [{ label: 'PR #12', href: 'https://github.com/acme/shop/pull/12' }],
    at: iso,
  };

  it('AC-48: no entries, no section, no heading and no jump link', () => {
    act(() => root.render(<SpecPage view={{ ...base, delivery: { entries: [], next: null } }} />));
    expect(q('spec-delivery')).toBeNull();
    expect(container.textContent).not.toContain('Delivery and verification');
    expect(container.querySelector('a[href="#delivery"]')).toBeNull();
    act(() => root.render(<SpecPage view={{ ...base, delivery: null }} />));
    expect(q('spec-delivery')).toBeNull();
  });

  it('lists each entry once, linking to its task, with delivery and standing on separate lines', () => {
    act(() => root.render(<SpecPage view={{ ...base, delivery: { entries: [entry], next: null } }} />));
    expect(container.querySelectorAll('[data-testid="spec-delivery-entry"]')).toHaveLength(1);
    expect(q('spec-delivery-link')?.getAttribute('href')).toBe(`/app/tasks/${T}`);
    expect(q('spec-delivery-delivered')?.textContent).toContain('Built to revision 1 and delivered.');
    expect(q('spec-delivery-standing')?.textContent).toBe('Not verified yet against revision 2.');
    expect(container.querySelector('a[href="#delivery"]')).not.toBeNull();
    expect(q('spec-delivery-more')).toBeNull();
    // It sits in the main column, before Related, and leaves Revisions in the rail alone.
    const main = q('spec-page-body')!.parentElement!;
    expect(main.contains(q('spec-delivery'))).toBe(true);
    expect(container.querySelector('aside')!.contains(q('spec-delivery'))).toBe(false);
    expect(container.textContent).not.toContain('—');
  });

  it('opening an entry shows the criteria it answered for and their evidence (R-64)', () => {
    act(() => root.render(<SpecPage view={{ ...base, delivery: { entries: [entry], next: 'c' } }} />));
    expect(q('spec-delivery-criteria')).toBeNull();
    const toggle = q('spec-delivery-entry')!.querySelector('button')!;
    act(() => toggle.click());
    expect(q('spec-delivery-criterion')?.textContent).toContain('Passes');
    expect(q('spec-delivery-evidence')?.querySelector('a')?.getAttribute('href')).toBe('https://example.test/run/1');
    expect(q('spec-delivery-more')?.getAttribute('href')).toBe(`/app/specs/${SPEC}?delivery=c#delivery`);
  });
});
