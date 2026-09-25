/**
 * UserAvatarMenu, TeamSwitcher and TeamSwitcherRail, mounted (happy-dom).
 *
 * All three announced `aria-haspopup="menu"` but their items were plain links
 * and buttons with no menuitem role and no arrow-key handling, so a screen
 * reader promised a menu the keyboard could not drive. They are disclosures:
 * a button with aria-expanded + aria-controls that toggles a panel of ordinary
 * links/buttons. Escape closes the panel and puts focus back on the trigger.
 *
 * Runs in its own process (scripts/run-unit-tests.ts), so the DOM globals and
 * module mocks stay here. Fixtures are illustrative.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/missions', width: 390, height: 844 });

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

mock.module('next-auth/react', () => ({ signOut: () => {} }));
const switched: string[] = [];
mock.module('@/lib/switch-team', () => ({ switchTeam: (id: string) => switched.push(id) }));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: UserAvatarMenu } = await import('./UserAvatarMenu');
const { TeamSwitcher } = await import('./TeamSwitcher');
const { default: TeamSwitcherRail } = await import('./TeamSwitcherRail');

const TEAMS = [
  { id: 'team-a', name: 'Team A', slug: 'team-a' },
  { id: 'team-b', name: 'Team B', slug: 'team-b' },
];

let host: HTMLElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  switched.length = 0;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function pressEscape(target: Element) {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
}

const cases: Array<{ name: string; render: () => React.ReactElement; trigger: string }> = [
  { name: 'UserAvatarMenu', render: () => <UserAvatarMenu userInitial="A" direction="down" />, trigger: 'button[aria-label="Account menu"]' },
  { name: 'TeamSwitcher', render: () => <TeamSwitcher teams={TEAMS} currentTeamId="team-a" />, trigger: 'button[aria-label^="Switch team"]' },
  { name: 'TeamSwitcherRail', render: () => <TeamSwitcherRail teams={TEAMS} currentTeamId="team-a" />, trigger: 'button[aria-label^="Team:"]' },
];

for (const c of cases) {
  describe(`${c.name} disclosure`, () => {
    function mount() {
      act(() => root.render(c.render()));
      return host.querySelector<HTMLButtonElement>(c.trigger)!;
    }

    it('does not promise a menu it does not implement', () => {
      const trigger = mount();
      expect(trigger).not.toBeNull();
      expect(trigger.hasAttribute('aria-haspopup')).toBe(false);
      act(() => trigger.click());
      expect(host.querySelector('[role="menu"]')).toBeNull();
      expect(host.querySelector('[role="menuitem"]')).toBeNull();
    });

    it('links the trigger to the panel it opens via aria-expanded + aria-controls', () => {
      const trigger = mount();
      expect(trigger.getAttribute('aria-expanded')).toBe('false');
      act(() => trigger.click());
      expect(trigger.getAttribute('aria-expanded')).toBe('true');
      const id = trigger.getAttribute('aria-controls');
      expect(id).toBeTruthy();
      const panel = document.getElementById(id!);
      expect(panel).not.toBeNull();
      expect(panel!.querySelectorAll('a, button').length).toBeGreaterThan(0);
    });

    it('Escape closes the panel and returns focus to the trigger', () => {
      const trigger = mount();
      act(() => trigger.click());
      const panel = document.getElementById(trigger.getAttribute('aria-controls')!)!;
      const item = panel.querySelector<HTMLElement>('a, button')!;
      item.focus();
      expect(document.activeElement).toBe(item);
      pressEscape(item);
      expect(trigger.getAttribute('aria-expanded')).toBe('false');
      expect(document.getElementById(trigger.getAttribute('aria-controls') ?? '')).toBeNull();
      expect(document.activeElement).toBe(trigger);
    });

    it('Escape does nothing while closed (does not steal focus)', () => {
      const trigger = mount();
      const other = document.createElement('button');
      document.body.append(other);
      other.focus();
      pressEscape(other);
      expect(document.activeElement).toBe(other);
      other.remove();
      expect(trigger.getAttribute('aria-expanded')).toBe('false');
    });
  });
}

describe('team switchers mark the current team', () => {
  it('TeamSwitcher sets aria-current on the active team only', () => {
    act(() => root.render(<TeamSwitcher teams={TEAMS} currentTeamId="team-b" />));
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label^="Switch team"]')!.click());
    const current = host.querySelectorAll('[aria-current="true"]');
    expect(current.length).toBe(1);
    expect(current[0].textContent).toContain('Team B');
  });

  it('TeamSwitcherRail sets aria-current on the active team only', () => {
    act(() => root.render(<TeamSwitcherRail teams={TEAMS} currentTeamId="team-a" />));
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label^="Team:"]')!.click());
    const current = host.querySelectorAll('[aria-current="true"]');
    expect(current.length).toBe(1);
    expect(current[0].textContent).toContain('Team A');
  });
});
