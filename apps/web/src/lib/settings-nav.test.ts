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
} from './settings-nav';

const PROTECTED = resolve(import.meta.dir, '../app/app/(protected)');
const pageFor = (href: string) => resolve(PROTECTED, `${href.replace(/^\/app\//, '')}/page.tsx`);

describe('SETTINGS_NAV', () => {
  it('groups sections as Account, Team, Connections, AI, Workspaces', () => {
    expect(SETTINGS_NAV.map((g) => g.label)).toEqual(['Account', 'Team', 'Connections', 'AI', 'Workspaces']);
  });

  it('gives every section its own route with a page.tsx', () => {
    for (const item of SETTINGS_ITEMS) {
      expect(item.href.startsWith('/app/settings/')).toBe(true);
      expect(existsSync(pageFor(item.href))).toBe(true);
    }
  });

  it('puts model providers right after runners: both are core connections', () => {
    const connections = SETTINGS_NAV.find((g) => g.label === 'Connections')!.items.map((i) => i.id);
    expect(connections.slice(0, 2)).toEqual(['runners', 'providers']);
  });

  it('has unique ids and hrefs', () => {
    expect(new Set(SETTINGS_ITEMS.map((i) => i.id)).size).toBe(SETTINGS_ITEMS.length);
    expect(new Set(SETTINGS_ITEMS.map((i) => i.href)).size).toBe(SETTINGS_ITEMS.length);
  });

  it('writes descriptions without em dashes', () => {
    for (const item of SETTINGS_ITEMS) expect(item.description).not.toContain('—');
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
    expect(settingsBackHref('/app/settings/ai')).toBe('/app/settings');
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
    expect(legacySettingsTarget('#inference-spending')).toBe('/app/settings/ai');
    expect(legacySettingsTarget('#connectors')).toBe('/app/settings/connectors');
    expect(legacySettingsTarget('#provider-keys')).toBe('/app/settings/providers');
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
