import { describe, expect, it } from 'bun:test';
import { NAV_ITEMS, mobilePageTitle } from './nav-config';

describe('NAV_ITEMS', () => {
  it('defines the five primary surfaces in spec order (unified-app-ia §D.2)', () => {
    expect(NAV_ITEMS.map((i) => i.href)).toEqual([
      '/app/home',
      '/app/missions',
      '/app/tasks',
      '/app/team',
      '/app/health',
    ]);
    expect(NAV_ITEMS.map((i) => i.label)).toEqual([
      'Home',
      'Missions',
      'Activity',
      'Team',
      'Health',
    ]);
  });

  it('provides an icon for every item', () => {
    for (const item of NAV_ITEMS) {
      expect(item.icon).toBeTruthy();
    }
  });
});

describe('mobilePageTitle', () => {
  it('titles every primary nav surface so the mobile header renders there', () => {
    expect(mobilePageTitle('/app/home')).toBe('Home');
    expect(mobilePageTitle('/app/dashboard')).toBe('Home');
    expect(mobilePageTitle('/app/missions')).toBe('Missions');
    expect(mobilePageTitle('/app/tasks')).toBe('Activity');
    expect(mobilePageTitle('/app/team')).toBe('Team');
    expect(mobilePageTitle('/app/health')).toBe('Health');
  });

  it('titles the menu-accessed surfaces (Account / Connections)', () => {
    expect(mobilePageTitle('/app/you')).toBe('Account');
    expect(mobilePageTitle('/app/settings')).toBe('Connections');
  });

  it('returns null on detail pages so they render their own headers', () => {
    expect(mobilePageTitle('/app/missions/abc-123')).toBeNull();
    expect(mobilePageTitle('/app/tasks/abc-123')).toBeNull();
    expect(mobilePageTitle('/app/workspaces/abc-123/config')).toBeNull();
  });
});
