/**
 * Profile › Your teams: each team you can leave has its own Leave button, the
 * same DELETE /api/teams/[id]/members/[userId] that Members › Danger zone sends
 * (docs/specs/team-permissions.md). No Leave on a personal team; the last owner
 * sees it disabled. Fixtures are illustrative.
 *
 * Runs in its own process (scripts/run-unit-tests.ts), so the DOM globals stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/settings/account' });

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

const push = mock(() => {});
mock.module('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {}, push, replace: () => {}, prefetch: () => {} }),
  usePathname: () => '/app/settings/account',
  useSearchParams: () => new URLSearchParams(),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: YourTeams } = await import('./YourTeams');

const TEAMS = [
  { id: 'team-personal', name: 'Me', slug: 'personal-me', role: 'owner', memberCount: 1, ownerCount: 1 },
  { id: 'team-acme', name: 'Acme', slug: 'acme', role: 'member', memberCount: 4, ownerCount: 1 },
  { id: 'team-solo', name: 'Solo Owner', slug: 'solo', role: 'owner', memberCount: 3, ownerCount: 1 },
];

let host: HTMLElement;
let root: ReturnType<typeof createRoot>;
const realFetch = globalThis.fetch;
let calls: { url: string; method?: string }[] = [];

beforeEach(() => {
  calls = [];
  push.mockClear();
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method });
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  globalThis.fetch = realFetch;
});

async function mount() {
  await act(async () => { root.render(<YourTeams teams={TEAMS} currentTeamId="team-acme" userId="user-1" />); });
}
const row = (id: string) => host.querySelector(`[data-testid="profile-team-${id}"]`) as HTMLElement;
const leaveIn = (id: string) => row(id).querySelector('[data-testid="profile-leave-team"]') as HTMLButtonElement | null;

describe('YourTeams', () => {
  it('offers Leave on a shared team, never on a personal one', async () => {
    await mount();
    expect(leaveIn('team-personal')).toBeNull();
    expect(leaveIn('team-acme')).not.toBeNull();
    expect(leaveIn('team-acme')!.disabled).toBe(false);
  });

  it('disables Leave for the last owner and says why', async () => {
    await mount();
    expect(leaveIn('team-solo')!.disabled).toBe(true);
    expect(row('team-solo').textContent).toContain('Make someone else an owner to leave');
  });

  it('leaves through the members route after confirming', async () => {
    await mount();
    await act(async () => { leaveIn('team-acme')!.click(); });
    const confirmBtn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Leave team' && !b.hasAttribute('data-testid'));
    expect(confirmBtn).toBeDefined();
    await act(async () => { confirmBtn!.click(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(calls).toEqual([{ url: '/api/teams/team-acme/members/user-1', method: 'DELETE' }]);
  });

  it('keeps each team a link to its members', async () => {
    await mount();
    expect(row('team-acme').querySelector('a')!.getAttribute('href')).toBe('/app/settings/team');
    expect(row('team-solo').querySelector('a')!.getAttribute('href')).toBe('/app/settings/team?team=team-solo');
  });
});
