import { describe, it, expect, beforeEach, mock } from 'bun:test';

// The registry must reproduce today's call-site rules exactly. EXPECTED is
// written out by hand from the inventory in docs/specs/team-permissions.md —
// not derived from PERMISSIONS — so a changed default fails here first.

const mockTeamMembersFindMany = mock(() => [] as any[]);
const mockTeamsFindFirst = mock(() => null as any);

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      teamMembers: { findMany: mockTeamMembersFindMany },
      teams: { findFirst: mockTeamsFindFirst },
    },
  },
}));

const {
  PERMISSIONS, TEAM_ROLES, API_KEY_LEVELS, roleHas, keyLevelHas, can, teamIdsWhere,
} = await import('./permissions');
type Permission = import('./permissions').Permission;
type TeamRole = import('./permissions').TeamRole;
type ApiKeyLevel = import('./permissions').ApiKeyLevel;

type Row = { roles: TeamRole[]; keys: ApiKeyLevel[] };
const OA: TeamRole[] = ['owner', 'admin'];
const O: TeamRole[] = ['owner'];
const NONE: ApiKeyLevel[] = [];
const ADMIN_KEY: ApiKeyLevel[] = ['admin'];
const ANY_KEY: ApiKeyLevel[] = ['trigger', 'worker', 'admin'];

const EXPECTED: Record<Permission, Row> = {
  manage_team_members: { roles: OA, keys: NONE },
  assign_team_owner: { roles: O, keys: NONE },
  manage_team_settings: { roles: OA, keys: NONE },
  delete_team: { roles: O, keys: NONE },
  manage_team_permissions: { roles: O, keys: NONE },
  seed_team_timezone: { roles: O, keys: NONE },
  manage_chat_retro: { roles: OA, keys: ADMIN_KEY },
  activate_chat_retro_dogfood: { roles: O, keys: NONE },
  view_team_usage: { roles: OA, keys: NONE },
  manage_billing: { roles: OA, keys: NONE },
  manage_team_keys: { roles: OA, keys: NONE },
  manage_team_model_keys: { roles: OA, keys: ADMIN_KEY },
  manage_inference_providers: { roles: OA, keys: NONE },
  manage_model_tiers: { roles: OA, keys: ADMIN_KEY },
  manage_ai_budget: { roles: OA, keys: ADMIN_KEY },
  use_chat_admin_tools: { roles: OA, keys: NONE },
  manage_workspace_settings: { roles: OA, keys: ADMIN_KEY },
  delete_workspace: { roles: O, keys: NONE },
  migrate_workspace: { roles: OA, keys: ADMIN_KEY },
  manage_github_installation: { roles: OA, keys: NONE },
  review_memory: { roles: OA, keys: ADMIN_KEY },
  delegate_schedule_access: { roles: OA, keys: ADMIN_KEY },
  steer_workers: { roles: OA, keys: ADMIN_KEY },
  force_reassign_task: { roles: OA, keys: ANY_KEY },
  manage_releases: { roles: OA, keys: ADMIN_KEY },
  manage_connectors: { roles: OA, keys: ADMIN_KEY },
  manage_evidence_backends: { roles: OA, keys: ADMIN_KEY },
  run_experiments: { roles: OA, keys: ADMIN_KEY },
  assign_team_roles: { roles: OA, keys: NONE },
  manage_team_credentials: { roles: OA, keys: ADMIN_KEY },
  manage_team_notifications: { roles: OA, keys: ADMIN_KEY },
  create_workspace: { roles: OA, keys: ADMIN_KEY },
  manage_agent_roles: { roles: OA, keys: ADMIN_KEY },
};

const ALL = Object.keys(PERMISSIONS) as Permission[];

beforeEach(() => {
  mockTeamMembersFindMany.mockReset();
  mockTeamsFindFirst.mockReset();
  mockTeamMembersFindMany.mockResolvedValue([]);
  mockTeamsFindFirst.mockResolvedValue(null);
});

describe('registry', () => {
  it('EXPECTED covers exactly the registered permissions', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...ALL].sort());
  });

  it('every permission has a description', () => {
    for (const p of ALL) expect(PERMISSIONS[p].description.length).toBeGreaterThan(0);
  });

  it('a member holds no permission by default', () => {
    for (const p of ALL) expect(roleHas('member', p, null)).toBe(false);
  });
});

describe('roleHas: every permission × every team role', () => {
  for (const p of ALL) {
    for (const role of TEAM_ROLES) {
      const want = EXPECTED[p].roles.includes(role);
      it(`${p} × ${role} → ${want}`, () => {
        expect(roleHas(role, p, null)).toBe(want);
      });
    }
  }
});

describe('keyLevelHas: every permission × every API-key level', () => {
  for (const p of ALL) {
    for (const level of API_KEY_LEVELS) {
      const want = EXPECTED[p].keys.includes(level);
      it(`${p} × ${level} key → ${want}`, () => {
        expect(keyLevelHas(level, p)).toBe(want);
      });
    }
  }
});

describe('can: session users', () => {
  for (const p of ALL) {
    for (const role of TEAM_ROLES) {
      const want = EXPECTED[p].roles.includes(role);
      it(`${p} × ${role} member → ${want}`, async () => {
        mockTeamMembersFindMany.mockResolvedValue([{ teamId: 'team-t', role }]);
        expect(await can({ kind: 'user', userId: 'u1' }, p, 'team-t')).toBe(want);
      });
    }
  }

  it('denies in a team the user does not belong to', async () => {
    mockTeamMembersFindMany.mockResolvedValue([{ teamId: 'team-t', role: 'owner' }]);
    expect(await can({ kind: 'user', userId: 'u1' }, 'manage_team_settings', 'team-other')).toBe(false);
  });

  it('treats the personal team as owned, even with no membership row', async () => {
    mockTeamsFindFirst.mockResolvedValue({ id: 'team-personal' });
    expect(await can({ kind: 'user', userId: 'u1' }, 'delete_workspace', 'team-personal')).toBe(true);
  });

  it('the personal team wins over a member row in it', async () => {
    mockTeamMembersFindMany.mockResolvedValue([{ teamId: 'team-personal', role: 'member' }]);
    mockTeamsFindFirst.mockResolvedValue({ id: 'team-personal' });
    expect(await can({ kind: 'user', userId: 'u1' }, 'assign_team_owner', 'team-personal')).toBe(true);
  });

  it('teamIdsWhere lists only teams whose role grants the permission', async () => {
    mockTeamMembersFindMany.mockResolvedValue([
      { teamId: 'team-o', role: 'owner' },
      { teamId: 'team-a', role: 'admin' },
      { teamId: 'team-m', role: 'member' },
    ]);
    const caller = { kind: 'user' as const, userId: 'u1' };
    expect((await teamIdsWhere(caller, 'manage_releases')).sort()).toEqual(['team-a', 'team-o']);
    expect(await teamIdsWhere(caller, 'delete_team')).toEqual(['team-o']);
  });
});

/** String values bound into a drizzle condition (eq(col, value) → Param chunks). */
function boundValues(node: unknown, seen = new Set<unknown>()): string[] {
  if (!node || typeof node !== 'object' || seen.has(node)) return [];
  seen.add(node);
  const own = (node as { value?: unknown }).value;
  const out = typeof own === 'string' ? [own] : [];
  for (const child of Object.values(node as Record<string, unknown>)) {
    if (child && typeof child === 'object' && !('table' in (child as object) && 'name' in (child as object))) out.push(...boundValues(child, seen));
  }
  return out;
}

describe('can: team overrides', () => {
  const caller = { kind: 'user' as const, userId: 'u1' };

  it("applies the team's stored grants, per team", async () => {
    mockTeamMembersFindMany.mockResolvedValue([
      { teamId: 'team-open', role: 'member' },
      { teamId: 'team-default', role: 'member' },
    ]);
    mockTeamsFindFirst.mockImplementation(async (q: any) => {
      // The personal-team lookup asks by slug; the overrides read asks by id.
      const values = boundValues(q?.where);
      if (values.some(v => v.startsWith('personal-'))) return null;
      return { permissionOverrides: values.includes('team-open') ? { manage_releases: ['owner', 'admin', 'member'] } : {} };
    });
    expect(await can(caller, 'manage_releases', 'team-open')).toBe(true);
    expect(await can(caller, 'manage_releases', 'team-default')).toBe(false);
  });

  it('a stored grant can take a permission away from admins', async () => {
    mockTeamMembersFindMany.mockResolvedValue([{ teamId: 'team-x', role: 'admin' }]);
    mockTeamsFindFirst.mockImplementation(async () => ({ permissionOverrides: { manage_releases: ['owner'] } }));
    expect(await can(caller, 'manage_releases', 'team-x')).toBe(false);
  });

  it('ignores a stored grant for a locked permission', async () => {
    mockTeamMembersFindMany.mockResolvedValue([{ teamId: 'team-x', role: 'admin' }]);
    mockTeamsFindFirst.mockImplementation(async () => ({ permissionOverrides: { delete_team: ['owner', 'admin'], manage_team_permissions: ['owner', 'admin'] } }));
    expect(await can(caller, 'delete_team', 'team-x')).toBe(false);
    expect(await can(caller, 'manage_team_permissions', 'team-x')).toBe(false);
  });

  it('does not change what an API key may do', async () => {
    mockTeamsFindFirst.mockImplementation(async () => ({ permissionOverrides: { manage_releases: ['owner'] } }));
    expect(await can({ kind: 'account', accountId: 'a1', teamId: 'team-k', level: 'admin' }, 'manage_releases', 'team-k')).toBe(true);
  });
});

describe('can: API keys', () => {
  for (const p of ALL) {
    for (const level of API_KEY_LEVELS) {
      const want = EXPECTED[p].keys.includes(level);
      it(`${p} × ${level} key → ${want}`, async () => {
        expect(await can({ kind: 'account', accountId: 'a1', teamId: 'team-k', level }, p, 'team-k')).toBe(want);
      });
    }
  }

  it("never reaches beyond the key's own team", async () => {
    const key = { kind: 'account' as const, accountId: 'a1', teamId: 'team-k', level: 'admin' };
    expect(await can(key, 'manage_releases', 'team-other')).toBe(false);
  });
});

describe('fails closed', () => {
  it('an unknown permission name is a type error', () => {
    // @ts-expect-error — not a registered permission
    const bogus: Permission = 'launch_rockets';
    expect(ALL.includes(bogus)).toBe(false);
  });

  it('denies an unknown or missing role', async () => {
    for (const role of ['superuser', 'Owner', '', null, undefined]) {
      expect(roleHas(role as string, 'manage_team_members', null)).toBe(false);
    }
    mockTeamMembersFindMany.mockResolvedValue([{ teamId: 'team-t', role: 'superuser' }]);
    expect(await can({ kind: 'user', userId: 'u1' }, 'manage_team_members', 'team-t')).toBe(false);
  });

  it('denies an unknown or missing key level', async () => {
    for (const level of ['root', 'ADMIN', '', null, undefined]) {
      expect(keyLevelHas(level, 'force_reassign_task')).toBe(false);
      expect(await can({ kind: 'account', accountId: 'a1', teamId: 'team-k', level }, 'force_reassign_task', 'team-k')).toBe(false);
    }
  });

  it('denies an empty team id', async () => {
    const key = { kind: 'account' as const, accountId: 'a1', teamId: '', level: 'admin' };
    expect(await can(key, 'manage_releases', '')).toBe(false);
  });
});
