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

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: SpecApprovalRequest } = await import('./SpecApprovalRequest');

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
};
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
    // The action comes before the text it approves.
    const approveBtn = q('spec-approval-approve')!;
    expect(approveBtn.compareDocumentPosition(rendered!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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
