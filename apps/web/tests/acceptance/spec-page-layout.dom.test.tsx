/**
 * Acceptance checks for Living Spec fc80b5a4 "Living Specs: finding and
 * organising specs", revision 6, "Spec page layout" (R-92 to R-100). Written
 * before the build: each test fails on the starting commit and passes once the
 * page is built. A check named here is listed in the spec's metadata
 * `verified_by`, keyed by its id.
 *
 * The page is mounted in happy-dom with a view, and read by role and visible
 * words (tabs, headings, buttons, links), so the build is free to choose its
 * components and test ids. Pixel facts (what is visible at 390x844, a sticky
 * bar's clearance, a 720px column) cannot be read in happy-dom; those checks
 * are judged on the spec's screens, and the structure behind them is tested
 * here (order of the first screen, one primary action, what is hidden).
 *
 * Run alone: cd apps/web && bun test tests/acceptance/spec-page-layout.dom.test.tsx
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app' });

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const pushed: string[] = [];
mock.module('next/navigation', () => ({
  useRouter: () => ({ push: (u: string) => { pushed.push(u); }, replace: (u: string) => { pushed.push(u); }, refresh: () => {} }),
  usePathname: () => '/app/specs/x',
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: SpecPage } = await import('../../src/components/SpecPage');

const SPEC = '11111111-1111-4111-8111-111111111111';
const W = '44444444-4444-4444-8444-444444444444';
let container: HTMLElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  pushed.length = 0;
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  window.history.replaceState(null, '', '/app');
});

const iso = new Date().toISOString();
const rev = (revision: number, over: Record<string, unknown> = {}) => ({
  revision, author: 'agent' as const, changeSummary: `Change ${revision}`, approvedBy: null, approvedAt: null, createdAt: iso,
  createdAgo: `${revision}h ago`, approvedAgo: null, ...over,
});
const BODY = '# Checkout\n\n- R-1: **Totals** in the shopper currency.\n- AC-1: A zero total reads as free.\n\nMore words follow here so that the text has some lines.\n';
const base = {
  state: 'ok' as const,
  spec: { id: SPEC, title: 'Checkout', scope: 'feature', status: 'approved', workspaceId: W, workspaceName: 'shop', version: 3, headRevision: 2, approvedRevision: 2 as number | null },
  standing: 'approved at revision 2',
  reading: { revision: 2, approved: true, isHead: true },
  waiting: null as number | null,
  body: BODY,
  revisions: [rev(2, { approvedBy: 'Max', approvedAt: iso, approvedAgo: '1h ago' }), rev(1, { approvedBy: 'Max', approvedAt: iso, approvedAgo: '2h ago' })],
  parent: null as { id: string; title: string } | null,
  children: [] as Array<{ id: string; title: string }>,
  siblings: [] as Array<{ id: string; title: string }>,
  repoRefs: [] as any[],
  design: null as any,
  comments: [] as any[],
  commentAnchors: [{ kind: 'criterion' as const, id: 'R-1', label: 'R-1' }],
  canComment: true,
  attachments: [] as any[],
  attachmentSources: {},
  nearby: [] as any[],
  filing: null as any,
  compare: null,
  canApprove: false,
  review: null as any,
};
const imported = {
  ...base,
  spec: { ...base.spec, status: 'draft', approvedRevision: null, headRevision: 2, version: 2 },
  standing: 'imported, awaiting confirmation',
  reading: { revision: 2, approved: false, isHead: true },
  revisions: [rev(2, { changeSummary: null }), rev(1, { changeSummary: null })],
  source: { source: 'Imported from docs/specs/checkout.md@87ee184', copy: null, behind: false },
  importConfirmation: { revision: 2, path: 'docs/specs/checkout.md', commit: '87ee184', href: null, canConfirm: true, batchHref: `/app/workspaces/${W}/specs#imported`, previous: 1 },
  canApprove: false,
};

const render = (view: unknown) => act(() => root.render(<SpecPage view={view as never} />));
const click = (el: Element | undefined) => { if (!el) throw new Error('the control to press is not on the page'); press(el); };
const press = (el: Element) => act(() => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true })); });
const all = (sel: string) => [...document.body.querySelectorAll<HTMLElement>(sel)];
const words = (el: Element) => (el.textContent ?? '').replace(/\s+/g, ' ').trim();
const tabs = () => all('[role="tab"]');
const tab = (re: RegExp) => tabs().find((t) => re.test(words(t)));
const headings = () => all('h1,h2,h3,h4,[role="heading"]').map(words);
const control = (re: RegExp) => all('button,a,[role="button"],[role="menuitem"],summary').find((e) => re.test(words(e)));
const PRIMARY = /^(Confirm import|Review revision \d+|Approve revision \d+|Restore)\b/;
const primaryActions = () => all('button,a,[role="button"]').filter((e) => PRIMARY.test(words(e)));

describe('R-92: the first screen is title, one status line, tabs, the text', () => {
  it('AC-130: an imported, unconfirmed spec shows title, Imported, tabs, then the text, with Confirm import the only primary action', () => {
    render(imported);
    const title = all('h1').find((h) => words(h) === 'Checkout');
    const status = all('*').find((e) => e.children.length === 0 && /Imported/.test(words(e)) && !e.closest('[role="tablist"]'));
    const list = all('[role="tablist"]')[0];
    const text = all('*').find((e) => e.children.length === 0 && /Totals/.test(words(e)));
    expect(title && status && list && text).toBeTruthy();
    const before = (a: Element, b: Element) => !!(a.compareDocumentPosition(b) & window.Node.DOCUMENT_POSITION_FOLLOWING);
    expect(before(title!, status!)).toBe(true);
    expect(before(status!, list!)).toBe(true);
    expect(before(list!, text!)).toBe(true);
    // Nothing but the back link, title, status line and tabs sits above the text.
    const above = container.textContent!.slice(0, container.textContent!.indexOf('Totals'));
    expect(above).not.toMatch(/Revision 1|Revision 2 is|Awaiting|A person who approves/);
    expect(all('section').filter((s) => before(s, text!) && !s.contains(text!))).toEqual([]);
    expect(primaryActions().map(words)).toEqual(['Confirm import']);
  });

  it('R-97: an unconfirmed import says so in the status line, with the change linked beside the action', () => {
    render(imported);
    expect(container.textContent).toContain('Repo file is the source until you confirm');
    const changed = control(/Changed since revision 1/);
    expect(changed?.getAttribute('href') ?? '').toContain('from=1');
    expect(changed?.getAttribute('href') ?? '').toContain('to=2');
    // The longer explanation is never above the text.
    expect(container.textContent).not.toMatch(/No proposed changes/);
  });
});

describe('R-93: tabs, and nothing stacked under the text', () => {
  it('AC-131: a spec with no comments and no files has neither tab nor section, and Add a comment and Attach a file are in More', () => {
    render(base);
    expect(tab(/^Spec$/)).toBeTruthy();
    expect(tab(/^History/)).toBeTruthy();
    expect(tab(/Comments/)).toBeUndefined();
    expect(tab(/Files/)).toBeUndefined();
    for (const h of headings()) expect(h).not.toMatch(/^(Comments|Files|Related|Revisions)$/);
    const more = control(/^More\b/);
    expect(more).toBeTruthy();
    click(more!);
    expect(control(/Add a comment/)).toBeTruthy();
    expect(control(/Attach a file/)).toBeTruthy();
  });

  it('R-93: Comments, Files and Related are tabs when they hold something, never sections under the text', () => {
    const comment = { id: 'c1', anchor: { kind: 'criterion', id: 'R-1', label: 'R-1' }, anchorHere: 'R-1', body: 'Is rounding in scope here?', author: { kind: 'user', id: 'u' }, madeOnRevision: 2, parentCommentId: null, state: 'open', resolvedBy: null, createdAt: iso };
    const file = { id: 'f1', name: 'mock.png', kind: 'reference', caption: 'Today', artifactId: 'a1', title: 'Mock', mimeType: 'image/png', isImage: true, artifactRevision: 1, addedInRevision: 1, removedFromRevision: null, addedBy: { kind: 'person', name: 'Max' }, addedAt: iso, addedAgo: '1h ago', url: '/api/x' };
    const near = { specId: 'other', title: 'Cart', kind: 'similar', score: 0.7, reason: 'Similar wording' };
    render({ ...base, comments: [comment], attachments: [file], nearby: [near] });
    expect(tab(/^Comments/)).toBeTruthy();
    expect(tab(/^Files/)).toBeTruthy();
    expect(tab(/^Related/)).toBeTruthy();
    expect(tab(/Related/)?.textContent).toMatch(/1/);
    // On the Spec tab none of their content is under the text.
    expect(container.textContent).not.toContain('Is rounding in scope here?');
    expect(container.textContent).not.toContain('Similar wording');
    expect(container.textContent).not.toContain('Change 1');
    click(tab(/^Comments/)!);
    expect(container.textContent).toContain('Is rounding in scope here?');
  });
});

describe('R-94: one title', () => {
  const LONG = 'Orchestration Decisions (Shadow, Promotion Guard and Live Hold/Start)';
  const SHORT = 'Orchestration Decisions (Shadow and Promotion Guard)';

  it('AC-132: a body heading that differs from the title is not rendered again, and the status line names it', () => {
    render({ ...base, spec: { ...base.spec, title: SHORT }, body: `# ${LONG}\n\n- R-1: Something.\n` });
    expect(all('h1').map(words)).toEqual([SHORT]);
    expect(container.textContent).toContain(`Titled in the text: ${LONG}`);
  });

  it('R-94: a body heading equal to the title is dropped and says nothing', () => {
    render({ ...base, body: '# Checkout\n\n- R-1: Something.\n' });
    expect(all('h1').map(words)).toEqual(['Checkout']);
    expect(container.textContent).not.toContain('Titled in the text');
  });
});

describe('R-95: Contents', () => {
  const six = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot']
    .map((n, i) => `## ${n}\n\n- R-${i + 1}: ${n} does a thing.\n- AC-${i + 1}: ${n} is checked.\n`).join('\n');

  it('AC-133: a spec with six sections has Contents, listing each with its criteria count; picking the fourth scrolls there', () => {
    const scrolled: string[] = [];
    const real = window.HTMLElement.prototype.scrollIntoView;
    window.HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) { scrolled.push(words(this)); } as never;
    try {
      render({ ...base, body: `# Checkout\n\n${six}` });
      const contents = control(/^Contents\b/);
      expect(contents).toBeTruthy();
      click(contents!);
      const items = all('a,button,[role="menuitem"],[role="option"],li').filter((e) => /^(Alpha|Bravo|Charlie|Delta|Echo|Foxtrot)\b/.test(words(e)) && !e.closest('article,[role="article"]'));
      const delta = items.find((e) => /^Delta\b/.test(words(e)));
      expect(delta).toBeTruthy();
      expect(words(delta!)).toMatch(/2/);
      click(delta!);
      expect(scrolled.some((t) => t.startsWith('Delta'))).toBe(true);
    } finally {
      window.HTMLElement.prototype.scrollIntoView = real;
    }
  });

  it('R-95: a spec with fewer than three sections has no Contents control', () => {
    render({ ...base, body: '# Checkout\n\n## One\n\n- R-1: a.\n\n## Two\n\n- R-2: b.\n' });
    expect(control(/^Contents\b/)).toBeUndefined();
  });
});

describe('R-96: one primary action', () => {
  const waiting = { ...base, waiting: 3, canApprove: true, spec: { ...base.spec, headRevision: 3 }, revisions: [rev(3), ...base.revisions] };

  it('an approver of a waiting revision gets Review revision M only; the rest are in More', () => {
    render({ ...waiting, canRetire: true, retireTargets: [] });
    expect(primaryActions().map(words)).toEqual(['Review revision 3']);
    expect(control(/^Retire\b/)).toBeUndefined();
    expect(control(/Copy link/)).toBeUndefined();
    click(control(/^More\b/)!);
    expect(control(/Retire/)).toBeTruthy();
    expect(control(/Copy link/)).toBeTruthy();
  });

  it('a reader who cannot approve sees no primary action', () => {
    render({ ...waiting, canApprove: false });
    expect(primaryActions()).toEqual([]);
  });
});

describe('R-100: retired and replacing specs say so in the status line', () => {
  it('Retired: <reason>, and Replaced by <spec>', () => {
    const retirement = { status: 'retired', reason: 'Folded into the checkout rewrite', supersededBy: null, by: 'user:u', at: iso };
    render({ ...base, spec: { ...base.spec, status: 'retired' }, retirement });
    expect(container.textContent).toContain('Retired: Folded into the checkout rewrite');
    act(() => root.unmount());
    root = createRoot(container);
    render({ ...base, spec: { ...base.spec, status: 'superseded' }, retirement: { ...retirement, status: 'superseded', reason: 'Replaced', supersededBy: { id: 'n', title: 'Checkout v2' } } });
    expect(container.textContent).toContain('Replaced by Checkout v2');
  });

  it('R-78/R-80: the repo file PR of a retired spec, and the note on a restored one, are in the repo rail', () => {
    const retirement = { status: 'retired', reason: 'Folded', supersededBy: null, by: 'user:u', at: iso, repoLine: { text: 'PR #7 marks docs/specs/checkout.md superseded in the repo.', href: 'https://example.test/pr/7' } };
    render({ ...base, spec: { ...base.spec, status: 'retired' }, retirement });
    const line = document.querySelector('[data-testid="spec-page-repo-state"] [data-testid="spec-retired-repo-pr"]');
    expect(line?.textContent).toContain('PR #7 marks docs/specs/checkout.md superseded');
    expect(line?.querySelector('a')?.getAttribute('href')).toBe('https://example.test/pr/7');
    act(() => root.unmount());
    root = createRoot(container);
    render({ ...base, restoredRepoNote: 'docs/specs/checkout.md is no longer in the repo; restoring does not recreate it.' });
    expect(document.querySelector('[data-testid="spec-page-repo-state"] [data-testid="spec-page-restored-repo-file"]')?.textContent).toContain('restoring does not recreate it');
  });
});

describe('R-98: History picks two rows to compare', () => {
  const three = { ...base, spec: { ...base.spec, headRevision: 3, approvedRevision: 3 }, reading: { revision: 3, approved: true, isHead: true }, revisions: [rev(3), rev(2), rev(1)] };
  const rows = () => all('[data-revision], li').filter((r) => /^(Revision )?[123]\b/.test(words(r)) || r.hasAttribute('data-revision'))
    .filter((r, i, a) => !a.some((o) => o !== r && r.contains(o) && /^(Revision )?[123]\b/.test(words(o))));
  const pick = (n: number) => {
    const row = rows().find((r) => new RegExp(`^(Revision )?${n}\\b`).test(words(r)))!;
    const target = row.querySelector<HTMLElement>('input[type="checkbox"],[role="checkbox"],[aria-pressed],[aria-selected]') ?? row.querySelector<HTMLElement>('button') ?? row;
    click(target);
  };
  const compareControl = () => control(/Compare/);
  const disabled = (el: Element | undefined) => !!el && (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true');

  it('AC-134: two picked rows enable "Compare 1 → 2" and open the diff; one picked leaves Compare disabled', () => {
    render(three);
    click(tab(/^History/)!);
    expect(rows().map((r) => words(r).match(/^(?:Revision )?(\d)/)![1])).toEqual(['3', '2', '1']);
    expect(all('select').length).toBe(0);
    pick(2);
    expect(disabled(compareControl()) || compareControl() === undefined).toBe(true);
    pick(1);
    const go = compareControl()!;
    expect(go).toBeTruthy();
    expect(words(go)).toMatch(/Compare 1\s*→\s*2/);
    expect(disabled(go)).toBe(false);
    click(go);
    const target = go.getAttribute('href') ?? pushed[pushed.length - 1] ?? '';
    expect(target).toContain('from=1');
    expect(target).toContain('to=2');
  });

  it('R-98: a row says its number, badge, who and when, and its change summary in one line', () => {
    render(three);
    click(tab(/^History/)!);
    const top = words(rows()[0]!);
    expect(top).toMatch(/3/);
    expect(top).toMatch(/Waiting|Approved/);
    expect(top).toContain('Change 3');
    expect(top).toContain('3h ago');
  });
});
