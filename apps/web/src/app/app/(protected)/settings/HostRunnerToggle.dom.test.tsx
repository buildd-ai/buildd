/**
 * Host-runner toggle on a runner token: team owners/admins mark a runner they
 * host as trusted with team credentials (PUT /api/accounts/[id]/host-runner);
 * everyone else sees the state read-only.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/settings/runners', width: 1280, height: 800 });

import { afterEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: HostRunnerToggle } = await import('./HostRunnerToggle');

const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';

let host: HTMLElement;
let root: ReturnType<typeof createRoot>;
afterEach(() => { act(() => root.unmount()); host.remove(); });

async function render(props: { hostRunner: boolean; canManage: boolean }) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root.render(<HostRunnerToggle accountId={ACCOUNT_ID} {...props} />); });
}

const button = () => host.querySelector('[data-testid="host-runner-toggle"]') as HTMLButtonElement | null;
const state = () => host.querySelector('[data-testid="host-runner-state"]')?.textContent ?? '';

describe('HostRunnerToggle', () => {
  it('an admin turns it on with one PUT and sees the new state', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ id: ACCOUNT_ID, hostRunner: true }), { status: 200 });
    }) as unknown as typeof fetch;
    await render({ hostRunner: false, canManage: true });
    expect(state()).toContain('Not trusted');
    await act(async () => { button()!.click(); });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`/api/accounts/${ACCOUNT_ID}/host-runner`);
    expect(calls[0].init?.method).toBe('PUT');
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({ hostRunner: true });
    expect(state()).toContain('Trusted');
  });

  it('shows the server refusal and keeps the old state', async () => {
    globalThis.fetch = mock(async () => new Response(JSON.stringify({ error: 'Only team owners and admins can flag a host runner key' }), { status: 403 })) as unknown as typeof fetch;
    await render({ hostRunner: true, canManage: true });
    await act(async () => { button()!.click(); });
    expect(state()).toContain('Trusted');
    expect(host.textContent).toContain('Only team owners and admins');
  });

  it('a member sees the state with no control', async () => {
    await render({ hostRunner: true, canManage: false });
    expect(state()).toContain('Trusted');
    expect(button()).toBeNull();
  });
});
