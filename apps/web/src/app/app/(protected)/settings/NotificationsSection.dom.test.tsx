/**
 * Team notification settings are manage_team_notifications (the PUT route
 * refuses anyone else, with the team's overrides applied). A member sees which
 * channels are set and which events fire, read-only.
 *
 * Runs in its own process (scripts/run-unit-tests.ts), so the DOM globals stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/settings/notifications' });

import { afterEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: NotificationsSection } = await import('./NotificationsSection');

let host: HTMLElement;
let root: ReturnType<typeof createRoot>;
afterEach(() => { act(() => root.unmount()); host.remove(); });

const STATE = {
  channels: { pushover: true, webhook: false },
  preferences: { taskClaimed: false, taskCompleted: true, taskFailed: true, credentialExpired: true },
};

async function mount(canManage: boolean) {
  globalThis.fetch = mock(async () => new Response(JSON.stringify(STATE), { status: 200 })) as unknown as typeof fetch;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root.render(<NotificationsSection workspaces={[{ id: 'w1', name: 'billing-web', teamId: 't1' }]} currentTeamId="t1" canManage={canManage} />);
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

const checkboxes = () => [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];

describe('NotificationsSection: member vs admin', () => {
  it('member: channel status and event choices, read-only, no inputs or buttons', async () => {
    await mount(false);
    expect(host.querySelector('[data-testid="notifications-read-only"]')!.textContent).toBe('Admins can change this.');
    expect(host.textContent).toContain('Configured');
    expect(host.textContent).toContain('Not set');
    expect(host.querySelectorAll('input[type="password"], input[type="url"], button').length).toBe(0);
    expect(checkboxes().map((c) => [c.checked, c.disabled])).toEqual([[false, true], [true, true], [true, true], [true, true]]);
  });

  it('admin: channel inputs, Save channel and live event toggles', async () => {
    await mount(true);
    expect(host.querySelector('[data-testid="notifications-read-only"]')).toBeNull();
    expect(host.querySelectorAll('input[type="password"]').length).toBe(2);
    expect([...host.querySelectorAll('button')].map((b) => b.textContent)).toContain('Save channel');
    expect(checkboxes().every((c) => !c.disabled)).toBe(true);
  });
});
