import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { NAV_ITEMS, mobilePageTitle } from './nav-config';

describe('NAV_ITEMS', () => {
  it('defines the primary surfaces in spec order (unified-app-ia §D.2)', () => {
    expect(NAV_ITEMS.map((i) => i.href)).toEqual([
      '/app/home',
      '/app/missions',
      '/app/releases',
      '/app/initiatives',
      '/app/tasks',
      '/app/team',
      '/app/health',
    ]);
    expect(NAV_ITEMS.map((i) => i.label)).toEqual([
      'Home',
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
