/**
 * The team timezone is one fact with one select: an L1 row on a hairline, never
 * a card around a single select.
 *
 * Runs in its own process (scripts/run-unit-tests.ts), so the DOM globals stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/settings/team', width: 1280, height: 800 });

import { afterEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: TimezoneSection } = await import('./TimezoneSection');

let host: HTMLElement;
let root: ReturnType<typeof createRoot>;
afterEach(() => { act(() => root.unmount()); host.remove(); });

async function mount(role: string) {
  globalThis.fetch = mock(async () => new Response(JSON.stringify({
    team: { timezone: 'Europe/Lisbon', permissionOverrides: null },
    currentUserRole: role,
  }), { status: 200 })) as unknown as typeof fetch;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root.render(<TimezoneSection teams={[{ id: 't1', name: 'Harborline' }]} currentTeamId="t1" />); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

describe('TimezoneSection', () => {
  it('is one row, with no card around the select', async () => {
    await mount('owner');
    const row = host.querySelector('[data-testid="team-timezone-row"]');
    expect(row).not.toBeNull();
    expect(row!.textContent).toContain('Team timezone');
    expect(host.querySelector('.card')).toBeNull();
  });

  it('a member reads the zone and is told who can change it', async () => {
    await mount('member');
    expect(host.textContent).toContain('Europe/Lisbon');
    expect(host.querySelector('[data-testid="timezone-read-only"]')!.textContent).toBe('Admins can change this.');
  });
});
