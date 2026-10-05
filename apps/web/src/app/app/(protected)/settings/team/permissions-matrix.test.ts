import { describe, it, expect } from 'bun:test';
import { PERMISSIONS, PERMISSION_GROUPS, type Permission } from '@/lib/permission-registry';
import { buildMatrix, toggleRole, resetRow, toOverrides, isDirty, type ApiPermission } from './permissions-matrix';

const ALL = Object.keys(PERMISSIONS) as Permission[];

function api(overrides: Partial<Record<Permission, string[]>> = {}): ApiPermission[] {
  return ALL.map(name => ({
    name,
    description: PERMISSIONS[name].description,
    defaultRoles: [...PERMISSIONS[name].defaultRoles],
    roles: overrides[name] ?? [...PERMISSIONS[name].defaultRoles],
    locked: ['assign_team_owner', 'delete_team', 'manage_team_permissions', 'seed_team_timezone'].includes(name),
    overridden: overrides[name] !== undefined,
  }));
}

describe('PERMISSION_GROUPS', () => {
  it('places every permission in exactly one group', () => {
    const placed = PERMISSION_GROUPS.flatMap(g => g.permissions);
    expect([...placed].sort()).toEqual([...ALL].sort());
    expect(new Set(placed).size).toBe(placed.length);
  });
});

describe('buildMatrix', () => {
  it('groups rows in registry group order and hides the timezone seed (a behaviour, not a grant)', () => {
    const m = buildMatrix(api());
    expect(m.map(g => g.title)).toEqual(PERMISSION_GROUPS.map(g => g.title).filter(t => m.some(g => g.title === t)));
    const names = m.flatMap(g => g.rows.map(r => r.name));
    expect(names).not.toContain('seed_team_timezone');
    expect(names).toContain('manage_connectors');
  });

  it('marks admin and member as held per row', () => {
    const row = buildMatrix(api({ manage_connectors: ['owner', 'admin', 'member'] }))
      .flatMap(g => g.rows).find(r => r.name === 'manage_connectors')!;
    expect(row).toMatchObject({ admin: true, member: true, locked: false, isDefault: false });
  });
});

describe('editing', () => {
  const rows = () => buildMatrix(api()).flatMap(g => g.rows);

  it('toggling a role flips it and makes the row non-default; toggling back restores default', () => {
    const r0 = rows().find(r => r.name === 'manage_connectors')!;
    const r1 = toggleRole(r0, 'member');
    expect(r1.member).toBe(true);
    expect(r1.isDefault).toBe(false);
    expect(toggleRole(r1, 'member').isDefault).toBe(true);
  });

  it('locked rows do not toggle', () => {
    const del = rows().find(r => r.name === 'delete_team')!;
    expect(toggleRole(del, 'admin')).toBe(del);
  });

  it('resetRow returns to the registry default', () => {
    const r = toggleRole(rows().find(r => r.name === 'manage_connectors')!, 'admin');
    expect(resetRow(r)).toMatchObject({ admin: true, member: false, isDefault: true });
  });

  it('toOverrides sends only non-default, non-locked rows, owner always included', () => {
    const edited = rows().map(r => (r.name === 'manage_connectors' ? toggleRole(r, 'member') : r.name === 'run_experiments' ? toggleRole(r, 'admin') : r));
    expect(toOverrides(edited)).toEqual({
      manage_connectors: ['owner', 'admin', 'member'],
      run_experiments: ['owner'],
    });
    expect(toOverrides(rows())).toEqual({});
  });

  it('isDirty compares against what was loaded', () => {
    const loaded = rows();
    expect(isDirty(loaded, loaded)).toBe(false);
    expect(isDirty(loaded, loaded.map(r => (r.name === 'manage_connectors' ? toggleRole(r, 'member') : r)))).toBe(true);
  });
});
