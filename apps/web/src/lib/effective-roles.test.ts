import { describe, it, expect } from 'bun:test';
import { effectiveRoleSlugs } from './effective-roles';

describe('effectiveRoleSlugs (role-routing §3.1)', () => {
  it('includes enabled team defaults and workspace overrides', () => {
    const slugs = effectiveRoleSlugs([
      { slug: 'builder', workspaceId: null, enabled: true },
      { slug: 'ops', workspaceId: 'ws-1', enabled: true },
    ], 'ws-1');
    expect([...slugs].sort()).toEqual(['builder', 'ops']);
  });

  it('lets a workspace override that disables a role win over the enabled team default', () => {
    for (const rows of [
      [{ slug: 'builder', workspaceId: null, enabled: true }, { slug: 'builder', workspaceId: 'ws-1', enabled: false }],
      [{ slug: 'builder', workspaceId: 'ws-1', enabled: false }, { slug: 'builder', workspaceId: null, enabled: true }],
    ]) {
      expect(effectiveRoleSlugs(rows, 'ws-1').has('builder')).toBe(false);
    }
  });

  it('lets an enabled override revive a disabled team default', () => {
    const slugs = effectiveRoleSlugs([
      { slug: 'writer', workspaceId: null, enabled: false },
      { slug: 'writer', workspaceId: 'ws-1', enabled: true },
    ], 'ws-1');
    expect(slugs.has('writer')).toBe(true);
  });

  it('is empty when the workspace has no role rows', () => {
    expect(effectiveRoleSlugs([], 'ws-1').size).toBe(0);
  });
});
