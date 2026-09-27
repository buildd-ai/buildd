import { describe, it, expect, mock } from 'bun:test';

// pickEffectiveRole reads the workspace's team and its role rows.
let workspaceRow: { teamId: string } | null = { teamId: 'team-1' };
let roleRows: Array<{ slug: string; workspaceId: string | null; enabled: boolean | null }> = [];
let lookupThrows = false;
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workspaces: { findFirst: async () => workspaceRow },
      workspaceSkills: {
        findMany: async () => {
          if (lookupThrows) throw new Error('db down');
          return roleRows;
        },
      },
    },
  },
}));

import { effectiveRoleSlugs, pickEffectiveRole } from './effective-roles';

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

describe('pickEffectiveRole (role-routing §1 row 9)', () => {
  function given(rows: typeof roleRows) {
    workspaceRow = { teamId: 'team-1' };
    roleRows = rows;
    lookupThrows = false;
  }

  it('returns the first candidate the workspace resolves, skipping blanks', async () => {
    given([{ slug: 'builder', workspaceId: null, enabled: true }, { slug: 'writer', workspaceId: null, enabled: true }]);
    expect(await pickEffectiveRole('ws-1', [null, '', 'writer', 'builder'])).toBe('writer');
  });

  it('falls through a pass-through slug the workspace lacks to the constant', async () => {
    given([{ slug: 'builder', workspaceId: null, enabled: true }]);
    expect(await pickEffectiveRole('ws-1', ['ops', 'builder'])).toBe('builder');
  });

  it('is null when no candidate resolves — never a slug the claim filter would strand', async () => {
    given([{ slug: 'builder', workspaceId: 'ws-1', enabled: false }]);
    expect(await pickEffectiveRole('ws-1', ['builder', 'researcher'])).toBeNull();
  });

  it('is null when the workspace is unknown or the lookup throws', async () => {
    given([{ slug: 'builder', workspaceId: null, enabled: true }]);
    workspaceRow = null;
    expect(await pickEffectiveRole('ws-1', ['builder'])).toBeNull();
    given([]);
    lookupThrows = true;
    expect(await pickEffectiveRole('ws-1', ['builder'])).toBeNull();
  });
});
