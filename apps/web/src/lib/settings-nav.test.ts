import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import {
  LEGACY_SETTINGS_ANCHORS,
  SETTINGS_ITEMS,
  SETTINGS_NAV,
  legacySettingsTarget,
  settingsBackHref,
  settingsItemFor,
  settingsNavFor,
} from './settings-nav';

const PROTECTED = resolve(import.meta.dir, '../app/app/(protected)');
const pageFor = (href: string) => resolve(PROTECTED, `${href.replace(/^\/app\//, '')}/page.tsx`);

describe('SETTINGS_NAV', () => {
  it('groups sections in three: you and your team, agents and workspaces, integrations', () => {
    expect(SETTINGS_NAV.map((g) => g.label)).toEqual(['You and your team', 'Agents and workspaces', 'Integrations']);
  });

  it('keeps Team and Roles inside Settings', () => {
    const you = SETTINGS_NAV[0].items.map((i) => i.id);
    expect(you.slice(0, 3)).toEqual(['account', 'team', 'roles']);
    expect(settingsItemFor('/app/settings/roles/builder/edit')?.id).toBe('roles');
    expect(settingsItemFor('/app/settings/team/new')?.id).toBe('team');
    expect(settingsItemFor('/app/settings/runners/tokens/new')?.id).toBe('runners');
  });

  it('has one model page: providers and AI features are no longer their own sections', () => {
    const ids = SETTINGS_ITEMS.map((i) => i.id) as string[];
    expect(ids).toContain('models');
    expect(ids).not.toContain('providers');
    expect(ids).not.toContain('ai');
  });

  it('gives every section its own route with a page.tsx', () => {
    for (const item of SETTINGS_ITEMS) {
      expect(item.href.startsWith('/app/settings/')).toBe(true);
      expect(existsSync(pageFor(item.href))).toBe(true);
    }
  });

  it('lists Storage under Integrations, linked to its own page', () => {
    const integrations = SETTINGS_NAV.find((g) => g.label === 'Integrations')!.items;
    const storage = integrations.find((i) => i.id === 'storage');
    expect(storage?.href).toBe('/app/settings/storage');
    expect(settingsItemFor('/app/settings/storage')?.id).toBe('storage');
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

  it('hides Billing entirely while billing is off', () => {
    expect(ids(false)).not.toContain('billing');
    expect(ids(false)).toHaveLength(SETTINGS_ITEMS.length - 1);
  });

  it('lists Billing after Budgets while billing is on', () => {
    const you = settingsNavFor({ billing: true })[0].items.map((i) => i.id);
    expect(you).toEqual(['account', 'team', 'roles', 'budgets', 'billing']);
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
    expect(legacySettingsTarget('#agent-backends')).toBe('/app/settings/runners');
    expect(legacySettingsTarget('agent-backends')).toBe('/app/settings/runners');
    expect(legacySettingsTarget('#inference-spending')).toBe('/app/settings/models');
    expect(legacySettingsTarget('#connectors')).toBe('/app/settings/connectors');
    expect(legacySettingsTarget('#provider-keys')).toBe('/app/settings/models');
    expect(legacySettingsTarget('#nope')).toBeNull();
    expect(legacySettingsTarget('')).toBeNull();
  });

  it('redirects the retired top-level pages in next.config', () => {
    const cfg = readFileSync(resolve(import.meta.dir, '../../next.config.mjs'), 'utf8');
    expect(cfg).toMatch(/source: '\/app\/you',\s*destination: '\/app\/settings\/account'/);
    expect(cfg).toMatch(/source: '\/app\/connections',\s*destination: '\/app\/settings\/connectors'/);
    // A page.tsx at the old path would shadow nothing (config redirects run
    // first) but would be dead code that looks live.
    expect(existsSync(resolve(PROTECTED, 'you/page.tsx'))).toBe(false);
    expect(existsSync(resolve(PROTECTED, 'connections/page.tsx'))).toBe(false);
  });
});
