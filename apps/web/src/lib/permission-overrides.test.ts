import { describe, it, expect } from 'bun:test';
import {
  PERMISSIONS,
  LOCKED_PERMISSIONS,
  TEAM_ROLES,
  effectiveRoles,
  roleHas,
  sanitizeOverrides,
  parseOverridesInput,
  type Permission,
} from './permission-registry';

const ALL = Object.keys(PERMISSIONS) as Permission[];
const OVERRIDABLE = ALL.filter(p => !LOCKED_PERMISSIONS.has(p));

describe('effectiveRoles with overrides', () => {
  it('no overrides means the defaults', () => {
    for (const p of ALL) expect(effectiveRoles(p, null)).toEqual(PERMISSIONS[p].defaultRoles);
    for (const p of ALL) expect(effectiveRoles(p, {})).toEqual(PERMISSIONS[p].defaultRoles);
  });

  it('an override replaces the defaults for that permission only', () => {
    const o = { manage_connectors: ['owner', 'admin', 'member'] } as const;
    expect(roleHas('member', 'manage_connectors', o)).toBe(true);
    expect(roleHas('member', 'manage_evidence_backends', o)).toBe(false);
  });

  it('can take a permission away from admins', () => {
    const o = { manage_connectors: ['owner'] } as const;
    expect(roleHas('admin', 'manage_connectors', o)).toBe(false);
    expect(roleHas('owner', 'manage_connectors', o)).toBe(true);
  });

  it('owner always holds every permission, whatever an override says', () => {
    for (const p of OVERRIDABLE) expect(roleHas('owner', p, { [p]: [] })).toBe(PERMISSIONS[p].defaultRoles.includes('owner'));
    expect(roleHas('owner', 'manage_connectors', { manage_connectors: ['member'] })).toBe(true);
  });

  it('locked permissions ignore overrides', () => {
    for (const p of LOCKED_PERMISSIONS) {
      expect(roleHas('member', p, { [p]: ['owner', 'admin', 'member'] })).toBe(false);
      expect(roleHas('admin', p, { [p]: ['owner', 'admin', 'member'] })).toBe(false);
    }
  });

  it('locks owner-only power: owner transfer, team deletion, editing permissions', () => {
    expect(LOCKED_PERMISSIONS.has('assign_team_owner')).toBe(true);
    expect(LOCKED_PERMISSIONS.has('delete_team')).toBe(true);
    expect(LOCKED_PERMISSIONS.has('manage_team_permissions')).toBe(true);
    expect(PERMISSIONS.manage_team_permissions.defaultRoles).toEqual(['owner']);
    expect(PERMISSIONS.manage_team_permissions.minKeyLevel).toBeNull();
  });

  it('unknown roles never hold anything', () => {
    expect(roleHas('superuser', 'manage_connectors', { manage_connectors: ['owner', 'admin', 'member'] })).toBe(false);
    expect(roleHas(null, 'manage_connectors', null)).toBe(false);
  });
});

describe('sanitizeOverrides (reading stored JSON defensively)', () => {
  it('drops unknown permissions, unknown roles, locked permissions and non-arrays', () => {
    const raw = {
      manage_connectors: ['admin', 'member', 'superuser'],
      not_a_permission: ['member'],
      delete_team: ['member'],
      run_experiments: 'member',
    };
    expect(sanitizeOverrides(raw)).toEqual({ manage_connectors: ['admin', 'member'] });
  });

  it('treats null, arrays and scalars as no overrides', () => {
    expect(sanitizeOverrides(null)).toEqual({});
    expect(sanitizeOverrides([])).toEqual({});
    expect(sanitizeOverrides('x')).toEqual({});
  });
});

describe('parseOverridesInput (what an owner submits)', () => {
  it('accepts a valid change and drops entries equal to the defaults', () => {
    const r = parseOverridesInput({ manage_connectors: ['owner', 'admin', 'member'], run_experiments: ['owner', 'admin'] });
    expect(r).toEqual({ ok: true, overrides: { manage_connectors: ['owner', 'admin', 'member'] } });
  });

  it('normalises role order and adds owner', () => {
    const r = parseOverridesInput({ manage_connectors: ['member', 'admin'] });
    expect(r).toEqual({ ok: true, overrides: { manage_connectors: ['owner', 'admin', 'member'] } });
  });

  it('rejects unknown permissions, unknown roles, locked permissions and bad shapes', () => {
    expect(parseOverridesInput({ nope: ['admin'] }).ok).toBe(false);
    expect(parseOverridesInput({ manage_connectors: ['root'] }).ok).toBe(false);
    expect(parseOverridesInput({ delete_team: ['admin'] }).ok).toBe(false);
    expect(parseOverridesInput({ manage_connectors: 'admin' }).ok).toBe(false);
    expect(parseOverridesInput(null).ok).toBe(false);
    expect(parseOverridesInput([]).ok).toBe(false);
  });

  it('every role list it returns is a subset of TEAM_ROLES in canonical order', () => {
    const r = parseOverridesInput({ manage_connectors: ['member', 'owner'] });
    if (!r.ok) throw new Error('expected ok');
    const roles = r.overrides.manage_connectors!;
    expect(roles).toEqual(TEAM_ROLES.filter(x => roles.includes(x)));
  });
});
