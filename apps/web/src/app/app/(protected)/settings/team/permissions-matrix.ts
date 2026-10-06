/**
 * The permissions matrix in Settings → Team, as plain data: built from
 * GET /api/teams/[id]/permissions, edited row by row, and turned back into the
 * `overrides` body PUT expects. Pure, so it is tested without a DOM.
 */
import { PERMISSION_GROUPS, type Permission } from '@/lib/permission-registry';

export interface ApiPermission {
  name: Permission;
  description: string;
  defaultRoles: string[];
  roles: string[];
  locked: boolean;
  overridden: boolean;
}

export type EditableRole = 'admin' | 'member';

export interface MatrixRow {
  name: Permission;
  description: string;
  /** Owner always holds every permission, so only these two vary. */
  admin: boolean;
  member: boolean;
  defaultAdmin: boolean;
  defaultMember: boolean;
  locked: boolean;
  isDefault: boolean;
}

/** A behaviour, not something a person does: never shown as a row. */
const HIDDEN: ReadonlySet<Permission> = new Set<Permission>(['seed_team_timezone']);

function withDefault(row: Omit<MatrixRow, 'isDefault'>): MatrixRow {
  return { ...row, isDefault: row.admin === row.defaultAdmin && row.member === row.defaultMember };
}

export function buildMatrix(permissions: ApiPermission[]): Array<{ title: string; rows: MatrixRow[] }> {
  const byName = new Map(permissions.map(p => [p.name, p]));
  return PERMISSION_GROUPS.map(group => ({
    title: group.title,
    rows: group.permissions
      .filter(name => !HIDDEN.has(name) && byName.has(name))
      .map(name => {
        const p = byName.get(name)!;
        return withDefault({
          name,
          description: p.description,
          admin: p.roles.includes('admin'),
          member: p.roles.includes('member'),
          defaultAdmin: p.defaultRoles.includes('admin'),
          defaultMember: p.defaultRoles.includes('member'),
          locked: p.locked,
        });
      }),
  })).filter(group => group.rows.length > 0);
}

export function toggleRole(row: MatrixRow, role: EditableRole): MatrixRow {
  if (row.locked) return row;
  return withDefault({ ...row, [role]: !row[role] });
}

export function resetRow(row: MatrixRow): MatrixRow {
  return withDefault({ ...row, admin: row.defaultAdmin, member: row.defaultMember });
}

/** The PUT body: only rows that differ from their default; locked rows never. */
export function toOverrides(rows: MatrixRow[]): Partial<Record<Permission, string[]>> {
  const out: Partial<Record<Permission, string[]>> = {};
  for (const row of rows) {
    if (row.locked || row.isDefault) continue;
    out[row.name] = ['owner', ...(row.admin ? ['admin'] : []), ...(row.member ? ['member'] : [])];
  }
  return out;
}

export function isDirty(loaded: MatrixRow[], current: MatrixRow[]): boolean {
  const before = new Map(loaded.map(r => [r.name, r]));
  return current.some(r => {
    const b = before.get(r.name);
    return !b || b.admin !== r.admin || b.member !== r.member;
  });
}
