/**
 * Settings for a team's passkey requirement (Living Spec b7fc9316 R-20),
 * mounted (happy-dom): the team switch, read-only for anyone but an owner and
 * guarded by the owner's own passkey; and Profile › Passkeys, where a person
 * adds and removes theirs.
 *
 * Runs in its own process (scripts/run-unit-tests.ts), so the DOM globals stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/settings/team' });

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

mock.module('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  usePathname: () => '/app/settings/team',
  useSearchParams: () => new URLSearchParams(),
}));
const prompts: string[] = [];
mock.module('@simplewebauthn/browser', () => ({
  startAuthentication: async () => { prompts.push('get'); return { id: 'cred', type: 'public-key', response: {} }; },
  startRegistration: async () => { prompts.push('create'); return { id: 'new', type: 'public-key', response: {} }; },
  browserSupportsWebAuthn: () => true,
}));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: SpecPasskeySetting } = await import('./SpecPasskeySetting');
const { default: PasskeysSection } = await import('../account/PasskeysSection');

const TEAM = '22222222-2222-4222-8222-222222222222';
let container: HTMLElement;
let root: ReturnType<typeof createRoot>;
const realFetch = globalThis.fetch;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); prompts.length = 0; });
afterEach(() => { act(() => root.unmount()); container.remove(); globalThis.fetch = realFetch; });

const sw = () => container.querySelector('[role="switch"]') as HTMLButtonElement;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('SpecPasskeySetting', () => {
  it('is off by default and read-only, with who can change it, for anyone but an owner', () => {
    act(() => root.render(<SpecPasskeySetting teamId={TEAM} initial={false} canChange={false} />));
    expect(sw().getAttribute('aria-checked')).toBe('false');
    expect(sw().disabled).toBe(true);
    expect(container.textContent).toContain('Only a team owner can change this.');
  });

  it('an owner turns it on with their own passkey', async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    globalThis.fetch = mock(async (url: string, init: RequestInit) => {
      const body = JSON.parse((init.body as string) ?? '{}');
      calls.push([url, body]);
      if (url === '/api/passkeys/presence') return json({ options: { challenge: 'c' } });
      return body.presence ? json({ required: true }) : json({ error: 'You need your own passkey.', code: 'presence_required', presence: { pin: { op: 'team_passkey', teamId: TEAM, required: true } } }, 403);
    }) as unknown as typeof fetch;
    act(() => root.render(<SpecPasskeySetting teamId={TEAM} initial={false} canChange />));
    await act(async () => { sw().click(); });
    expect(prompts).toEqual(['get']);
    expect(calls.map((c) => c[0])).toEqual([`/api/teams/${TEAM}/spec-passkey`, '/api/passkeys/presence', `/api/teams/${TEAM}/spec-passkey`]);
    expect(sw().getAttribute('aria-checked')).toBe('true');
  });

  it('an owner with no passkey stays off and is pointed at adding one', async () => {
    globalThis.fetch = mock(async () => json({ error: 'You need your own passkey to change whether this team requires a passkey, and you have no passkey.', code: 'passkey_missing' }, 403)) as unknown as typeof fetch;
    act(() => root.render(<SpecPasskeySetting teamId={TEAM} initial={false} canChange />));
    await act(async () => { sw().click(); });
    expect(sw().getAttribute('aria-checked')).toBe('false');
    const link = container.querySelector('[role="alert"] a') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/app/settings/account#passkeys');
  });
});

describe('PasskeysSection', () => {
  const byTestId = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement;

  it('with none, says so and offers Add passkey', () => {
    act(() => root.render(<PasskeysSection initial={[]} />));
    expect(byTestId('passkey-list').textContent).toContain('No passkeys.');
    expect(byTestId('passkey-add').textContent).toBe('Add passkey');
  });

  it('Add runs the prompt and lists the new passkey', async () => {
    globalThis.fetch = mock(async (url: string) => url === '/api/passkeys/register/options'
      ? json({ options: { challenge: 'r' } })
      : json({ passkey: { id: 'k1', name: 'Passkey', createdAt: '2026-10-27T10:00:00Z', lastUsedAt: null } })) as unknown as typeof fetch;
    act(() => root.render(<PasskeysSection initial={[]} />));
    await act(async () => { byTestId('passkey-add').click(); });
    expect(prompts).toEqual(['create']);
    expect(container.querySelectorAll('[data-testid="passkey-row"]').length).toBe(1);
    expect(byTestId('passkey-row').textContent).toContain('Added 27 Oct 2026');
    expect(byTestId('passkey-message').textContent).toContain('Passkey added.');
  });

  it('Remove asks once more, then removes it', async () => {
    globalThis.fetch = mock(async () => json({ ok: true })) as unknown as typeof fetch;
    act(() => root.render(<PasskeysSection initial={[{ id: 'k1', name: 'Passkey on Mac', createdAt: '2026-10-01T10:00:00Z', lastUsedAt: '2026-10-20T10:00:00Z' }]} />));
    expect(byTestId('passkey-row').textContent).toContain('last used 20 Oct 2026');
    await act(async () => { byTestId('passkey-remove').click(); });
    const confirm = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Remove' && b.className.includes('btn-danger')) as HTMLButtonElement;
    await act(async () => { confirm.click(); });
    expect(container.querySelectorAll('[data-testid="passkey-row"]').length).toBe(0);
  });
});
