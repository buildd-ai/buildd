/**
 * The retire / restore confirm card, mounted (happy-dom): one Confirm action
 * that sends the request from this session; closed states carry no action
 * (Living Spec b7fc9316 R-11, R-12).
 *
 * Runs in its own process (scripts/run-unit-tests.ts), so the DOM globals stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app' });

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: SpecStatusRequest } = await import('./SpecStatusRequest');

const SPEC = '11111111-1111-4111-8111-111111111111';
let container: HTMLElement;
let root: ReturnType<typeof createRoot>;
const realFetch = globalThis.fetch;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); globalThis.fetch = realFetch; });

const q = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const ready = { state: 'ready' as const, title: 'Checkout', op: 'retire' as const, from: 'approved', to: 'retired', reason: 'A duplicate of the cart spec.', supersededBy: null };

describe('SpecStatusRequest', () => {
  it('says what changes and why, with one Confirm that posts the request token', async () => {
    const calls: Array<[string, RequestInit]> = [];
    globalThis.fetch = mock(async (url: string, init: RequestInit) => { calls.push([url, init]); return new Response('{}', { status: 200 }); }) as unknown as typeof fetch;
    act(() => root.render(<SpecStatusRequest specId={SPEC} token="tok" view={ready} />));
    expect(container.textContent).toContain('from approved to retired');
    expect(q('spec-status-reason')!.textContent).toBe('A duplicate of the cart spec.');
    await act(async () => { q('spec-status-confirm')!.click(); });
    expect(calls[0][0]).toBe(`/api/specs/${SPEC}/retire/confirm`);
    expect(JSON.parse(calls[0][1].body as string)).toEqual({ request: 'tok' });
    expect(q('spec-status-result')!.textContent).toBe('Done: the spec is retired.');
    expect(q('spec-status-confirm')).toBeNull();
  });

  it('a stale answer is shown and nothing is offered again', async () => {
    globalThis.fetch = mock(async () => new Response(JSON.stringify({ error: 'The spec changed since this was asked for.', code: 'request_stale' }), { status: 409 })) as unknown as typeof fetch;
    act(() => root.render(<SpecStatusRequest specId={SPEC} token="tok" view={{ ...ready, op: 'restore', from: 'retired', to: 'approved' }} />));
    expect(q('spec-status-confirm')!.textContent).toBe('Restore spec');
    await act(async () => { q('spec-status-confirm')!.click(); });
    expect(container.textContent).toContain('changed since this was asked for');
    expect(q('spec-status-confirm')).toBeNull();
  });

  it('closed states have no Confirm action', () => {
    for (const view of [{ state: 'invalid' as const }, { state: 'expired' as const }, { state: 'not_approver' as const }, { state: 'stale' as const, title: 'Checkout', status: 'retired' }]) {
      act(() => root.render(<SpecStatusRequest specId={SPEC} token="tok" view={view} />));
      expect(q('spec-status-confirm')).toBeNull();
      expect(q('spec-status-state')).not.toBeNull();
    }
  });
});
