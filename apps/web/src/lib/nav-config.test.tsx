import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { MOBILE_TAB_LIMIT, NAV_ITEMS, WORKSPACE_FILTERED_PAGES, mobileBackHref, mobilePageTitle, showsWorkspaceFilter } from './nav-config';
import { SETTINGS_ROUTE_MOVES } from '../../next.config.mjs';

describe('NAV_ITEMS', () => {
  // Owner decision (Oct 9): five primary destinations, the same on a phone and
  // on desktop. Releases and Initiatives live under Missions, Team under Settings.
  it('is the five primary surfaces, in order', () => {
    expect(NAV_ITEMS.map((i) => i.href)).toEqual(['/app/home', '/app/missions', '/app/tasks', '/app/health', '/app/chat']);
    expect(NAV_ITEMS.map((i) => i.label)).toEqual(['Home', 'Missions', 'Activity', 'Health', 'Chat']);
    expect(NAV_ITEMS.length).toBe(MOBILE_TAB_LIMIT);
  });

  it('Releases, Initiatives and Team leave the nav but their pages still resolve', () => {
    // Team resolves through a redirect into Settings › Roles (next.config SETTINGS_ROUTE_MOVES).
    const redirected = new Map(SETTINGS_ROUTE_MOVES.map((m) => [m.source, m.destination]));
    for (const href of ['/app/releases', '/app/initiatives', '/app/team']) {
      expect(NAV_ITEMS.map((i) => i.href)).not.toContain(href);
      const target = redirected.get(href) ?? href;
      expect(`${href}: ${existsSync(resolve(import.meta.dir, `../app/app/(protected)${target.replace('/app', '')}/page.tsx`))}`).toBe(`${href}: true`);
    }
  });

  it('Chat is a plain nav item, gated on nothing (chat is always on)', () => {
    const chat = NAV_ITEMS.find((i) => i.href === '/app/chat');
    expect(chat).toBeDefined();
    expect(Object.keys(chat!).sort()).toEqual(['href', 'icon', 'label']);
  });

  it('provides an icon for every item', () => {
    for (const item of NAV_ITEMS) {
      expect(item.icon).toBeTruthy();
    }
  });
});

// Regression guard: Health page sections must be identical across desktop and mobile.
// Desktop (sidebar rail) and mobile (bottom tab nav) both route to the same
// HealthClient component — there is no separate mobile rendering path.
// Any section conditionally rendered for a specific viewport is a regression.
// See: unified-app-ia.md §B.1 AC-4 and task 1940b072 (artifact→task mobile regression).
describe('HealthClient viewport parity', () => {
  const healthClientSrc = readFileSync(
    resolve(__dirname, '../app/app/(protected)/health/HealthClient.tsx'),
    'utf-8',
  );

  it('does not render a Vercel section (removed in #1066, must not return on any viewport)', () => {
    // "Vercel" may appear in comments or variable names; check for rendered section headings only
    expect(healthClientSrc).not.toMatch(/>Vercel</);
    expect(healthClientSrc).not.toMatch(/section-label[^>]*>Vercel/);
  });

  it('has data-testid anchors on every expected section for E2E viewport assertions', () => {
    // The three top-level sections, in Problems → State → Trend order …
    expect(healthClientSrc).toContain('data-testid="health-section-problems"');
    expect(healthClientSrc).toContain('data-testid="health-section-state"');
    expect(healthClientSrc).toContain('data-testid="health-section-trend"');
    // … plus the panels nested inside them.
    expect(healthClientSrc).toContain('data-testid="health-section-runners"');
    // Schedules live on /app/schedules, not on Health.
    expect(healthClientSrc).not.toContain('data-testid="health-section-schedules"');
    expect(healthClientSrc).toContain('data-testid="health-section-task-outcomes"');
  });

  it('no longer carries the retired Usage(30d) section', () => {
    // `/app/team` already renders the identical per-role rollup; Health links
    // there instead of publishing a second copy that can silently diverge.
    expect(healthClientSrc).not.toContain('data-testid="health-section-usage"');
  });
});

describe('mobilePageTitle', () => {
  it('names the billing page the way its sub-nav entry does: Budgets while billing is off', () => {
    expect(mobilePageTitle('/app/settings/billing', { billing: true })).toBe('Billing and budgets');
    expect(mobilePageTitle('/app/settings/billing', { billing: false })).toBe('Budgets');
    expect(mobilePageTitle('/app/settings/integrations', { billing: false })).toBe('Integrations');
  });

  it('titles every primary nav surface so the mobile header renders there', () => {
    expect(mobilePageTitle('/app/home')).toBe('Home');
    expect(mobilePageTitle('/app/dashboard')).toBe('Home');
    expect(mobilePageTitle('/app/chat')).toBe('Chat');
    expect(mobilePageTitle('/app/chat/abc')).toBeNull();
    expect(mobilePageTitle('/app/missions')).toBe('Missions');
    expect(mobilePageTitle('/app/releases')).toBe('Releases');
    expect(mobilePageTitle('/app/initiatives')).toBe('Initiatives');
    expect(mobilePageTitle('/app/tasks')).toBe('Activity');
    expect(mobilePageTitle('/app/team')).toBe('Team');
    expect(mobilePageTitle('/app/health')).toBe('Health');
  });

  it('titles the settings index and each settings section', () => {
    expect(mobilePageTitle('/app/settings')).toBe('Settings');
    expect(mobilePageTitle('/app/settings/account')).toBe('Profile');
    expect(mobilePageTitle('/app/settings/runners')).toBe('Runners');
    expect(mobilePageTitle('/app/settings/models')).toBe('Models');
    expect(mobilePageTitle('/app/settings/workspace/ws-1')).toBe('Workspaces');
  });

  it('gives settings sections a back arrow and nothing else one', () => {
    expect(mobileBackHref('/app/settings/runners')).toBe('/app/settings');
    expect(mobileBackHref('/app/settings/workspace/ws-1')).toBe('/app/settings/workspaces');
    expect(mobileBackHref('/app/settings')).toBeNull();
    expect(mobileBackHref('/app/home')).toBeNull();
  });

  it('titles the workspace Memory page and links back to the workspace', () => {
    expect(mobilePageTitle('/app/workspaces/ws-1/memory')).toBe('Memory');
    expect(mobileBackHref('/app/workspaces/ws-1/memory')).toBe('/app/workspaces/ws-1');
  });

  it('returns null on detail pages so they render their own headers', () => {
    expect(mobilePageTitle('/app/missions/abc-123')).toBeNull();
    expect(mobilePageTitle('/app/initiatives/abc-123')).toBeNull();
    expect(mobilePageTitle('/app/tasks/abc-123')).toBeNull();
    expect(mobilePageTitle('/app/workspaces/abc-123/config')).toBeNull();
  });
});

describe('showsWorkspaceFilter', () => {
  // Paths with no page.tsx: next.config.mjs redirects them before any page renders.
  const REDIRECT_ONLY = new Set(['/app/dashboard']);
  // Top-level pages with a mobile header that ignore the param — a filter there is a no-op control.
  const IGNORES_PARAM = ['/app/settings', '/app/settings/account', '/app/settings/runners', '/app/artifacts', '/app/initiatives', '/app/workspaces', '/app/team'];

  it('shows on every allowlisted path', () => {
    for (const path of WORKSPACE_FILTERED_PAGES) expect(showsWorkspaceFilter(path)).toBe(true);
  });

  it.each(IGNORES_PARAM)('hides on %s', (path) => {
    expect(showsWorkspaceFilter(path)).toBe(false);
    expect(WORKSPACE_FILTERED_PAGES.has(path)).toBe(false);
  });

  it('every allowlisted page actually reads ?workspace= in its page.tsx (the real set, not a copy)', () => {
    const checked: string[] = [];
    for (const path of WORKSPACE_FILTERED_PAGES) {
      if (REDIRECT_ONLY.has(path)) continue;
      const file = resolve(import.meta.dir, `../app/app/(protected)${path.replace('/app', '')}/page.tsx`);
      expect(readFileSync(file, 'utf8')).toMatch(/workspace\??:\s*(wsFilter|string)/);
      checked.push(path);
    }
    // Guard: the loop must have checked something, and every skip must be a real redirect.
    expect(checked.length).toBeGreaterThan(0);
    const nextConfig = readFileSync(resolve(import.meta.dir, '../../next.config.mjs'), 'utf8');
    for (const path of REDIRECT_ONLY) expect(nextConfig).toContain(`source: '${path}'`);
  });
});
