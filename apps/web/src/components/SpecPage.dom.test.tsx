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
let navigations = 0;
// As under the App Router: a native pushState reaches useSearchParams, with no server render.
const searchListeners = new Set<() => void>();
const nativePush = window.history.pushState.bind(window.history);
window.history.pushState = (data: unknown, unused: string, url?: string | URL | null) => {
  nativePush(data, unused, url);
  for (const l of searchListeners) l();
};
mock.module('next/navigation', () => ({
  useRouter: () => ({ push: () => { navigations++; }, replace: () => { navigations++; }, refresh: () => { refreshes++; } }),
  usePathname: () => '/app/specs/x',
  useSearchParams: () => new URLSearchParams((require('react') as typeof import('react')).useSyncExternalStore(
    (l) => { searchListeners.add(l); return () => { searchListeners.delete(l); }; },
    () => window.location.search,
  )),
}));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: SpecPage, statusLine, splitLeadingTitle, textTitle, specContents, confirmImportResult } = await import('./SpecPage');
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
  navigations = 0;
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  globalThis.fetch = realFetch;
  window.history.replaceState(null, '', '/app');
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
/** Sheets portal to <body>. */
const qd = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
/** The tab labels, without their counts. */
const tabNames = () => [...container.querySelectorAll('[role="tab"]')].map((t) => t.childNodes[0]!.textContent);
const tab = (name: string) => [...container.querySelectorAll('[role="tab"]')].find((t) => t.childNodes[0]!.textContent === name) as HTMLElement;

describe('statusLine (R-92, R-97, R-100): a badge and a few words', () => {
  it('approved with nothing waiting: the badge alone, nothing about which revision is read (R-91)', () => {
    expect(statusLine({ ...base, waiting: null })).toEqual({ badge: 'Approved', tone: 'success', words: null });
  });
  it('a revision waiting: its badge, and whose approval it waits for', () => {
    expect(statusLine({ ...base, canApprove: false })).toEqual({ badge: 'Revision 2 waiting', tone: 'warning', words: 'Approved at revision 1.' });
    expect(statusLine(base).words).toBe('Approved at revision 1. Waits for your approval.');
  });
  it('a never-approved draft says so once', () => {
    expect(statusLine({ ...base, spec: { ...base.spec, approvedRevision: null }, reading: { revision: 2, approved: false, isHead: true }, waiting: 2, canApprove: false }))
      .toEqual({ badge: 'Revision 2 waiting', tone: 'warning', words: 'Never approved.' });
    expect(statusLine({ ...base, spec: { ...base.spec, approvedRevision: null }, reading: { revision: 1, approved: false, isHead: false }, waiting: 2 }).words)
      .toBe("You're reading revision 1. Never approved. Waits for your approval.");
  });
  it('names the approved revision when reading another one', () => {
    expect(statusLine({ ...base, canApprove: false, reading: { revision: 2, approved: false, isHead: true } }).words)
      .toBe("You're reading revision 2. Revision 1 is approved.");
  });
  it('an unconfirmed import: Imported, and the repo file is the source until confirmed', () => {
    const importConfirmation = { revision: 2, path: 'p.md', commit: 'abc', href: null, canConfirm: true, batchHref: '/x', previous: 1 };
    expect(statusLine({ ...base, importConfirmation })).toEqual({ badge: 'Imported', tone: 'info', words: 'Repo file is the source until you confirm' });
    expect(statusLine({ ...base, importConfirmation: { ...importConfirmation, canConfirm: false } }).words).toBe('Repo file is the source until an approver confirms it');
  });
  it('retired: "Retired: <reason>"; replaced: the page writes the link', () => {
    const retirement = { status: 'retired' as const, reason: 'Folded into Payments', supersededBy: null, by: 'user:u', at: iso };
    expect(statusLine({ ...base, retirement })).toEqual({ badge: 'Retired', tone: 'muted', words: 'Retired: Folded into Payments' });
    expect(statusLine({ ...base, retirement: { ...retirement, status: 'superseded', supersededBy: { id: 'n', title: 'Payments' } } }).words).toBeNull();
  });
});

describe('splitLeadingTitle and textTitle (R-94)', () => {
  it('drops a leading level-one heading whatever it says, and keeps any later one', () => {
    expect(splitLeadingTitle('# Checkout\n\nBody')).toEqual({ heading: 'Checkout', rest: 'Body' });
    expect(splitLeadingTitle('# **Checkout**\nBody')).toEqual({ heading: 'Checkout', rest: 'Body' });
    expect(splitLeadingTitle('# Overview\n\nBody').rest).toBe('Body');
    expect(splitLeadingTitle('Intro\n# Checkout')).toEqual({ heading: null, rest: 'Intro\n# Checkout' });
  });
  it('names the text\'s title only when it differs from the spec\'s', () => {
    expect(textTitle('# **Checkout**\nBody', 'checkout')).toBeNull();
    expect(textTitle('# Overview\nBody', 'Checkout')).toBe('Overview');
    expect(textTitle('Body', 'Checkout')).toBeNull();
  });
});

describe('specContents (R-95)', () => {
  it('lists level-two sections with their criteria counts, skipping code fences', () => {
    const body = '# T\n\nIntro\n\n## One\n\n- R-1: a\n- AC-1: b\n\n```\n## not a section\n- R-9: no\n```\n\n## Two\n\nprose\n\n### Two a\n\n- **R-2**: c\n';
    expect(specContents(body)).toEqual([{ title: 'One', criteria: 2 }, { title: 'Two', criteria: 1 }]);
  });
});

describe('SpecPage', () => {
  it('renders the approved revision, its history, parent and repo references', () => {
    act(() => root.render(<SpecPage view={base} />));
    expect(q('spec-page-reading')!.textContent).toBe('Approved at revision 1. Waits for your approval.');
    expect(q('spec-page-status-badge')!.textContent).toBe('Revision 2 waiting');
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
    expect(revs[1].textContent).toContain('Approved');
    expect(revs[0].textContent).toContain('Waiting');
    expect(revs[1].querySelector('a')!.getAttribute('aria-current')).toBe('page');
    expect(revs[0].querySelector('a')!.getAttribute('aria-current')).toBeNull();
    expect(q('spec-page-review')!.getAttribute('href')).toBe(`/app/specs/${SPEC}?review=1`);
    expect(q('spec-page-approve')).toBeNull();
  });

  it('says when an import could not read some criteria, and says nothing when it read them all', () => {
    act(() => root.render(<SpecPage view={{ ...base, criteriaUnread: '1 criterion could not be read; not read: AC-3a (line 4). Use plain ids (R-n, AC-n), each defined once.' }} />));
    expect(q('spec-page-criteria-unread')!.textContent).toContain('1 criterion could not be read; not read: AC-3a (line 4).');
    act(() => root.render(<SpecPage view={base} />));
    expect(q('spec-page-criteria-unread')).toBeNull();
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
    expect(q('spec-page-nearby')!.textContent!.startsWith('Related')).toBe(true);
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
    expect(list.querySelector('[data-testid="spec-page-siblings"]')!.textContent).toMatch(/^Also under /);
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

  it('with nothing related, there is no Related tab at all', () => {
    act(() => root.render(<SpecPage view={{ ...base, parent: null, repoRefs: [] }} />));
    expect(tabNames()).not.toContain('Related');
    expect(q('spec-page-related-list')).toBeNull();
    act(() => root.render(<SpecPage view={base} />));
    expect(tabNames()).toContain('Related');
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
    expect(q('spec-page-approve-result')!.textContent).toContain('Approved revision 2.');
    expect(refreshes).toBe(1);
  });

  it('reads as approved on the press, before the server answers', async () => {
    let answer!: (r: Response) => void;
    globalThis.fetch = (() => new Promise<Response>(r => { answer = r; })) as unknown as typeof fetch;
    const review = { replaces: null, revision: 2, omittedLines: 0, sectionCount: 0, linesAdded: 0, linesRemoved: 0, body: base.body, hunks: [] };
    act(() => root.render(<SpecPage view={{ ...base, review }} />));
    expect(q('spec-page-review-panel')!.querySelector('h2')!.textContent).toBe('Review revision 2');
    // Approve is the page's one action, in the dock that sticks to the bottom of a phone screen: in view while the text scrolls.
    expect(q('spec-page-action-dock')!.querySelector('[data-testid="spec-page-approve"]')).not.toBeNull();
    expect(q('spec-page-review-panel')!.querySelector('[data-testid="spec-page-approve"]')).toBeNull();
    await act(async () => { q('spec-page-approve')!.click(); });
    expect(q('spec-page-approve-result')!.textContent).toBe('Approved revision 2.');
    expect(q('spec-page-approve')).toBeNull();
    expect(refreshes).toBe(0);
    await act(async () => { answer(new Response(JSON.stringify({ spec: {}, revision: {} }), { status: 200 })); });
    expect(q('spec-page-approve-result')!.textContent).toBe('Approved revision 2.');
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

  it('shows a landed copy as its linked path, and words only when there is something to do (living-specs.md §18, R-13, AC-79)', () => {
    act(() => root.render(<SpecPage view={base} />));
    expect(q('spec-page-source')).toBeNull();
    const landed = { source: null, path: 'docs/specs/checkout.md', href: 'https://github.com/o/r/blob/HEAD/docs/specs/checkout.md', copy: null, behind: false };
    act(() => root.render(<SpecPage view={{ ...base, source: landed }} />));
    expect(q('spec-page-source')!.textContent).toBe('docs/specs/checkout.md');
    expect(q('spec-page-source')!.querySelector('a')!.getAttribute('href')).toBe(landed.href);
    expect(q('spec-page-repo-copy')).toBeNull();
    expect(container.textContent).not.toMatch(/Source: buildd/);
    const red = { source: null, copy: 'PR #9 failed Lint specs. Fix it in a new revision.', behind: true };
    act(() => root.render(<SpecPage view={{ ...base, source: red }} />));
    expect(q('spec-page-repo-copy')!.textContent).toBe('PR #9 failed Lint specs. Fix it in a new revision.');
  });

  it('a kept-private spec shows no explanation, only Add to repo where a person may (R-57)', () => {
    act(() => root.render(<SpecPage view={{ ...base, source: { source: null, copy: null, behind: false, publishAnyway: true }, canPublishAnyway: true }} />));
    expect(q('spec-page-repo-copy')).toBeNull();
    // A secondary action: in More (R-96).
    act(() => q('spec-page-more')!.click());
    expect(qd('spec-page-publish-anyway')!.textContent).toBe('Add to repo');
    expect(container.textContent).not.toMatch(/Not published|Not in the repo|policy|measured|decision model/i);
    act(() => root.render(<SpecPage view={{ ...base, source: { source: null, copy: null, behind: false, publishAnyway: false }, canPublishAnyway: false }} />));
    expect(qd('spec-page-publish-anyway')).toBeNull();
  });

  it('shows a failing repo check on review, after the panel, and still offers Approve (R-34, AC-96, R-9)', async () => {
    const review = { replaces: null, revision: 2, omittedLines: 0, sectionCount: 0, linesAdded: 0, linesRemoved: 0, body: base.body, hunks: [] };
    const preflight = { state: 'ran' as const, path: 'docs/specs/checkout.md', checks: [
      { name: 'specs:lint' as const, ok: false, messages: ['frontmatter missing `summary` (one sentence: what MUST hold)'] },
      { name: 'public-docs:check' as const, ok: true, messages: [] },
      { name: 'no-prod-data' as const, ok: true, messages: [], note: 'The identifier half runs only in CI.' },
    ] };
    const urls: string[] = [];
    let answer!: (r: Response) => void;
    globalThis.fetch = ((url: string) => { urls.push(url); return new Promise<Response>((r) => { answer = r; }); }) as unknown as typeof fetch;
    act(() => root.render(<SpecPage view={{ ...base, review, repoChecks: true }} />));
    // The panel and Approve are there while GitHub is still being asked.
    expect(q('spec-page-approve')).not.toBeNull();
    expect(q('spec-repo-checks-loading')).not.toBeNull();
    expect(urls).toEqual([`/api/specs/${SPEC}/preflight`]);
    await act(async () => { answer(new Response(JSON.stringify({ revision: 2, preflight }), { status: 200 })); });
    expect(q('spec-repo-checks-loading')).toBeNull();
    expect(q('spec-repo-checks')!.textContent).toContain('fails specs:lint');
    // The lint output is collapsed under the one sentence until asked for.
    expect(q('spec-repo-checks')!.textContent).not.toContain('frontmatter missing `summary`');
    act(() => { (q('spec-repo-checks-details')!.closest('button') as HTMLButtonElement).click(); });
    expect(q('spec-repo-checks')!.textContent).toContain('frontmatter missing `summary`');
    expect(q('spec-page-approve')).not.toBeNull();
  });

  it('repo checks that cannot be read say so, and Approve stays', async () => {
    globalThis.fetch = (async () => new Response('{}', { status: 502 })) as unknown as typeof fetch;
    const review = { replaces: null, revision: 2, omittedLines: 0, sectionCount: 0, linesAdded: 0, linesRemoved: 0, body: base.body, hunks: [] };
    await act(async () => { root.render(<SpecPage view={{ ...base, review, repoChecks: true }} />); });
    expect(q('spec-repo-checks-unread')!.textContent).toContain("Couldn't run the repo checks");
    expect(q('spec-page-approve')).not.toBeNull();
  });

  it('Review opens on the press: no navigation, the panel and a loading line at once, then the changes (R-7, R-8, AC-4)', async () => {
    const urls: string[] = [];
    let answer!: (r: Response) => void;
    globalThis.fetch = ((url: string) => { urls.push(url); return new Promise<Response>((r) => { answer = r; }); }) as unknown as typeof fetch;
    act(() => root.render(<SpecPage view={base} />));
    const link = q('spec-page-review')!;
    expect(link.getAttribute('href')).toBe(`/app/specs/${SPEC}?review=1`);
    act(() => { link.click(); });
    expect(window.location.search).toBe('?review=1');
    expect(navigations + refreshes).toBe(0);
    expect(q('spec-page-review')).toBeNull();
    expect(q('spec-page-review-panel')!.querySelector('h2')!.textContent).toBe('Revision 2 replaces revision 1');
    expect(q('spec-page-review-loading')).not.toBeNull();
    expect(q('spec-page-approve')).toBeNull();
    expect(q('spec-page-body')).toBeNull();
    expect(urls).toEqual([`/api/specs/${SPEC}/diff?review=1`]);

    const review = {
      replaces: 1, revision: 2, omittedLines: 0, sectionCount: 1, linesAdded: 1, linesRemoved: 1, body: base.body, version: 5,
      hunks: [{ kind: 'changed' as const, path: 'Checkout', linesAdded: 1, linesRemoved: 1, rows: [{ op: '+' as const, oldLine: null, newLine: 3, text: 'new' }] }],
    };
    await act(async () => { answer(new Response(JSON.stringify({ review }), { status: 200 })); });
    expect(q('spec-page-review-loading')).toBeNull();
    expect(q('spec-approval-diff')).not.toBeNull();
    // Approve carries the version the panel was read at.
    const posted: unknown[] = [];
    globalThis.fetch = (async (_u: string, init: RequestInit) => { posted.push(JSON.parse(String(init.body))); return new Response('{}', { status: 200 }); }) as typeof fetch;
    await act(async () => { q('spec-page-approve')!.click(); });
    expect(posted).toEqual([{ revision: 2, expectedVersion: 5 }]);
  });

  it('a review that cannot be read says why, with no Approve', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: 'No revision of this spec waits for approval.' }), { status: 409 })) as unknown as typeof fetch;
    act(() => root.render(<SpecPage view={base} />));
    await act(async () => { q('spec-page-review')!.click(); });
    expect(q('spec-page-review-error')!.textContent).toBe('No revision of this spec waits for approval.');
    expect(q('spec-page-approve')).toBeNull();
  });
});

describe('Delivery and verification (Slice 13, R-61, AC-48)', () => {
  const T = '22222222-2222-4222-8222-222222222222';
  const entry = {
    kind: 'task' as const, id: T, title: 'Show totals in euros', href: `/app/tasks/${T}`,
    builtTo: 1, provisional: false, delivered: true, deliveredText: 'Built to revision 1. Done.',
    standing: { tone: 'muted' as const, text: 'Not verified against revision 2.' },
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

  it('shows revision-matched criterion verdicts beside body chips, with their work context', () => {
    act(() => root.render(<SpecPage view={{ ...base, delivery: { entries: [entry], next: null } }} />));
    expect(container.querySelector('#R-1 [data-testid="spec-criterion-verdict"]')?.textContent).toContain('Passes');
    expect(container.querySelector('#R-1 [data-testid="spec-criterion-verdict"]')?.getAttribute('title')).toContain(entry.title);
    act(() => root.render(<SpecPage view={{ ...base, reading: { revision: 2, approved: false, isHead: true }, delivery: { entries: [entry], next: null } }} />));
    expect(container.querySelector('#R-1 [data-testid="spec-criterion-verdict"]')).toBeNull();
  });

  it('lists each entry once, linking to its task, with delivery and standing on separate lines', () => {
    act(() => root.render(<SpecPage view={{ ...base, delivery: { entries: [entry], next: null } }} />));
    expect(container.querySelectorAll('[data-testid="spec-delivery-entry"]')).toHaveLength(1);
    expect(q('spec-delivery-link')?.getAttribute('href')).toBe(`/app/tasks/${T}`);
    expect(q('spec-delivery-delivered')?.textContent).toContain('Built to revision 1. Done.');
    expect(q('spec-delivery-standing')?.textContent).toBe('Not verified against revision 2.');
    expect(q('spec-delivery-more')).toBeNull();
    // Work against the spec is in the rail (AC-136), never in a tab panel under the text.
    expect(q('spec-page-panel-spec')!.contains(q('spec-delivery'))).toBe(false);
    expect(q('spec-page-rail-work')!.contains(q('spec-delivery'))).toBe(true);
    expect(q('spec-page-rail-work')!.className).toContain('lg:col-start-2');
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

  it('a mission entry links to its mission and says a waived criterion as waived', () => {
    const M = '33333333-3333-4333-8333-333333333333';
    const mission = {
      ...entry, kind: 'mission' as const, id: M, title: 'Checkout in euros', href: `/app/missions/${M}`,
      standing: { tone: 'success' as const, text: 'Verified against revision 1. AC-1 waived by Ada.' },
      criteria: [{ criterionId: 'AC-1', text: 'A EUR cart shows the euro sign.', mark: 'waived' as const, evidence: [] }],
      links: [],
    };
    act(() => root.render(<SpecPage view={{ ...base, delivery: { entries: [mission, entry], next: null } }} />));
    const rows = container.querySelectorAll('[data-testid="spec-delivery-entry"]');
    expect(rows).toHaveLength(2);
    expect(rows[0].getAttribute('data-kind')).toBe('mission');
    expect(rows[0].querySelector('[data-testid="spec-delivery-link"]')?.getAttribute('href')).toBe(`/app/missions/${M}`);
    act(() => (rows[0].querySelector('button') as HTMLButtonElement).click());
    expect(rows[0].querySelector('[data-testid="spec-delivery-criterion"]')?.textContent).toContain('Waived');
  });

  it('Review leads with the summary and the change list; the full diff is closed until asked (R-1 to R-5, AC-1)', async () => {
    const changes = {
      summary: 'R-26 names the slot; adds R-44 to R-46.',
      mismatch: 'The summary does not mention R-25, which changed.',
      lines: [
        { kind: 'changed' as const, id: 'R-26', text: 'reads now at once', oldText: 'reads now', section: 'Slots', words: [{ op: '=' as const, text: 'reads now' }, { op: '+' as const, text: ' at once' }] },
        { kind: 'added-range' as const, label: 'R-44 – R-46', items: ['R-44', 'R-45', 'R-46'].map((id) => ({ kind: 'added' as const, id, text: `text of ${id}`, section: 'Slots' })) },
        { kind: 'removed' as const, id: 'R-3', oldText: 'gone', section: 'Slots' },
        { kind: 'moved' as const, id: 'R-24', text: 'same', section: 'Slots > Runner', movedFrom: 'Slots > Queue' },
        { kind: 'replacing' as const, id: 'R-50', text: 'next', section: 'Slots', replaces: [{ id: 'R-27', oldText: 'old' }] },
      ],
      otherText: [{ kind: 'changed' as const, section: 'Slots > Queue view' }],
    };
    const review = {
      replaces: 1, revision: 2, omittedLines: 0, sectionCount: 1, linesAdded: 1, linesRemoved: 1, body: base.body, changes,
      hunks: [{ kind: 'changed' as const, path: 'Checkout', linesAdded: 1, linesRemoved: 1, rows: [{ op: '+' as const, oldLine: null, newLine: 3, text: 'new' }] }],
    };
    act(() => root.render(<SpecPage view={{ ...base, review }} />));
    const panel = q('spec-page-review-panel')!;
    // The summary comes first under the heading, then the mismatch line, then the list.
    const order = ['spec-review-summary', 'spec-review-mismatch', 'spec-review-criteria', 'spec-review-other', 'spec-page-full-diff']
      .map((id) => panel.innerHTML.indexOf(`data-testid="${id}"`));
    expect(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1]))).toBe(true);
    expect(q('spec-review-summary')!.textContent).toBe(changes.summary);
    expect(q('spec-review-mismatch')!.textContent).toContain('R-25');
    const rows = [...container.querySelectorAll('[data-testid="spec-review-change"]')];
    expect(rows.map((r) => r.getAttribute('data-kind'))).toEqual(['changed', 'added-range', 'removed', 'moved', 'replacing']);
    expect(q('spec-review-word-added')!.textContent).toBe(' at once');
    expect(rows[3].textContent).toContain('Slots › Queue');
    expect(rows[4].textContent).toContain('Replaces R-27.');
    // The range expands on click.
    expect(container.querySelectorAll('[data-testid="spec-review-range-item"]')).toHaveLength(0);
    act(() => { q('spec-review-range')!.click(); });
    expect(container.querySelectorAll('[data-testid="spec-review-range-item"]')).toHaveLength(3);
    expect(q('spec-review-other-row')!.textContent).toContain('Queue view');
    // The line diff is never the default view.
    expect(q('spec-approval-diff')).toBeNull();
    act(() => { (q('spec-page-full-diff')!.closest('button') as HTMLButtonElement).click(); });
    expect(q('spec-approval-diff')).not.toBeNull();
  });

  it('each criterion links to its history, and the history shows on the page (R-12)', () => {
    const criterionHistory = {
      criterionId: 'R-1',
      history: {
        criterionId: 'R-1', head: 2, retiredIn: null, replacedBy: null, replaces: [],
        entries: [
          { criterionId: 'R-1', revision: 1, kind: 'added' as const, text: 'Totals in the shopper currency.', textHash: 'a', section: 'Checkout', changeSummary: null, author: 'person' as const, approved: true },
          { criterionId: 'R-1', revision: 2, kind: 'changed' as const, text: 'Totals in the cart currency.', textHash: 'b', section: 'Checkout', changeSummary: 'Pick the currency', author: 'agent' as const, approved: false },
        ],
      },
    };
    act(() => root.render(<SpecPage view={{ ...base, criterionHistory }} />));
    const entries = [...container.querySelectorAll('[data-testid="spec-criterion-history-entry"]')];
    // Newest first, the changed words marked against the wording before.
    expect(entries.map((e) => e.getAttribute('data-revision'))).toEqual(['2', '1']);
    expect(entries[0].querySelector('[data-testid="spec-review-word-added"]')!.textContent).toBe('cart');
    expect(entries[0].textContent).toContain('not approved');
    expect(entries[1].textContent).toContain('approved');
  });

  it('a criterion opens its history in place, under its own words, on its id or History (R-12)', async () => {
    const history = {
      criterionId: 'R-1', head: 2, retiredIn: null, replacedBy: null, replaces: [],
      entries: [
        { criterionId: 'R-1', revision: 1, kind: 'added' as const, text: 'Totals in the shopper currency.', textHash: 'a', section: 'Checkout', changeSummary: null, author: 'person' as const, approved: true },
        { criterionId: 'R-1', revision: 2, kind: 'changed' as const, text: 'Totals in the cart currency.', textHash: 'b', section: 'Checkout', changeSummary: 'Pick the currency', author: 'agent' as const, approved: false },
      ],
    };
    const asked: string[] = [];
    globalThis.fetch = (async (url: string) => { asked.push(url); return new Response(JSON.stringify({ history }), { status: 200 }); }) as unknown as typeof fetch;
    act(() => root.render(<SpecPage view={base} />));
    const row = container.querySelector('#R-1')!;
    expect(row.querySelector('[data-testid="spec-criterion-inline-history"]')).toBeNull();
    // Not a link that only scrolls: the id opens the history right here.
    const id = row.querySelector('[data-testid="spec-criterion-id"]') as HTMLButtonElement;
    expect(id.tagName).toBe('BUTTON');
    await act(async () => { id.click(); });
    expect(asked).toEqual([`/api/specs/${SPEC}/criteria/R-1`]);
    const inline = row.querySelector('[data-testid="spec-criterion-inline-history"]')!;
    expect([...inline.querySelectorAll('[data-testid="spec-criterion-history-entry"]')].map((e) => e.getAttribute('data-revision'))).toEqual(['2', '1']);
    expect(id.getAttribute('aria-expanded')).toBe('true');
    expect(row.querySelector('[data-testid="spec-criterion-history-link"]')!.textContent).toBe('Hide history');
    // Closed and opened again, it is not read twice.
    await act(async () => { (row.querySelector('[data-testid="spec-criterion-history-link"]') as HTMLButtonElement).click(); });
    expect(row.querySelector('[data-testid="spec-criterion-inline-history"]')).toBeNull();
    await act(async () => { id.click(); });
    expect(asked).toHaveLength(1);
  });

  it('on the revision in force, work built to an older wording reads "Passed an earlier wording" under the criterion (R-13)', () => {
    const delivery = { next: null, entries: [{
      kind: 'task' as const, id: 't1', title: 'Build totals', href: '/app/tasks/t1', builtTo: 0, provisional: false, delivered: true, deliveredText: '', standing: { tone: 'muted' as const, text: '' },
      criteria: [{ criterionId: 'R-1', text: '', mark: 'earlier-pass' as const, evidence: [] }], links: [], at: iso,
    }] };
    act(() => root.render(<SpecPage view={{ ...base, delivery }} />));
    expect(q('spec-criterion-verdict')!.textContent).toBe('Passed an earlier wording');
  });
});

describe('an imported spec: confirm the repo baseline first, then amendments are reviewed against it (§18, R-19)', () => {
  const W = '44444444-4444-4444-8444-444444444444';
  const importConfirmation = { revision: 2, path: 'docs/specs/mission-flow-timeline.md', commit: '87ee184', href: 'https://github.com/acme/shop/blob/87ee184/docs/specs/mission-flow-timeline.md', canConfirm: true, batchHref: `/app/workspaces/${W}/specs#imported`, previous: 1 };
  const imported = {
    ...base,
    spec: { ...base.spec, workspaceId: W, approvedRevision: null, headRevision: 2, version: 2 },
    standing: 'imported, awaiting confirmation',
    reading: { revision: 2, approved: false, isHead: true },
    // page-view.ts: an unconfirmed import is not waiting for approval and cannot be approved.
    waiting: null, canApprove: false, repoChecks: false,
    revisions: base.revisions.map((r) => ({ ...r, approvedBy: null, approvedAt: null, approvedAgo: null })),
    source: { source: 'Imported from docs/specs/mission-flow-timeline.md@87ee184', copy: null, behind: false },
    importConfirmation,
  };

  it('unconfirmed: Confirm import is the one action, with no Approve or Review, the rendered spec, and the import said in the status line (R-97)', () => {
    act(() => root.render(<SpecPage view={imported} />));
    expect(q('spec-page-confirm-import')!.textContent).toBe('Confirm import');
    expect(container.querySelectorAll('[data-testid="spec-page-confirm-import"]')).toHaveLength(1);
    expect(q('spec-page-approve')).toBeNull();
    expect(q('spec-page-review')).toBeNull();
    expect(container.textContent).not.toMatch(/Approve revision|Review revision/);
    expect(q('spec-page-status-badge')!.textContent).toBe('Imported');
    expect(q('spec-page-reading')!.textContent).toBe('Repo file is the source until you confirm');
    // No explanation block above the text: the path and commit are repo state, beside the text.
    expect(q('spec-page-import')).toBeNull();
    expect(q('spec-page-source')!.textContent).toBe('Imported from docs/specs/mission-flow-timeline.md@87ee184');
    // "Changed since revision N" sits beside the action: the repo's own change between the two imports.
    const changed = q('spec-page-import-repo-change')!;
    expect(changed.textContent).toBe('Changed since revision 1');
    expect(changed.getAttribute('href')).toBe(`/app/specs/${SPEC}?from=1&to=2`);
    expect(q('spec-page-action-dock')!.contains(changed)).toBe(true);
    // The batch confirm is in More.
    expect(q('spec-page-import-batch')).toBeNull();
    act(() => q('spec-page-more')!.click());
    expect(qd('spec-page-import-batch')!.getAttribute('href')).toBe(`/app/workspaces/${W}/specs#imported`);
    expect(q('spec-page-body')!.textContent).toContain('Totals');
    expect(q('spec-page-review-panel')).toBeNull();
    const revs = [...container.querySelectorAll('[data-testid="spec-page-revision"]')];
    expect(revs[0].textContent).toContain('Imported');
    expect(revs[0].textContent).not.toContain('Waiting');
  });

  it('a reader who may not confirm sees who does, and no action at all', () => {
    act(() => root.render(<SpecPage view={{ ...imported, importConfirmation: { ...importConfirmation, canConfirm: false } }} />));
    expect(q('spec-page-reading')!.textContent).toBe('Repo file is the source until an approver confirms it');
    expect(q('spec-page-confirm-import')).toBeNull();
    expect(q('spec-page-action-dock')).toBeNull();
    act(() => q('spec-page-more')!.click());
    expect(qd('spec-page-import-batch')).toBeNull();
    expect(askButtonHiddenSnapshot()).toBe(false);
  });

  it('confirming posts this one spec at the revision read, says it is approved, then refreshes', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ confirmed: [{ specId: SPEC }], skipped: [] }), { status: 200 });
    }) as typeof fetch;
    act(() => root.render(<SpecPage view={imported} />));
    await act(async () => { q('spec-page-confirm-import')!.click(); });
    expect(calls).toEqual([{ url: '/api/specs/import/confirm', body: { workspaceId: W, specIds: [SPEC], expectedRevisions: { [SPEC]: 2 } } }]);
    expect(q('spec-page-confirm-import-result')!.textContent).toBe('Confirmed. Revision 2 is approved, and buildd is its source now.');
    expect(q('spec-page-confirm-import')).toBeNull();
    expect(refreshes).toBe(1);
  });

  it('stale: the repo file moved since the import, so nothing is approved and the page says what to do', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ confirmed: [], skipped: [{ specId: SPEC, reason: 'stale', message: 'docs/specs/mission-flow-timeline.md changed since 87ee184: run import again, then confirm the new revision' }] }), { status: 200 })) as unknown as typeof fetch;
    act(() => root.render(<SpecPage view={imported} />));
    await act(async () => { q('spec-page-confirm-import')!.click(); });
    expect(q('spec-page-confirm-import-result')!.textContent).toBe('Docs/specs/mission-flow-timeline.md changed since 87ee184: run import again, then confirm the new revision.');
    expect(q('spec-page-confirm-import')).not.toBeNull();
    expect(refreshes).toBe(0);
  });

  it('confirmImportResult: a newer import, a 403 and an OAuth link each say so and claim no approval', () => {
    expect(confirmImportResult(200, { confirmed: [], skipped: [{ specId: SPEC, reason: 'conflict', message: 'you read revision 2, and revision 3 was imported since: read it, then confirm' }] }, 2))
      .toEqual({ tone: 'warn', text: 'You read revision 2, and revision 3 was imported since: read it, then confirm.' });
    expect(confirmImportResult(403, { error: 'Confirming an import approves each spec, which is a person\'s decision.' }, 2).tone).toBe('err');
    expect(confirmImportResult(202, { pending: {} }, 2).text).not.toMatch(/approved/i);
    expect(confirmImportResult(500, {}, 2)).toEqual({ tone: 'err', text: 'Could not confirm the import. Try again.' });
  });

  it('confirmed with an amendment waiting: Review compares it with the confirmed baseline, and no import panel shows', () => {
    const amended = { ...base, spec: { ...base.spec, approvedRevision: 2, headRevision: 3 }, reading: { revision: 2, approved: true, isHead: false }, waiting: 3, importConfirmation: null };
    act(() => root.render(<SpecPage view={amended} />));
    expect(q('spec-page-status-badge')!.textContent).toBe('Revision 3 waiting');
    expect(q('spec-page-confirm-import')).toBeNull();
    expect(q('spec-page-review')!.textContent).toBe('Review revision 3');
    const review = { replaces: 2, revision: 3, omittedLines: 0, sectionCount: 1, linesAdded: 2, linesRemoved: 0, body: base.body,
      changes: { summary: 'Tap a task: its detail opens in a bottom sheet', mismatch: null, otherText: [], lines: [{ kind: 'added' as const, id: 'R-20', text: 'Tapping a task opens its detail at once.', section: 'Rows' }] },
      hunks: [{ kind: 'changed' as const, path: 'Rows', linesAdded: 2, linesRemoved: 0, rows: [{ op: '+' as const, oldLine: null, newLine: 3, text: 'R-20' }] }] };
    act(() => root.render(<SpecPage view={{ ...amended, review }} />));
    expect(q('spec-page-review-panel')!.querySelector('h2')!.textContent).toBe('Revision 3 replaces revision 2');
    expect([...container.querySelectorAll('[data-testid="spec-review-change-id"]')].map((e) => e.textContent)).toEqual(['R-20']);
    expect(q('spec-page-full-diff')!.textContent).toContain('+2');
    expect(q('spec-page-approve')!.textContent).toBe('Approve revision 3');
  });

  it('approved with nothing proposed: no decision at all', () => {
    act(() => root.render(<SpecPage view={{ ...base, spec: { ...base.spec, headRevision: 1 }, waiting: null, canApprove: false, importConfirmation: null }} />));
    expect(q('spec-page-action-dock')).toBeNull();
    expect(q('spec-page-status-badge')!.textContent).toBe('Approved');
    expect(container.textContent).not.toMatch(/Approve revision|Confirm import/);
  });
});

describe('reviewing a first revision, and on a phone (320 and 390 wide)', () => {
  const sections = Array.from({ length: 12 }, (_, i) => `## ${i + 1}. Part ${i + 1}\n\n- R-${i + 1}: Part ${i + 1} holds.\n`).join('\n');
  const long = `# Checkout\n\n${sections}`;
  const first = {
    replaces: null, revision: 1, omittedLines: 0, sectionCount: 12, linesAdded: 192, linesRemoved: 0, body: long,
    changes: { summary: 'First draft', mismatch: null, lines: [{ kind: 'added-range' as const, label: 'R-1 – R-12', items: Array.from({ length: 12 }, (_, i) => ({ kind: 'added' as const, id: `R-${i + 1}`, text: 'x', section: 'x' })) }],
      otherText: Array.from({ length: 12 }, (_, i) => ({ kind: 'added' as const, section: `${i + 1}. Part ${i + 1}` })) },
    hunks: [{ kind: 'added' as const, path: 'Checkout', linesAdded: 192, linesRemoved: 0, rows: [{ op: '+' as const, oldLine: null, newLine: 1, text: '# Checkout' }] }],
  };
  const draft = { ...base, spec: { ...base.spec, approvedRevision: null, headRevision: 1 }, reading: { revision: 1, approved: false, isHead: true }, waiting: 1, revisions: [base.revisions[0]!] };

  it('a long 12-section first revision opens as the rendered spec: no +192 diff, no Spec/Changes switch, no row of Added labels', () => {
    act(() => root.render(<SpecPage view={{ ...draft, review: first }} />));
    expect(q('spec-page-review-panel')!.querySelector('h2')!.textContent).toBe('Review revision 1');
    expect(q('spec-page-review-first')!.textContent).toBe('First approval. Approving puts the whole spec in force.');
    expect(q('spec-page-review-since')).toBeNull();
    expect(q('spec-page-review-body')!.querySelectorAll('h2')).toHaveLength(12);
    expect(q('spec-approval-diff')).toBeNull();
    expect(q('spec-page-full-diff')).toBeNull();
    expect(container.textContent).not.toContain('+192');
    expect([...container.querySelectorAll('[role="radio"]')].map((r) => r.textContent)).not.toContain('Changes');
    expect(container.querySelectorAll('[data-testid="spec-review-change"]')).toHaveLength(0);
    expect(q('spec-review-summary')!.textContent).toBe('First draft');
    expect(q('spec-page-approve')!.textContent).toBe('Approve revision 1');
  });

  it('a later draft with nothing approved leads with what it changed since the revision before, then the whole spec', () => {
    const since = { revision: 2, changes: { summary: 'Adds R-12', mismatch: null, lines: [{ kind: 'added' as const, id: 'R-12', text: 'Part 12 holds.', section: '12. Part 12' }], otherText: [] } };
    act(() => root.render(<SpecPage view={{ ...draft, spec: { ...draft.spec, headRevision: 3 }, waiting: 3, review: { ...first, revision: 3, since } }} />));
    expect(q('spec-page-review-panel')!.querySelector('h2')!.textContent).toBe('Review revision 3');
    const block = q('spec-page-review-since')!;
    expect(block.querySelector('h3')!.textContent).toBe('Changed since revision 2');
    expect(block.querySelector('[data-testid="spec-review-summary"]')!.textContent).toBe('Adds R-12');
    expect([...block.querySelectorAll('[data-testid="spec-review-change-id"]')].map((e) => e.textContent)).toEqual(['R-12']);
    // The summary shows once, in the change list, and the whole spec still follows.
    expect(container.querySelectorAll('[data-testid="spec-review-summary"]')).toHaveLength(1);
    expect(q('spec-page-review-body')!.querySelectorAll('h2')).toHaveLength(12);
  });

  it('twelve added sections of an amendment are one "Added" row, not twelve', () => {
    act(() => root.render(<SpecPage view={{ ...draft, review: { ...first, replaces: 1, revision: 2 } }} />));
    const rows = [...container.querySelectorAll('[data-testid="spec-review-other-row"]')];
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent!.match(/Added/g)).toHaveLength(1);
    expect(rows[0].querySelectorAll('li')).toHaveLength(12);
  });

  for (const width of [320, 390]) {
    it(`at ${width}px the decision is a labelled bar stuck above the bottom nav and the home indicator, last on the page, full width`, () => {
      window.innerWidth = width;
      act(() => root.render(<SpecPage view={base} />));
      const dock = q('spec-page-action-dock')!;
      expect([dock.getAttribute('role'), dock.getAttribute('aria-label')]).toEqual(['region', 'Decision']);
      // Sticky, never fixed: it never covers the fixed bottom nav, which <main>'s padding already clears,
      // and it holds its own height in the flow, so at the end the last line sits above it (R-99, AC-135).
      expect(dock.className).toContain('sticky');
      expect(dock.className).toContain('bottom-[env(safe-area-inset-bottom,0px)]');
      expect(dock.className.split(' ').filter((c) => /(^|:)fixed$/.test(c) || c.startsWith('bottom-0'))).toEqual([]);
      // From lg it is the top of the rail.
      expect(dock.className).toContain('lg:static');
      expect(dock.className).toContain('lg:row-start-1');
      // Last in the flow that holds the text, so it stays in view the whole way down and ends after it.
      expect(dock.parentElement!.lastElementChild).toBe(dock);
      expect(dock.parentElement!.contains(q('spec-page-body'))).toBe(true);
      expect(q('spec-page-review')!.className).toContain('w-full');
      expect(q('spec-page-review')!.className).toContain('h-11');
    });
  }

  it('focus: pressing Review moves focus to the review heading; a page loaded on ?review=1 does not steal it', async () => {
    globalThis.fetch = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    act(() => root.render(<SpecPage view={base} />));
    act(() => { q('spec-page-review')!.click(); });
    expect(document.activeElement?.id).toBe('spec-review-heading');
    act(() => root.unmount());
    root = createRoot(container);
    (document.activeElement as HTMLElement | null)?.blur();
    act(() => root.render(<SpecPage view={{ ...draft, review: first }} />));
    expect(document.activeElement?.id).not.toBe('spec-review-heading');
  });
});

describe('Spec page layout (fc80b5a4 R-92 to R-100)', () => {
  const sixSections = Array.from({ length: 6 }, (_, i) => `## Part ${i + 1}\n\n- R-${i + 1}: Part ${i + 1} holds.\n- AC-${i + 1}: GIVEN part ${i + 1} THEN it holds.\n`).join('\n');
  const approved = { ...base, spec: { ...base.spec, headRevision: 1, status: 'approved' }, reading: { revision: 1, approved: true, isHead: true }, waiting: null, canApprove: false, revisions: [base.revisions[1]!] };
  const W = '55555555-5555-4555-8555-555555555555';
  const imported = {
    ...base,
    spec: { ...base.spec, workspaceId: W, approvedRevision: null, headRevision: 2, version: 2 },
    standing: 'imported, awaiting confirmation',
    reading: { revision: 2, approved: false, isHead: true },
    waiting: null, canApprove: false,
    body: `# Checkout\n\nThe shopper sees totals in their own currency.\n\n${sixSections}`,
    source: { source: 'Imported from docs/specs/checkout.md@87ee184', copy: null, behind: false },
    importConfirmation: { revision: 2, path: 'docs/specs/checkout.md', commit: '87ee184', href: null, canConfirm: true, batchHref: `/app/workspaces/${W}/specs#imported`, previous: 1 },
  };

  it('AC-130: an unconfirmed import opens on back, title, the Imported status line, the tabs, then the text; Confirm import is the only primary action', () => {
    act(() => root.render(<SpecPage view={imported} />));
    const page = container.firstElementChild as HTMLElement;
    // Nothing between the header and the tabs, and the Spec tab opens on the text.
    const header = page.children[0] as HTMLElement;
    expect(header.tagName).toBe('HEADER');
    expect([...header.querySelectorAll('[data-testid]')].map((e) => e.getAttribute('data-testid')))
      .toEqual(['spec-page-more', 'spec-page-title', 'spec-page-status', 'spec-page-status-badge', 'spec-page-reading']);
    expect(page.children[1].getAttribute('data-testid')).toBe('spec-page-tabs');
    expect(tabNames()).toEqual(['Spec', 'History', 'Related']);
    expect(tab('Spec').getAttribute('aria-selected')).toBe('true');
    const panel = q('spec-page-panel-spec')!;
    expect(panel.hidden).toBe(false);
    // Only the Contents control comes before the text.
    expect([...panel.children].map((c) => c.getAttribute('data-testid') ?? c.firstElementChild?.getAttribute('data-testid'))).toEqual(['spec-page-contents', 'spec-page-body']);
    expect(q('spec-page-body')!.textContent).toContain('The shopper sees totals');
    // One primary action on the page.
    expect(container.querySelectorAll('.btn-primary')).toHaveLength(1);
    expect(container.querySelector('.btn-primary')!.textContent).toBe('Confirm import');
  });

  it('AC-131: no comments and no files: no Comments or Files tab or section, and Add a comment and Attach a file are in More', () => {
    act(() => root.render(<SpecPage view={approved} />));
    expect(tabNames()).not.toContain('Comments');
    expect(tabNames()).not.toContain('Files');
    expect(q('spec-comments')).toBeNull();
    expect(container.textContent).not.toMatch(/Comments|Files/);
    act(() => q('spec-page-more')!.click());
    expect(qd('spec-page-more-comment')!.textContent).toBe('Add a comment');
    expect(qd('spec-page-more-attach')!.textContent).toBe('Attach a file');
    expect(qd('spec-page-more-copy-link')!.textContent).toBe('Copy link');
    // Picking one opens its tab.
    act(() => qd('spec-page-more-comment')!.click());
    expect(tabNames()).toContain('Comments');
    expect(tab('Comments').getAttribute('aria-selected')).toBe('true');
    expect(q('spec-page-panel-comments')!.hidden).toBe(false);
    expect(q('spec-page-panel-spec')!.hidden).toBe(true);
  });

  it('Comments and Files are tabs with their counts when they have something', () => {
    const comment = { id: 'c1', anchor: { kind: 'criterion' as const, id: 'R-1', label: 'R-1' }, anchorHere: 'R-1', body: 'Which currency?', author: { kind: 'user' as const, id: 'u1' }, madeOnRevision: 1, parentCommentId: null, state: 'open', resolvedBy: null, createdAt: iso };
    act(() => root.render(<SpecPage view={{ ...approved, comments: [comment] }} />));
    expect(tabNames()).toEqual(['Spec', 'History', 'Related', 'Comments']);
    expect(tab('Comments').textContent).toBe('Comments1');
    expect(tab('History').textContent).toBe('History1');
  });

  it('AC-132: a body titled differently shows one title, and the status line names the text\'s title', () => {
    const body = '# Orchestration Decisions (Shadow, Promotion Guard and Live Hold/Start)\n\nThe guard holds.\n';
    act(() => root.render(<SpecPage view={{ ...approved, spec: { ...approved.spec, title: 'Orchestration Decisions (Shadow and Promotion Guard)' }, body }} />));
    expect(container.querySelectorAll('h1')).toHaveLength(1);
    expect(q('spec-page-title')!.textContent).toBe('Orchestration Decisions (Shadow and Promotion Guard)');
    expect(q('spec-page-body')!.textContent).not.toContain('Live Hold/Start');
    expect(q('spec-page-text-title')!.textContent).toBe('Titled in the text: Orchestration Decisions (Shadow, Promotion Guard and Live Hold/Start)');
    act(() => root.render(<SpecPage view={approved} />));
    expect(q('spec-page-text-title')).toBeNull();
  });

  it('AC-133: six sections: Contents lists them with criteria counts, and picking the fourth scrolls to it', async () => {
    const scrolled: Element[] = [];
    const real = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) { scrolled.push(this); };
    try {
      act(() => root.render(<SpecPage view={{ ...approved, body: `# Checkout\n\n${sixSections}` }} />));
      expect(q('spec-page-contents')!.textContent).toBe('Contents · 6 sections');
      // Desktop: part of the rail.
      expect(q('spec-page-rail-contents')!.querySelectorAll('[data-testid="spec-page-contents-item"]')).toHaveLength(6);
      // Phone: a sheet.
      act(() => q('spec-page-contents')!.click());
      const items = [...qd('spec-page-contents-sheet')!.querySelectorAll('[data-testid="spec-page-contents-item"]')];
      expect(items.map((i) => i.textContent)).toEqual(['Part 12', 'Part 22', 'Part 32', 'Part 42', 'Part 52', 'Part 62']);
      await act(async () => { (items[3] as HTMLElement).click(); await new Promise((r) => setTimeout(r, 0)); });
      expect(scrolled).toHaveLength(1);
      expect(scrolled[0].textContent).toBe('Part 4');
      expect(q('spec-page-body')!.querySelectorAll('h2')[3] === scrolled[0]).toBe(true);
      expect(qd('spec-page-contents-sheet')).toBeNull();
      // Criteria render as rows with their id as a chip.
      expect(q('spec-page-body')!.querySelectorAll('[data-testid="spec-criterion"]')).toHaveLength(12);
    } finally {
      Element.prototype.scrollIntoView = real;
    }
  });

  it('fewer than three sections: no Contents', () => {
    act(() => root.render(<SpecPage view={approved} />));
    expect(q('spec-page-contents')).toBeNull();
    expect(q('spec-page-rail-contents')).toBeNull();
  });

  it('AC-134: History picks two rows to compare; one picked leaves Compare disabled; no revision dropdowns', () => {
    act(() => root.render(<SpecPage view={{ ...base, canApprove: false }} />));
    act(() => tab('History').click());
    expect(q('spec-page-panel-history')!.hidden).toBe(false);
    expect(container.querySelector('select, [role="combobox"]')).toBeNull();
    const go = () => q('spec-page-compare-go')!;
    expect((go() as HTMLButtonElement).disabled).toBe(true);
    const picks = [...container.querySelectorAll('[data-testid="spec-page-revision-pick"]')] as HTMLInputElement[];
    act(() => picks[0].click());
    expect((go() as HTMLButtonElement).disabled).toBe(true);
    act(() => picks[1].click());
    expect(go().tagName).toBe('A');
    expect(go().textContent).toBe('Compare 1 → 2');
    expect(go().getAttribute('href')).toBe(`/app/specs/${SPEC}?from=1&to=2`);
  });

  it('opened on ?from=&to=, History shows the diff with both rows picked', () => {
    const compare = { from: 1, to: 2, replaces: 1, revision: 2, omittedLines: 0, sectionCount: 1, linesAdded: 1, linesRemoved: 0, body: '', hunks: [{ kind: 'changed' as const, path: 'Checkout', linesAdded: 1, linesRemoved: 0, rows: [{ op: '+' as const, oldLine: null, newLine: 3, text: 'new' }] }] };
    act(() => root.render(<SpecPage view={{ ...base, compare }} />));
    expect(tab('History').getAttribute('aria-selected')).toBe('true');
    expect(q('spec-page-panel-history')!.querySelector('[data-testid="spec-page-compare-panel"]')).not.toBeNull();
    expect(q('spec-approval-diff')).not.toBeNull();
    expect(([...container.querySelectorAll('[data-testid="spec-page-revision-pick"]')] as HTMLInputElement[]).map((i) => i.checked)).toEqual([true, true]);
  });

  // Next.js keeps the mounted page across a search-param change: the same root re-renders with the new view.
  const threeRevisions = [
    { revision: 3, author: 'agent' as const, changeSummary: null, approvedBy: null, approvedAt: null, createdAt: iso, createdAgo: '1h ago', approvedAgo: null },
    ...base.revisions,
  ];
  const diff = (from: number, to: number) => ({ from, to, replaces: from, revision: to, omittedLines: 0, sectionCount: 1, linesAdded: 1, linesRemoved: 0, body: '', hunks: [{ kind: 'changed' as const, path: 'Checkout', linesAdded: 1, linesRemoved: 0, rows: [{ op: '+' as const, oldLine: null, newLine: 3, text: 'new' }] }] });
  const checked = () => ([...container.querySelectorAll('[data-testid="spec-page-revision-pick"]')] as HTMLInputElement[]).map((i) => i.checked);

  it('same page, Spec → ?from=&to= (Changed since revision N): History shows with the comparison picked', () => {
    const view = { ...base, revisions: threeRevisions, canApprove: false };
    act(() => root.render(<SpecPage view={view} />));
    expect(q('spec-page-panel-spec')!.hidden).toBe(false);
    act(() => root.render(<SpecPage view={{ ...view, compare: diff(1, 2) }} />));
    expect(tab('History').getAttribute('aria-selected')).toBe('true');
    expect(q('spec-page-panel-history')!.hidden).toBe(false);
    expect(q('spec-page-panel-spec')!.hidden).toBe(true);
    expect(q('spec-page-compare-panel')).not.toBeNull();
    expect(checked()).toEqual([false, true, true]);

    // Another comparison on the same page moves the picks with it.
    act(() => root.render(<SpecPage view={{ ...view, compare: diff(2, 3) }} />));
    expect(q('spec-page-panel-history')!.hidden).toBe(false);
    expect(checked()).toEqual([true, true, false]);
  });

  it('same page, History → ?revision=N: Spec shows that revision\'s text and the picks clear', () => {
    const view = { ...base, revisions: threeRevisions, canApprove: false };
    act(() => root.render(<SpecPage view={{ ...view, compare: diff(1, 2) }} />));
    expect(q('spec-page-panel-history')!.hidden).toBe(false);
    act(() => root.render(<SpecPage view={{ ...view, reading: { revision: 2, approved: false, isHead: false }, body: '# Checkout\n\nRevision two text.\n' }} />));
    expect(tab('Spec').getAttribute('aria-selected')).toBe('true');
    expect(q('spec-page-panel-spec')!.hidden).toBe(false);
    expect(q('spec-page-panel-history')!.hidden).toBe(true);
    expect(q('spec-page-body')!.textContent).toContain('Revision two text.');
    expect(checked()).toEqual([false, false, false]);

    // Revision N from History while already reading without a comparison: Spec again.
    act(() => tab('History').click());
    act(() => root.render(<SpecPage view={{ ...view, reading: { revision: 3, approved: false, isHead: true }, body: '# Checkout\n\nRevision three text.\n' }} />));
    expect(q('spec-page-panel-spec')!.hidden).toBe(false);
    expect(q('spec-page-body')!.textContent).toContain('Revision three text.');
  });

  it('same page, History → ?revision=N for the revision already read: Spec shows', () => {
    const view = { ...base, canApprove: false };
    act(() => root.render(<SpecPage view={view} />));
    act(() => tab('History').click());
    act(() => { window.history.pushState(null, '', `/app/specs/${SPEC}?revision=1`); root.render(<SpecPage view={{ ...view }} />); });
    expect(q('spec-page-panel-spec')!.hidden).toBe(false);
    expect(q('spec-page-panel-history')!.hidden).toBe(true);
  });

  it('a manual tab pick survives a re-render that navigates nowhere', () => {
    const view = { ...base, canApprove: false };
    act(() => root.render(<SpecPage view={view} />));
    act(() => tab('History').click());
    act(() => root.render(<SpecPage view={{ ...view }} />));
    expect(q('spec-page-panel-history')!.hidden).toBe(false);
  });

  it('AC-136: an approved spec reads in a column no wider than 720px, with Contents, work against it and repo state in the rail', () => {
    const entry = { kind: 'task' as const, id: 't1', title: 'Build totals', href: '/app/tasks/t1', builtTo: 1, provisional: false, delivered: true, deliveredText: 'Built to revision 1.', standing: { tone: 'muted' as const, text: '' }, criteria: [], links: [], at: iso };
    act(() => root.render(<SpecPage view={{ ...approved, body: `# Checkout\n\n${sixSections}`, delivery: { entries: [entry], next: null }, source: { source: null, path: 'docs/specs/checkout.md', href: undefined, copy: null, behind: false } }} />));
    const grid = q('spec-page-panel-spec')!.parentElement!.parentElement!;
    expect(grid.className).toContain('lg:grid-cols-[minmax(0,45rem)_20rem]');
    expect(q('spec-page-rail-contents')!.className).toContain('lg:col-start-2');
    expect(q('spec-page-rail-work')!.contains(q('spec-delivery'))).toBe(true);
    expect(q('spec-page-rail-work')!.className).toContain('lg:col-start-2');
    expect(q('spec-page-repo-state')!.className).toContain('lg:col-start-2');
    expect(q('spec-page-repo-state')!.textContent).toBe('docs/specs/checkout.md');
    expect(q('spec-page-action-dock')).toBeNull();
  });

  it('R-96: secondary actions live in More, never on the page', () => {
    act(() => root.render(<SpecPage view={{ ...approved, canPublishAnyway: true, canMarkStandard: true, canRetire: true, retireTargets: [] }} />));
    expect(q('spec-page-publish-anyway')).toBeNull();
    expect(q('spec-page-standard-toggle')).toBeNull();
    expect(q('spec-retire')).toBeNull();
    act(() => q('spec-page-more')!.click());
    expect(qd('spec-page-publish-anyway')).not.toBeNull();
    expect(qd('spec-page-standard-toggle')).not.toBeNull();
    expect(qd('spec-retire')).not.toBeNull();
  });

  it('R-100: a retired spec says why in the status line, and Restore is the one action for a person who may', async () => {
    const calls: Array<{ url: string; method?: string }> = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => { calls.push({ url, method: init.method }); return new Response('{}', { status: 200 }); }) as typeof fetch;
    const retirement = { status: 'retired' as const, reason: 'Folded into Payments', supersededBy: null, by: 'user:u', at: iso };
    act(() => root.render(<SpecPage view={{ ...approved, spec: { ...approved.spec, status: 'retired' }, retirement, canRetire: true }} />));
    expect(q('spec-page-status-badge')!.textContent).toBe('Retired');
    expect(q('spec-retired-line')!.textContent).toBe('Retired: Folded into Payments');
    expect(q('spec-page-action-dock')!.querySelector('[data-testid="spec-restore"]')!.textContent).toBe('Restore');
    await act(async () => { q('spec-restore')!.click(); });
    expect(calls).toEqual([{ url: `/api/specs/${SPEC}/retire`, method: 'DELETE' }]);
    expect(refreshes).toBe(1);

    act(() => root.render(<SpecPage view={{ ...approved, spec: { ...approved.spec, status: 'superseded' }, retirement: { ...retirement, status: 'superseded', supersededBy: { id: 'pay', title: 'Payments' } }, canRetire: false }} />));
    expect(q('spec-retired-line')!.textContent).toBe('Replaced by Payments');
    expect(q('spec-retired-line')!.querySelector('a')!.getAttribute('href')).toBe('/app/specs/pay');
    expect(q('spec-page-action-dock')).toBeNull();
  });

  it('a failed Restore says what failed, then what to do', async () => {
    globalThis.fetch = (async () => new Response('not json', { status: 500 })) as unknown as typeof fetch;
    const retirement = { status: 'retired' as const, reason: 'Folded into Payments', supersededBy: null, by: 'user:u', at: iso };
    act(() => root.render(<SpecPage view={{ ...approved, spec: { ...approved.spec, status: 'retired' }, retirement, canRetire: true }} />));
    await act(async () => { q('spec-restore')!.click(); });
    expect(q('spec-page-action-dock')!.textContent).toContain('Could not restore the spec. Try again.');
    expect(refreshes).toBe(0);
  });

  it('a waiting revision: Review revision M is the one action', () => {
    act(() => root.render(<SpecPage view={base} />));
    expect(container.querySelectorAll('.btn-primary')).toHaveLength(1);
    expect(q('spec-page-action-dock')!.textContent).toBe('Review revision 2');
  });
});
