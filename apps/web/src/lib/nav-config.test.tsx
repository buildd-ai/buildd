import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { MOBILE_TAB_LIMIT, NAV_ITEMS, WORKSPACE_FILTERED_PAGES, mobilePageTitle, navItemsFor, showsWorkspaceFilter } from './nav-config';

describe('NAV_ITEMS', () => {
  it('defines the primary surfaces in spec order (unified-app-ia §D.2)', () => {
    expect(NAV_ITEMS.map((i) => i.href)).toEqual([
      '/app/home',
      '/app/chat',
      '/app/missions',
      '/app/releases',
      '/app/initiatives',
      '/app/tasks',
      '/app/team',
      '/app/health',
    ]);
    expect(NAV_ITEMS.map((i) => i.label)).toEqual([
      'Home',
      'Chat',
      'Missions',
      'Releases',
      'Initiatives',
      'Activity',
      'Team',
      'Health',
    ]);
  });

  it('marks only Releases and Initiatives desktop-only (kept off the mobile bottom bar)', () => {
    expect(NAV_ITEMS.filter((i) => i.desktopOnly).map((i) => i.href)).toEqual([
      '/app/releases',
      '/app/initiatives',
    ]);
  });

  it('only Chat is gated on chat availability', () => {
    expect(NAV_ITEMS.filter((i) => i.requiresChat).map((i) => i.href)).toEqual(['/app/chat']);
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
    expect(healthClientSrc).toContain('data-testid="health-section-schedules"');
    expect(healthClientSrc).toContain('data-testid="health-section-task-outcomes"');
  });

  it('no longer carries the retired Usage(30d) section', () => {
    // `/app/team` already renders the identical per-role rollup; Health links
    // there instead of publishing a second copy that can silently diverge.
    expect(healthClientSrc).not.toContain('data-testid="health-section-usage"');
  });
});

describe('mobilePageTitle', () => {
  it('titles every primary nav surface so the mobile header renders there', () => {
    expect(mobilePageTitle('/app/home')).toBe('Home');
    expect(mobilePageTitle('/app/dashboard')).toBe('Home');
    expect(mobilePageTitle('/app/missions')).toBe('Missions');
    expect(mobilePageTitle('/app/releases')).toBe('Releases');
    expect(mobilePageTitle('/app/initiatives')).toBe('Initiatives');
    expect(mobilePageTitle('/app/tasks')).toBe('Activity');
    expect(mobilePageTitle('/app/team')).toBe('Team');
    expect(mobilePageTitle('/app/health')).toBe('Health');
  });

  it('titles the menu-accessed surfaces (Account / Connections)', () => {
    expect(mobilePageTitle('/app/you')).toBe('Account');
    expect(mobilePageTitle('/app/settings')).toBe('Connections');
    expect(mobilePageTitle('/app/connections')).toBe('Connections');
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
  const IGNORES_PARAM = ['/app/you', '/app/settings', '/app/connections', '/app/artifacts', '/app/initiatives', '/app/workspaces', '/app/team'];

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

describe('navItemsFor', () => {
  const hrefs = (items: { href: string }[]) => items.map(i => i.href);
  const withoutChat = NAV_ITEMS.filter(i => !i.requiresChat);

  it('chat unavailable: exactly the nav as it was, for everyone, on both surfaces', () => {
    for (const audience of ['member', 'operator'] as const) {
      expect(hrefs(navItemsFor({ chat: false, audience }, 'desktop'))).toEqual(hrefs(withoutChat));
      expect(hrefs(navItemsFor({ chat: false, audience }, 'mobile'))).toEqual(hrefs(withoutChat.filter(i => !i.desktopOnly)));
    }
  });

  it('a member with chat gets Chat first, desktop and phone', () => {
    expect(navItemsFor({ chat: true, audience: 'member' }, 'desktop')[0].href).toBe('/app/chat');
    expect(navItemsFor({ chat: true, audience: 'member' }, 'mobile')[0].href).toBe('/app/chat');
  });

  it('an operator with chat keeps Home (the fleet) first, Chat right after', () => {
    expect(hrefs(navItemsFor({ chat: true, audience: 'operator' }, 'desktop')).slice(0, 2)).toEqual(['/app/home', '/app/chat']);
  });

  it('the phone tab bar never exceeds its limit; Team steps off, the rail keeps it', () => {
    const mobile = navItemsFor({ chat: true, audience: 'member' }, 'mobile');
    expect(mobile.length).toBeLessThanOrEqual(MOBILE_TAB_LIMIT);
    expect(hrefs(mobile)).not.toContain('/app/team');
    expect(hrefs(navItemsFor({ chat: true, audience: 'member' }, 'desktop'))).toContain('/app/team');
  });
});
