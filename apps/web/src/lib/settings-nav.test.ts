import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import {
  LEGACY_SETTINGS_ANCHORS,
  SETTINGS_ITEMS,
  SETTINGS_NAV,
  TEAM_MANAGED_LINE,
  legacySettingsTarget,
  settingsBackHref,
  settingsItemFor,
  settingsNavFor,
  settingsReadOnly,
} from './settings-nav';
import { NO_PERMISSIONS, settingsPermissions } from '../app/app/(protected)/settings/_lib/settings-permissions';

const PROTECTED = resolve(import.meta.dir, '../app/app/(protected)');
const pageFor = (href: string) => resolve(PROTECTED, `${href.replace(/^\/app\//, '')}/page.tsx`);

describe('SETTINGS_NAV', () => {
  const ids = (label: string) => SETTINGS_NAV.find((g) => g.label === label)!.items.map((i) => i.id);

  it('groups sections by whose setting it is: yours, then the team\'s', () => {
    expect(SETTINGS_NAV.map((g) => g.label)).toEqual(['You', 'Team']);
    expect(SETTINGS_NAV.map((g) => g.scope)).toEqual(['you', 'team']);
  });

  it('lists your profile, your keys, your notifications and your connected apps under You', () => {
    expect(ids('You')).toEqual(['account', 'keys', 'notifications', 'connections']);
  });

  it('lists everything the team shares under Team, Members first', () => {
    expect(ids('Team')).toEqual([
      'team', 'roles', 'billing', 'models', 'workspaces', 'runners', 'alerts', 'integrations',
    ]);
    expect(SETTINGS_ITEMS.find((i) => i.id === 'team')?.label).toBe('Members');
  });

  it('keeps sub-pages inside their section', () => {
    expect(settingsItemFor('/app/settings/roles/builder/edit')?.id).toBe('roles');
    expect(settingsItemFor('/app/settings/team/new')?.id).toBe('team');
    expect(settingsItemFor('/app/settings/runners/tokens/new')?.id).toBe('runners');
    expect(settingsItemFor('/app/settings/keys')?.id).toBe('keys');
    expect(settingsItemFor('/app/settings/team-notifications')?.id).toBe('alerts');
  });

  it('has one model page for the team and one keys page for you', () => {
    const ids = SETTINGS_ITEMS.map((i) => i.id) as string[];
    expect(ids).toContain('models');
    expect(ids).toContain('keys');
    expect(ids).not.toContain('providers');
    expect(ids).not.toContain('ai');
  });

  it('gives every section its own route with a page.tsx', () => {
    for (const item of SETTINGS_ITEMS) {
      expect(item.href.startsWith('/app/settings/')).toBe(true);
      expect(`${item.href}: ${existsSync(pageFor(item.href))}`).toBe(`${item.href}: true`);
    }
  });

  it('names the permissions behind every team section, and none behind yours', () => {
    for (const g of SETTINGS_NAV) {
      for (const item of g.items) {
        if (g.scope === 'team') expect(`${item.id}: ${(item.manage ?? []).length > 0}`).toBe(`${item.id}: true`);
        else expect(item.manage).toBeUndefined();
      }
    }
  });

  it('has unique ids and hrefs', () => {
    expect(new Set(SETTINGS_ITEMS.map((i) => i.id)).size).toBe(SETTINGS_ITEMS.length);
    expect(new Set(SETTINGS_ITEMS.map((i) => i.href)).size).toBe(SETTINGS_ITEMS.length);
  });

  it('writes descriptions without em dashes', () => {
    for (const item of SETTINGS_ITEMS) expect(item.description).not.toContain('—');
  });
});

describe('settingsNavFor', () => {
  const ids = (billing: boolean) => settingsNavFor({ billing }).flatMap((g) => g.items.map((i) => i.id));

  const billing = (on: boolean) => settingsNavFor({ billing: on }).flatMap((g) => g.items).find((i) => i.id === 'billing')!;

  it('lists every section either way: budgets live on the billing page', () => {
    expect(ids(false)).toEqual(ids(true));
    expect(ids(false)).toHaveLength(SETTINGS_ITEMS.length);
  });

  it('names the page Billing and budgets while billing is on, and Budgets while it is off', () => {
    expect(billing(true).label).toBe('Billing and budgets');
    expect(billing(false).label).toBe('Budgets');
    expect(billing(false).description).not.toMatch(/plan|invoice/i);
    expect(billing(false).href).toBe(billing(true).href);
  });
});

describe('settingsReadOnly', () => {
  const member = settingsPermissions({ role: 'member', slug: 'acme' }, 'u1', {});
  const admin = settingsPermissions({ role: 'admin', slug: 'acme' }, 'u1', {});
  const teamIds = SETTINGS_NAV.find((g) => g.scope === 'team')!.items.map((i) => i.id);

  it('shows every team section read-only to a member', () => {
    for (const id of teamIds) expect(`${id}: ${settingsReadOnly(id, member)}`).toBe(`${id}: true`);
  });

  it('lets an admin change every team section', () => {
    for (const id of teamIds) expect(`${id}: ${settingsReadOnly(id, admin)}`).toBe(`${id}: false`);
  });

  it('never makes your own sections read-only', () => {
    for (const id of ['account', 'keys', 'notifications', 'connections'] as const) {
      expect(settingsReadOnly(id, NO_PERMISSIONS)).toBe(false);
    }
  });

  it('follows the team\'s overrides: a member granted a section\'s permission can change it', () => {
    const granted = settingsPermissions({ role: 'member', slug: 'acme' }, 'u1', { manage_team_notifications: ['owner', 'admin', 'member'] });
    expect(settingsReadOnly('alerts', granted)).toBe(false);
    expect(settingsReadOnly('integrations', granted)).toBe(true);
  });

  it('says who manages it in one plain line', () => {
    expect(TEAM_MANAGED_LINE).toBe('Managed by your team admins.');
  });
});

describe('settingsItemFor', () => {
  it('matches a section and its sub-pages', () => {
    expect(settingsItemFor('/app/settings/runners')?.id).toBe('runners');
    expect(settingsItemFor('/app/settings/models')?.id).toBe('models');
    expect(settingsItemFor('/app/settings/workspace/ws-1')?.id).toBe('workspaces');
  });

  it('returns null for the index and non-settings paths', () => {
    expect(settingsItemFor('/app/settings')).toBeNull();
    expect(settingsItemFor('/app/home')).toBeNull();
    expect(settingsItemFor('/app/settings/runnersx')).toBeNull();
  });
});

describe('settingsBackHref', () => {
  it('goes from a section back to the index, and from a sub-page back to its section', () => {
    expect(settingsBackHref('/app/settings/models')).toBe('/app/settings');
    expect(settingsBackHref('/app/settings/roles/builder')).toBe('/app/settings/roles');
    expect(settingsBackHref('/app/settings/workspace/ws-1')).toBe('/app/settings/workspaces');
    expect(settingsBackHref('/app/settings')).toBeNull();
  });
});

describe('legacy settings links', () => {
  it('sends every old anchor to a real section', () => {
    const hrefs = new Set(SETTINGS_ITEMS.map((i) => i.href));
    for (const target of Object.values(LEGACY_SETTINGS_ANCHORS)) expect(hrefs.has(target)).toBe(true);
  });

  it('resolves the anchors that shipped links point at', () => {
    expect(legacySettingsTarget('#agent-backends')).toBe('/app/settings/models');
    expect(legacySettingsTarget('agent-backends')).toBe('/app/settings/models');
    expect(legacySettingsTarget('#inference-spending')).toBe('/app/settings/models');
    expect(legacySettingsTarget('#connectors')).toBe('/app/settings/connections');
    expect(legacySettingsTarget('#github')).toBe('/app/settings/integrations');
    expect(legacySettingsTarget('#vercel')).toBe('/app/settings/integrations');
    expect(legacySettingsTarget('#provider-keys')).toBe('/app/settings/models');
    expect(legacySettingsTarget('#notifications')).toBe('/app/settings/notifications');
    expect(legacySettingsTarget('#nope')).toBeNull();
    expect(legacySettingsTarget('')).toBeNull();
  });

  it('redirects the retired top-level pages in next.config', () => {
    const cfg = readFileSync(resolve(import.meta.dir, '../../next.config.mjs'), 'utf8');
    expect(cfg).toMatch(/source: '\/app\/you',\s*destination: '\/app\/settings\/account'/);
    expect(cfg).toMatch(/source: '\/app\/connections',\s*destination: '\/app\/settings\/connections'/);
    // A page.tsx at the old path would shadow nothing (config redirects run
    // first) but would be dead code that looks live.
    expect(existsSync(resolve(PROTECTED, 'you/page.tsx'))).toBe(false);
    expect(existsSync(resolve(PROTECTED, 'connections/page.tsx'))).toBe(false);
  });
});
