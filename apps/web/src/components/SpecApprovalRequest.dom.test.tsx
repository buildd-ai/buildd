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

const ready = {
  state: 'ready' as const, title: 'Checkout', revision: 3, replaces: 2,
  sections: [{ kind: 'changed' as const, path: 'Checkout > Totals', level: 2, linesAdded: 1, linesRemoved: 1 }],
  diff: '@@ Checkout > Totals @@\n-old\n+new', omittedLines: 0,
};
const approveButton = () => container.querySelector('[data-testid="spec-approval-approve"]') as HTMLButtonElement | null;

describe('SpecApprovalRequest', () => {
  it('shows what changes and exactly one Approve action', () => {
    act(() => root.render(<SpecApprovalRequest specId={SPEC} token="tok" view={ready} />));
    expect(container.textContent).toContain('Revision 3 replaces revision 2.');
    expect(container.textContent).toContain('Checkout > Totals');
    expect(container.querySelectorAll('[data-testid="spec-approval-approve"]').length).toBe(1);
    expect(approveButton()!.textContent).toContain('Approve revision 3');
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
    expect(JSON.parse(calls[0][1].body as string)).toEqual({ request: 'tok' });
    expect(container.querySelector('[data-testid="spec-approval-result"]')!.textContent).toContain('Approved. Revision 3 is in force.');
    expect(approveButton()).toBeNull();
  });

  it('a stale answer from the server is shown and nothing is offered again', async () => {
    globalThis.fetch = mock(async () => new Response(JSON.stringify({ error: 'The spec changed since this approval was asked for. Ask for a new link.', code: 'request_stale' }), { status: 409 })) as unknown as typeof fetch;
    act(() => root.render(<SpecApprovalRequest specId={SPEC} token="tok" view={ready} />));
    await act(async () => { approveButton()!.click(); });
    expect(container.textContent).toContain('Ask for a new link.');
    expect(approveButton()).toBeNull();
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
});
