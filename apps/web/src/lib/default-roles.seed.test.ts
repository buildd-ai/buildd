import { describe, it, expect, beforeEach, mock } from 'bun:test';

// The override record the mocked `system_cache` read returns; undefined = no row.
let storedRecord: unknown;
let inserted: Array<Record<string, unknown>> = [];

mock.module('@buildd/core/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => (storedRecord === undefined ? [] : [{ value: storedRecord }]),
        }),
      }),
    }),
    insert: () => ({
      values: (rows: Array<Record<string, unknown>>) => {
        inserted = rows;
        return { onConflictDoNothing: async () => {} };
      },
    }),
  },
}));

const { DEFAULT_ROLES, seedDefaultRolesForTeam, resolveDefaultRoles, planDefaultRoleResync, roleContentHash } = await import('./default-roles');
const { resetPolicyOverrides } = await import('./policy-overrides');
const { resetPolicyOverridesLoader } = await import('./policy-overrides-source');

const byslug = (rows: Array<Record<string, unknown>>, slug: string) => rows.find(r => r.slug === slug)!;

beforeEach(() => {
  storedRecord = undefined;
  inserted = [];
  resetPolicyOverrides();
  resetPolicyOverridesLoader();
});

describe('seedDefaultRolesForTeam', () => {
  it('seeds the public text when no override record exists', async () => {
    await seedDefaultRolesForTeam('team-1');
    expect(inserted).toHaveLength(DEFAULT_ROLES.length);
    for (const role of DEFAULT_ROLES) {
      const row = byslug(inserted, role.slug);
      expect(row.content).toBe(role.content);
      expect(row.contentHash).toBe(roleContentHash(role.content));
      expect(row.description).toBe(role.description);
    }
  });

  it('seeds the override content when the record carries one', async () => {
    storedRecord = { roles: { builder: { content: 'override builder text', description: 'override description' } } };
    await seedDefaultRolesForTeam('team-1');
    const builder = byslug(inserted, 'builder');
    expect(builder.content).toBe('override builder text');
    expect(builder.contentHash).toBe(roleContentHash('override builder text'));
    expect(builder.description).toBe('override description');
    // Roles without an override keep the public text.
    const organizer = DEFAULT_ROLES.find(r => r.slug === 'organizer')!;
    expect(byslug(inserted, 'organizer').content).toBe(organizer.content);
  });

  it('an invalid role override falls back to the public text', async () => {
    storedRecord = { roles: { builder: { content: '' } } };
    await seedDefaultRolesForTeam('team-1');
    const builder = DEFAULT_ROLES.find(r => r.slug === 'builder')!;
    expect(byslug(inserted, 'builder').content).toBe(builder.content);
  });
});

describe('resolveDefaultRoles', () => {
  it('leaves DEFAULT_ROLES untouched and ignores unknown slugs', () => {
    const before = DEFAULT_ROLES.map(r => r.content);
    const roles = resolveDefaultRoles({ builder: { content: 'x' }, 'not-a-role': { content: 'y' } });
    expect(roles.find(r => r.slug === 'builder')!.content).toBe('x');
    expect(roles.some(r => r.slug === 'not-a-role')).toBe(false);
    expect(DEFAULT_ROLES.map(r => r.content)).toEqual(before);
  });

  it('a raised version and extra hashes let a resync replace earlier text with the override', () => {
    const builder = DEFAULT_ROLES.find(r => r.slug === 'builder')!;
    const roles = resolveDefaultRoles({
      builder: { content: 'x', version: builder.version + 1, supersededContentHashes: [roleContentHash(builder.content)] },
    });
    const plan = planDefaultRoleResync([{
      id: 'row-1', slug: 'builder', source: 'system',
      contentHash: roleContentHash(builder.content),
      metadata: { defaultRoleVersion: builder.version },
    }], roles);
    expect(plan).toEqual([{ id: 'row-1', slug: 'builder', version: builder.version + 1, content: 'x', contentHash: roleContentHash('x') }]);
  });
});
