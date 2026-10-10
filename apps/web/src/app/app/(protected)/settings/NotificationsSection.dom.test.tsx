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
  it('one Channels list with the personal row between the team rows; events titled Team alerts, unboxed', async () => {
    globalThis.fetch = mock(async () => new Response(JSON.stringify(STATE), { status: 200 })) as unknown as typeof fetch;
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root.render(<NotificationsSection workspaces={[{ id: 'w1', name: 'billing-web', teamId: 't1' }]} currentTeamId="t1" personal={<li data-testid="mine">mine</li>} />);
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    const rows = [...host.querySelectorAll('[data-testid="notification-channels"] > li')].map((li) => li.getAttribute('data-testid'));
    expect(rows).toEqual(['channel-pushover-team', 'mine', 'channel-webhook']);
    const headings = [...host.querySelectorAll('h2')].map((h) => h.textContent);
    expect(headings).toEqual(['Channels', 'Team alerts']);
    expect(host.querySelector('.inset-panel, .card')).toBeNull();
  });


  it('member: channel status and event choices, read-only, no inputs or buttons', async () => {
    await mount(false);
    expect(host.querySelector('[data-testid="notifications-read-only"]')!.textContent).toBe('Admins can change this.');
    // One state vocabulary across every channel row.
    expect(host.querySelector('[data-testid="channel-pushover-team"]')!.textContent).toContain('Connected');
    expect(host.querySelector('[data-testid="channel-webhook"]')!.textContent).toContain('Not connected');
    expect(host.textContent).not.toContain('Configured');
    expect(host.querySelectorAll('input[type="password"], input[type="url"], button').length).toBe(0);
    expect(checkboxes().map((c) => [c.checked, c.disabled])).toEqual([[false, true], [true, true], [true, true], [true, true]]);
  });

  it('admin: channel inputs, Save channel and live event toggles', async () => {
    await mount(true);
    expect(host.querySelector('[data-testid="notifications-read-only"]')).toBeNull();
    // Inputs open under the row on Replace / Set up, not all at once.
    expect(host.querySelectorAll('input[type="password"]').length).toBe(0);
    const replace = [...host.querySelectorAll('[data-testid="channel-pushover-team"] button')].find((b) => b.textContent === 'Replace') as HTMLButtonElement;
    await act(async () => { replace.click(); });
    expect(host.querySelectorAll('input[type="password"]').length).toBe(2);
    expect([...host.querySelectorAll('button')].map((b) => b.textContent)).toContain('Save channel');
    expect(checkboxes().every((c) => !c.disabled)).toBe(true);
  });
});
