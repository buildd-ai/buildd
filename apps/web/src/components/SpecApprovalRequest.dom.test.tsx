/**
 * The spec approval confirm card, mounted (happy-dom): one Approve action that
 * sends the request token from this session; closed states carry no action.
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
  usePathname: () => '/app/specs/approvals',
  useSearchParams: () => new URLSearchParams(),
}));

// The browser's passkey prompt (Living Spec b7fc9316 R-20): answered, or dismissed.
let passkeyAnswer: 'complete' | 'dismiss' = 'complete';
const prompts: unknown[] = [];
mock.module('@simplewebauthn/browser', () => ({
  startAuthentication: async (o: { optionsJSON: unknown }) => {
    prompts.push(o.optionsJSON);
    if (passkeyAnswer === 'dismiss') throw new Error('NotAllowedError');
    return { id: 'cred', type: 'public-key', response: { clientDataJSON: 'x' } };
  },
  startRegistration: async () => ({}),
  browserSupportsWebAuthn: () => true,
}));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: SpecApprovalRequest } = await import('./SpecApprovalRequest');
const { explanationCoverage } = await import('@buildd/spec-contract/explanation');

const SPEC = '11111111-1111-4111-8111-111111111111';
let container: HTMLElement;
let root: ReturnType<typeof createRoot>;
const realFetch = globalThis.fetch;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  globalThis.fetch = realFetch;
});

const LONG = `R-1: ${'a very long requirement line that has to wrap rather than run off the edge '.repeat(4)}`;
const ready = {
  state: 'ready' as const, title: 'Checkout', revision: 3, replaces: 2 as number | null,
  pin: { revision: 3, expectedVersion: 7, contentHash: 'c'.repeat(64) },
  passkey: false,
  sections: [{ kind: 'changed' as const, path: 'Checkout > Totals', level: 2, linesAdded: 1, linesRemoved: 1 }],
  hunks: [{
    kind: 'changed' as const, path: 'Checkout > Totals', linesAdded: 1, linesRemoved: 1,
    rows: [
      { op: ' ' as const, oldLine: 3, newLine: 3, text: '## Totals' },
      { op: 'gap' as const, oldLine: null, newLine: null, text: '' },
      { op: '-' as const, oldLine: 9, newLine: null, text: 'R-1: old' },
      { op: '+' as const, oldLine: null, newLine: 9, text: LONG },
    ],
  }],
  omittedLines: 0,
  gate: { passed: true, refusals: [], warnings: [] } as { passed: boolean; refusals: Array<{ code: string; message: string }>; warnings: Array<{ code: string; message: string }> },
  changes: {
    summary: 'Totals now round to cents.',
    lines: [{ kind: 'changed' as const, id: 'R-1', text: 'Totals round to cents.', oldText: 'Totals are exact.', words: [{ op: '=' as const, text: 'Totals ' }, { op: '-' as const, text: 'are exact' }, { op: '+' as const, text: 'round to cents' }, { op: '=' as const, text: '.' }], section: 'Checkout > Totals' }],
    otherText: [], mismatch: null,
  } as { summary: string | null; lines: never[]; otherText: never[]; mismatch: string | null },
  body: '# Checkout\n\n## Totals\n\n- R-1: **Totals** are in the shopper currency.\n',
  explanation: { summary: 'Totals round to cents.', lines: { 'R-1': 'Totals now round to the cent.' } } as { summary: string; lines: Record<string, string> } | null,
  coverage: null as ReturnType<typeof explanationCoverage> | null,
  sectionWords: {} as Record<string, Array<{ op: '=' | '+' | '-'; text: string }>>,
};
ready.coverage = explanationCoverage(ready.explanation, ready.changes.lines, []);
const first = { ...ready, replaces: null, sections: [{ kind: 'added' as const, path: 'Checkout', level: 1, linesAdded: 5, linesRemoved: 0 }] };
const q = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const radio = (label: string) => [...container.querySelectorAll('[role="radio"]')].find((b) => b.textContent === label) as HTMLButtonElement;
const approveButton = () => container.querySelector('[data-testid="spec-approval-approve"]') as HTMLButtonElement | null;

describe('SpecApprovalRequest', () => {
  it('shows what changes and exactly one Approve action', () => {
    act(() => root.render(<SpecApprovalRequest specId={SPEC} token="tok" view={ready} />));
    expect(container.textContent).toContain('Revision 3 replaces revision 2.');
    expect(container.textContent).toContain('Checkout > Totals');
    expect(container.querySelectorAll('[data-testid="spec-approval-approve"]').length).toBe(1);
    expect(approveButton()!.textContent).toContain('Approve revision 3');
  });

  it('leads with what changed since the approved revision, words marked, and that the gate passed', () => {
    act(() => root.render(<SpecApprovalRequest specId={SPEC} token="tok" view={ready} />));
    expect(q('spec-review-summary')!.textContent).toBe('Totals now round to cents.');
    expect(q('spec-review-criteria')!.textContent).toContain('R-1');
    expect(q('spec-approval-gate')!.textContent).toContain('Quality gate passed.');
    expect(q('spec-approval-override-reason')).toBeNull();
  });

  it('warnings are shown and do not stop Approve', () => {
    const view = { ...ready, gate: { passed: true, refusals: [], warnings: [{ code: 'no_change_summary', message: 'The revision has no change summary.' }] } };
    act(() => root.render(<SpecApprovalRequest specId={SPEC} token="tok" view={view} />));
    expect(q('spec-approval-warnings')!.textContent).toContain('The revision has no change summary.');
    expect(approveButton()!.disabled).toBe(false);
    expect(approveButton()!.textContent).toBe('Approve revision 3');
  });

  it('a refusal lists its reasons and needs a reason to approve anyway, which is sent with the request', async () => {
    const calls: unknown[] = [];
    globalThis.fetch = mock(async (_u: string, init: RequestInit) => { calls.push(JSON.parse(init.body as string)); return new Response('{}', { status: 200 }); }) as unknown as typeof fetch;
    const view = { ...ready, gate: { passed: false, refusals: [{ code: 'duplicate_id', message: 'R-2 is defined more than once.' }], warnings: [] } };
    act(() => root.render(<SpecApprovalRequest specId={SPEC} token="tok" view={view} />));
    expect(q('spec-approval-refusals')!.textContent).toContain('R-2 is defined more than once.');
    expect(approveButton()!.textContent).toBe('Override and approve revision 3');
    expect(approveButton()!.disabled).toBe(true);
    const box = q('spec-approval-override-reason') as unknown as HTMLTextAreaElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, 'Checked with the owner.');
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(approveButton()!.disabled).toBe(false);
    await act(async () => { approveButton()!.click(); });
    expect(calls).toEqual([{ request: 'tok', retire: [], overrideReason: 'Checked with the owner.' }]);
  });

  it('Approve posts the request token to the confirm route and reports the result', async () => {
    const calls: Array<[string, RequestInit]> = [];
    globalThis.fetch = mock(async (url: string, init: RequestInit) => {
      calls.push([url, init]);
      return new Response(JSON.stringify({ already: false }), { status: 200 });
    }) as unknown as typeof fetch;
    act(() => root.render(<SpecApprovalRequest specId={SPEC} token="tok" view={ready} />));
    await act(async () => { approveButton()!.click(); });
    expect(calls.length).toBe(1);
    expect(calls[0][0]).toBe(`/api/specs/${SPEC}/approve/confirm`);
    expect(JSON.parse(calls[0][1].body as string)).toEqual({ request: 'tok', retire: [] });
    expect(container.querySelector('[data-testid="spec-approval-result"]')!.textContent).toContain('Approved revision 3.');
    expect(approveButton()).toBeNull();
  });

  it('a stale answer from the server is shown and nothing is offered again', async () => {
    globalThis.fetch = mock(async () => new Response(JSON.stringify({ error: 'The spec changed since this approval was asked for. Ask for a new link.', code: 'request_stale' }), { status: 409 })) as unknown as typeof fetch;
    act(() => root.render(<SpecApprovalRequest specId={SPEC} token="tok" view={ready} />));
    await act(async () => { approveButton()!.click(); });
    expect(container.textContent).toContain('Ask for a new link.');
    expect(approveButton()).toBeNull();
  });

  it('reads as approved on the press, and a failure rolls back to the action', async () => {
    let answer!: (r: Response) => void;
    globalThis.fetch = mock(() => new Promise<Response>(r => { answer = r; })) as unknown as typeof fetch;
    act(() => root.render(<SpecApprovalRequest specId={SPEC} token="tok" view={ready} />));
    await act(async () => { approveButton()!.click(); });
    expect(q('spec-approval-result')!.textContent).toBe('Approved revision 3.');
    expect(approveButton()).toBeNull();
    await act(async () => { answer(new Response(JSON.stringify({}), { status: 500 })); });
    expect(q('spec-approval-result')!.textContent).toBe('Approval failed. Try again.');
    expect(approveButton()).not.toBeNull();
  });

  it('a first approval opens on the spec itself, rendered as Markdown', () => {
    act(() => root.render(<SpecApprovalRequest specId={SPEC} token="tok" view={first} />));
    expect(container.textContent).toContain('Nothing is approved yet.');
    const rendered = q('spec-approval-rendered');
    expect(rendered).not.toBeNull();
    // The action sits in a sticky bar after the text it approves, so it is in view while the text is read (b7fc9316 R-14).
    const bar = q('spec-approval-bar')!;
    expect(rendered!.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(bar.className).toContain('sticky');
    expect(rendered!.querySelector('h2')!.textContent).toBe('Totals');
    expect(rendered!.querySelector('strong')!.textContent).toBe('Totals');
    expect(q('spec-approval-diff')).toBeNull();
    expect(radio('Spec').getAttribute('aria-checked')).toBe('true');
  });

  it('a later approval opens on the changes, and the toggle switches to the spec', () => {
    act(() => root.render(<SpecApprovalRequest specId={SPEC} token="tok" view={ready} />));
    expect(q('spec-approval-diff')).not.toBeNull();
    expect(q('spec-approval-rendered')).toBeNull();
    act(() => radio('Spec').click());
    expect(q('spec-approval-rendered')).not.toBeNull();
    expect(q('spec-approval-diff')).toBeNull();
    act(() => radio('Changes').click());
    expect(q('spec-approval-diff')).not.toBeNull();
  });

  it('changes read like a code review: section header, line numbers, added and removed rows', () => {
    act(() => root.render(<SpecApprovalRequest specId={SPEC} token="tok" view={ready} />));
    const hunk = container.querySelector('[data-testid="spec-diff-hunk"]')!;
    expect(hunk.querySelector('[data-testid="spec-diff-hunk-header"]')!.textContent).toContain('Checkout > Totals');
    expect(hunk.querySelector('[data-testid="spec-diff-hunk-header"]')!.textContent).toContain('+1');
    const rows = [...hunk.querySelectorAll('[data-testid="spec-diff-row"]')] as HTMLElement[];
    expect(rows.map((r) => r.dataset.op)).toEqual(['ctx', 'gap', 'del', 'add']);
    const nums = (r: HTMLElement) => [...r.querySelectorAll('[data-line]')].map((n) => n.textContent);
    expect(nums(rows[0])).toEqual(['3', '3']);
    expect(nums(rows[2])).toEqual(['9', '']);
    expect(nums(rows[3])).toEqual(['', '9']);
  });

  it('long lines wrap instead of being cut off', () => {
    act(() => root.render(<SpecApprovalRequest specId={SPEC} token="tok" view={ready} />));
    const add = [...container.querySelectorAll('[data-testid="spec-diff-row"]')].find((r) => (r as HTMLElement).dataset.op === 'add')!;
    const code = add.querySelector('[data-testid="spec-diff-text"]')!;
    expect(code.textContent).toBe(LONG);
    expect(code.className).toContain('whitespace-pre-wrap');
    expect(code.className).toContain('[overflow-wrap:anywhere]');
    expect(q('spec-approval-diff')!.className).not.toContain('overflow-x-auto');
  });

  it('switching views never changes what Approve confirms', async () => {
    const bodies: unknown[] = [];
    globalThis.fetch = mock(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string));
      return new Response(JSON.stringify({ already: false }), { status: 200 });
    }) as unknown as typeof fetch;
    act(() => root.render(<SpecApprovalRequest specId={SPEC} token="tok" view={ready} />));
    act(() => radio('Spec').click());
    expect(approveButton()!.textContent).toContain('Approve revision 3');
    act(() => radio('Changes').click());
    act(() => radio('Spec').click());
    expect(approveButton()!.textContent).toContain('Approve revision 3');
    await act(async () => { approveButton()!.click(); });
    expect(bodies).toEqual([{ request: 'tok', retire: [] }]);
  });

  it('says how much of a long diff it left out', () => {
    act(() => root.render(<SpecApprovalRequest specId={SPEC} token="tok" view={{ ...ready, omittedLines: 42 }} />));
    expect(q('spec-approval-diff')!.textContent).toContain('42 more lines');
  });

  it('closed states have no Approve action', () => {
    for (const view of [
      { state: 'expired' as const },
      { state: 'invalid' as const },
      { state: 'stale' as const, title: 'Checkout', revision: 3 },
      { state: 'not_approver' as const, title: 'Checkout', revision: 3 },
      { state: 'approved' as const, title: 'Checkout', revision: 3 },
    ]) {
      act(() => root.render(<SpecApprovalRequest specId={SPEC} token="tok" view={view} />));
      expect(approveButton()).toBeNull();
      expect(container.querySelector('[data-testid="spec-approval-state"]')).not.toBeNull();
    }
  });

  it('R-77: lists the replaced specs as the link chose them, and confirms with the person\'s choice', async () => {
    const A = '22222222-2222-4222-8222-222222222222';
    const B = '33333333-3333-4333-8333-333333333333';
    const bodies: unknown[] = [];
    globalThis.fetch = (async (_u: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string));
      return new Response(JSON.stringify({ retirements: [{ specId: A, title: 'Old A', state: 'stale', reason: 'moved' }] }), { status: 200 });
    }) as typeof fetch;
    const view = { ...ready, replacing: [{ id: A, title: 'Old A', version: 4, checked: true }, { id: B, title: 'Old B', version: 2, checked: false }] };
    act(() => root.render(<SpecApprovalRequest specId={SPEC} token="tok" view={view} />));
    const boxes = [...container.querySelectorAll('[data-testid="spec-approve-retire"]')] as HTMLInputElement[];
    expect(boxes.map((b) => b.checked)).toEqual([true, false]);
    expect(approveButton()!.textContent).toBe('Approve and retire');
    await act(async () => { approveButton()!.click(); });
    expect(bodies).toEqual([{ request: 'tok', retire: [{ specId: A, expectedVersion: 4 }] }]);
    // A replaced spec that moved since: the approval stands, the page says it was not retired.
    expect(q('spec-approval-result')!.textContent).toBe('Approved revision 3. Old A was not retired: it changed after you opened this. Retire it from its own page.');
  });

  describe('as an inbox row (no token)', () => {
    it('Approve posts the pin it was rendered with to the inbox route, from this session', async () => {
      const calls: Array<[string, RequestInit]> = [];
      globalThis.fetch = mock(async (url: string, init: RequestInit) => {
        calls.push([url, init]);
        return new Response(JSON.stringify({ already: false }), { status: 200 });
      }) as unknown as typeof fetch;
      act(() => root.render(<SpecApprovalRequest specId={SPEC} view={ready} showTitle={false} />));
      expect(q('spec-approval-title')).toBeNull();
      await act(async () => { approveButton()!.click(); });
      expect(calls[0][0]).toBe(`/api/specs/${SPEC}/approve/inbox`);
      expect(JSON.parse(calls[0][1].body as string)).toEqual({ revision: 3, expectedVersion: 7, contentHash: 'c'.repeat(64) });
      expect(q('spec-approval-result')!.textContent).toBe('Approved revision 3.');
    });

    it('a gate refusal sends the reason with the pin', async () => {
      const bodies: unknown[] = [];
      globalThis.fetch = mock(async (_u: string, init: RequestInit) => { bodies.push(JSON.parse(init.body as string)); return new Response('{}', { status: 200 }); }) as unknown as typeof fetch;
      const view = { ...ready, gate: { passed: false, refusals: [{ code: 'acceptance_unjudgeable', message: 'AC-1 cannot be graded.' }], warnings: [] } };
      act(() => root.render(<SpecApprovalRequest specId={SPEC} view={view} />));
      const box = q('spec-approval-override-reason') as unknown as HTMLTextAreaElement;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, 'Shipping it as is for now.');
        box.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await act(async () => { approveButton()!.click(); });
      expect(bodies).toEqual([{ revision: 3, expectedVersion: 7, contentHash: 'c'.repeat(64), overrideReason: 'Shipping it as is for now.' }]);
    });

    it('a stale answer says so and reloads the page so the row shows the new head', async () => {
      refreshes = 0;
      globalThis.fetch = mock(async () => new Response(JSON.stringify({ error: 'The spec changed since this page loaded.', code: 'stale' }), { status: 409 })) as unknown as typeof fetch;
      act(() => root.render(<SpecApprovalRequest specId={SPEC} view={ready} />));
      await act(async () => { approveButton()!.click(); });
      expect(container.textContent).toContain('The spec changed since this page loaded.');
      expect(refreshes).toBe(1);
      expect(approveButton()).toBeNull();
    });
  });
});

/** One decision on one screen (Living Spec b7fc9316 R-14 to R-19, AC-12 to AC-17). */
describe('SpecApprovalRequest: the explanation and its check', () => {
  // Enough unchanged words that the change reads inline (marked words), not as Was and Now.
  const words = (was: string, now: string) => [{ op: '=' as const, text: 'Every total in the cart is ' }, { op: '-' as const, text: was }, { op: '+' as const, text: now }, { op: '=' as const, text: ' before the shopper pays for the order.' }];
  const ch = (id: string) => ({ kind: 'changed' as const, id, text: `${id} now`, oldText: `${id} was`, words: words(`${id} was`, `${id} now`), section: 'Checkout > Totals' });
  const four = [ch('R-1'), ch('R-2'), ch('R-3'), ch('AC-1')];
  const other = [{ kind: 'changed' as const, section: 'Checkout > Context' }];
  const viewWith = (lines: Record<string, string> | null, opts: { other?: boolean } = {}) => {
    const explanation = lines ? { summary: 'Totals round to cents.', lines } : null;
    const otherText = opts.other ? other : [];
    const changes = { summary: 'Totals.', lines: four as never[], otherText: otherText as never[], mismatch: null };
    return {
      ...ready, changes, explanation,
      coverage: explanationCoverage(explanation, four, otherText),
      sectionWords: opts.other ? { 'Checkout > Context': words('old context', 'new context') } : {},
    };
  };
  const all = { 'R-1': 'a', 'R-2': 'b', 'R-3': 'c', 'AC-1': 'd' };
  const toggleFor = (key: string) => container.querySelector(`[data-testid="spec-explain-item"][data-key="${key}"] [data-testid="spec-explain-toggle"]`) as HTMLButtonElement;

  it('AC-12: the explanation and its check lead, and the page holds exactly one Approve, in a bar that stays in view', () => {
    act(() => root.render(<SpecApprovalRequest specId={SPEC} token="tok" view={viewWith(all)} />));
    const decision = q('spec-approval-decision')!;
    // The check is the first thing after the title line, above the change list and the full text.
    const order = [...decision.querySelectorAll('[data-testid="spec-explain"], [data-testid="spec-review-changes"], [data-testid="spec-approval-bar"]')].map((e) => e.getAttribute('data-testid'));
    expect(order).toEqual(['spec-explain', 'spec-review-changes', 'spec-approval-bar']);
    expect(container.querySelectorAll('[data-testid="spec-approval-approve"]').length).toBe(1);
    const bar = q('spec-approval-bar')!;
    expect(bar.contains(approveButton())).toBe(true);
    // Sticky to the bottom of the view: above the phone tab bar, at the edge from md.
    expect(bar.className).toContain('sticky');
    expect(bar.className).toContain('bottom-[calc(3.5rem+env(safe-area-inset-bottom))]');
    expect(bar.className).toContain('md:bottom-0');
    // It is the last thing in the decision, so it sticks for the whole length of the revision.
    expect(decision.lastElementChild).toBe(bar);
  });

  it('AC-13: four changed criteria and a line for each read "covers 4 of 4" and Approve is enabled', () => {
    act(() => root.render(<SpecApprovalRequest specId={SPEC} token="tok" view={viewWith(all)} />));
    expect(q('spec-explain-coverage')!.textContent).toBe('Explanation covers 4 of 4 changes');
    expect(q('spec-explain-missing')).toBeNull();
    expect(approveButton()!.disabled).toBe(false);
  });

  it('AC-14: a criterion the explanation misses is under Not explained, and Approve waits until it is opened', async () => {
    act(() => root.render(<SpecApprovalRequest specId={SPEC} token="tok" view={viewWith({ 'R-1': 'a', 'R-2': 'b', 'AC-1': 'd' })} />));
    expect(q('spec-explain-coverage')!.textContent).toBe('Covers 3 of 4: 1 not explained');
    const missing = [...q('spec-explain-missing')!.querySelectorAll('[data-testid="spec-explain-item"]')].map((e) => e.getAttribute('data-key'));
    expect(missing).toEqual(['R-3']);
    expect(approveButton()!.disabled).toBe(true);
    expect(q('spec-approval-bar-status')!.textContent).toBe('Open the change marked Not explained to approve.');
    // Opening an explained line is not required and does not enable it.
    await act(async () => { toggleFor('R-1').click(); });
    expect(approveButton()!.disabled).toBe(true);
    await act(async () => { toggleFor('R-3').click(); });
    expect(approveButton()!.disabled).toBe(false);
  });

  it('AC-15: a line naming a criterion that did not change is shown apart', () => {
    act(() => root.render(<SpecApprovalRequest specId={SPEC} token="tok" view={viewWith({ ...all, 'R-9': 'ghost' })} />));
    const extra = q('spec-explain-extra')!;
    expect(extra.textContent).toContain('Explains something that did not change');
    expect([...extra.querySelectorAll('[data-testid="spec-explain-extra-item"]')].map((e) => e.getAttribute('data-key'))).toEqual(['R-9']);
  });

  it('AC-16: with no explanation every change is not explained, and Approve enables once each is opened', async () => {
    act(() => root.render(<SpecApprovalRequest specId={SPEC} token="tok" view={viewWith(null, { other: true })} />));
    expect(q('spec-explain-coverage')!.textContent).toBe('No explanation: 0 of 5 changes explained');
    expect(q('spec-approval-bar-status')!.textContent).toBe('Open the 5 changes marked Not explained to approve.');
    for (const key of ['R-1', 'R-2', 'R-3', 'AC-1']) {
      expect(approveButton()!.disabled).toBe(true);
      await act(async () => { toggleFor(key).click(); });
    }
    expect(approveButton()!.disabled).toBe(true);
    await act(async () => { toggleFor('Checkout > Context').click(); });
    expect(approveButton()!.disabled).toBe(false);
  });

  it('AC-17: any line opens in place to the exact changed words of its criterion or section', async () => {
    act(() => root.render(<SpecApprovalRequest specId={SPEC} token="tok" view={viewWith({ ...all, Context: 'Reworded the context.' }, { other: true })} />));
    const item = (key: string) => container.querySelector(`[data-testid="spec-explain-item"][data-key="${key}"]`)!;
    expect(item('R-2').querySelector('[data-testid="spec-explain-words"]')).toBeNull();
    await act(async () => { toggleFor('R-2').click(); });
    const opened = item('R-2').querySelector('[data-testid="spec-explain-words"]')!;
    expect(opened.querySelector('[data-testid="spec-review-word-removed"]')!.textContent).toBe('R-2 was');
    expect(opened.querySelector('[data-testid="spec-review-word-added"]')!.textContent).toBe('R-2 now');
    expect(toggleFor('R-2').getAttribute('aria-expanded')).toBe('true');
    await act(async () => { toggleFor('Checkout > Context').click(); });
    const section = item('Checkout > Context').querySelector('[data-testid="spec-explain-words"]')!;
    expect(section.querySelector('[data-testid="spec-review-word-removed"]')!.textContent).toBe('old context');
    expect(section.querySelector('[data-testid="spec-review-word-added"]')!.textContent).toBe('new context');
  });

  it('R-18: the page says what the check proves, and that the explanation is the agent\'s', () => {
    act(() => root.render(<SpecApprovalRequest specId={SPEC} token="tok" view={viewWith(all)} />));
    expect(q('spec-explain-honesty')!.textContent).toBe('The agent wrote this explanation. The check confirms it mentions every change; whether it is right is yours to judge.');
  });

  describe('a team that requires a passkey (R-20, AC-19)', () => {
    const PIN = { op: 'approve', specId: SPEC, revision: 3, version: 7, contentHash: 'c'.repeat(64) };
    const asked = () => new Response(JSON.stringify({ error: 'This team requires a passkey to approve a spec.', code: 'presence_required', presence: { pin: PIN, addUrl: 'x' } }), { status: 403 });
    function serve(final: () => Response) {
      const calls: Array<[string, Record<string, unknown>]> = [];
      globalThis.fetch = mock(async (url: string, init: RequestInit) => {
        const body = JSON.parse((init.body as string) ?? '{}');
        calls.push([url, body]);
        if (url === '/api/passkeys/presence') return new Response(JSON.stringify({ options: { challenge: 'chal' } }), { status: 200 });
        return body.presence ? final() : asked();
      }) as unknown as typeof fetch;
      return calls;
    }

    it('completing the passkey sends the assertion over the pin the server named, and the revision is approved', async () => {
      passkeyAnswer = 'complete';
      const calls = serve(() => new Response(JSON.stringify({ already: false }), { status: 200 }));
      act(() => root.render(<SpecApprovalRequest specId={SPEC} view={{ ...ready, passkey: true }} />));
      await act(async () => { approveButton()!.click(); });
      expect(calls.map((c) => c[0])).toEqual([`/api/specs/${SPEC}/approve/inbox`, '/api/passkeys/presence', `/api/specs/${SPEC}/approve/inbox`]);
      expect(calls[1][1]).toEqual({ pin: PIN });
      expect(calls[2][1].presence).toMatchObject({ id: 'cred', type: 'public-key' });
      expect(q('spec-approval-result')!.textContent).toContain('Approved revision 3.');
    });

    it('dismissing the prompt sends nothing more, says nothing changed, and offers Approve again', async () => {
      passkeyAnswer = 'dismiss';
      const calls = serve(() => new Response('{}', { status: 200 }));
      act(() => root.render(<SpecApprovalRequest specId={SPEC} view={{ ...ready, passkey: true }} />));
      await act(async () => { approveButton()!.click(); });
      expect(calls.filter((c) => c[1].presence).length).toBe(0);
      expect(q('spec-approval-result')!.textContent).toContain('Nothing changed.');
      expect(approveButton()).not.toBeNull();
      passkeyAnswer = 'complete';
    });

    it('a person with no passkey is told how to add one, with a link to add it', async () => {
      globalThis.fetch = mock(async () => new Response(JSON.stringify({ error: 'This team requires a passkey to approve a spec, and you have no passkey. Add one in Settings › Profile › Passkeys, then try again. Nothing changed.', code: 'passkey_missing', presence: { pin: PIN, addUrl: 'x' } }), { status: 403 })) as unknown as typeof fetch;
      act(() => root.render(<SpecApprovalRequest specId={SPEC} view={{ ...ready, passkey: true }} />));
      await act(async () => { approveButton()!.click(); });
      const result = q('spec-approval-result')!;
      expect(result.textContent).toContain('Settings › Profile › Passkeys');
      const link = [...result.querySelectorAll('a')].find((a) => a.textContent === 'Add a passkey') as HTMLAnchorElement;
      expect(link.getAttribute('href')).toBe('/app/settings/account#passkeys');
    });
  });
});
