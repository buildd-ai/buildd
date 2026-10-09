/**
 * Test harness for the personal-role routes: an in-memory table store behind
 * a fake `db`, and drizzle predicate builders that actually evaluate against
 * rows. A mocked db that returns canned rows makes every WHERE clause
 * unobservable; here a missing `ownerUserId` filter or a write that never
 * happened shows up as wrong rows in `store`.
 *
 * Call `installPersonalRoleMocks()` before importing a route (dynamic import).
 */
import { mock } from 'bun:test';
import { roleHas } from '@/lib/permission-registry';

type Row = Record<string, any>;
type Pred = (row: Row) => boolean;
type Col = { __col: string };

export const store: Record<string, Row[]> = {};
/** userId -> teamId -> team role. */
export const teamRoles: Record<string, Record<string, string>> = {};
export const session: { user: { id: string } | null; cookieTeam?: string } = { user: null };

const SKILL_DEFAULTS: Row = {
  workspaceId: null, accountId: null, ownerUserId: null, visibility: 'team', enabled: true,
  isRole: false, metadata: {}, requiredEnvVars: {}, connectorRefs: [], mcpServers: {},
  allowedTools: [], canDelegateTo: [], model: 'inherit', configStorageKey: null,
};

export function resetStore() {
  for (const k of Object.keys(store)) delete store[k];
  for (const k of Object.keys(teamRoles)) delete teamRoles[k];
  for (const t of ['workspaceSkills', 'secrets', 'connectors', 'connectorShares', 'users', 'workspaces']) store[t] = [];
  session.user = null;
  session.cookieTeam = undefined;
}
resetStore();

let seq = 0;
export function uuid(): string {
  seq += 1;
  return `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`;
}

export function addRole(row: Row): Row {
  const full = { ...SKILL_DEFAULTS, id: uuid(), content: 'x', name: row.slug, ...row };
  store.workspaceSkills.push(full);
  return full;
}

function table(name: string) {
  return new Proxy({ __table: name } as Record<string, unknown>, {
    get: (target, prop) => (prop === '__table' ? target.__table : typeof prop === 'string' ? { __col: prop } : undefined),
  });
}

const val = (row: Row, c: Col) => row[c.__col];
const drizzle = {
  eq: (c: Col, v: unknown): Pred => row => val(row, c) === v,
  ne: (c: Col, v: unknown): Pred => row => val(row, c) !== v,
  isNull: (c: Col): Pred => row => val(row, c) == null,
  isNotNull: (c: Col): Pred => row => val(row, c) != null,
  inArray: (c: Col, vs: unknown[]): Pred => row => vs.includes(val(row, c)),
  and: (...ps: (Pred | undefined)[]): Pred => row => ps.every(p => !p || p(row)),
  or: (...ps: (Pred | undefined)[]): Pred => {
    const live = ps.filter(Boolean) as Pred[];
    return row => live.some(p => p(row));
  },
  desc: (c: Col) => c,
  sql: Object.assign(() => () => true, { empty: '' }),
};

function pick(row: Row, columns?: Record<string, boolean>) {
  if (!columns) return { ...row };
  return Object.fromEntries(Object.keys(columns).map(k => [k, row[k]]));
}

function queryApi(name: string) {
  return {
    findFirst: async ({ where, columns }: { where?: Pred; columns?: Record<string, boolean> } = {}) => {
      const hit = store[name].find(r => !where || where(r));
      return hit ? pick(hit, columns) : undefined;
    },
    findMany: async ({ where, columns }: { where?: Pred; columns?: Record<string, boolean> } = {}) =>
      store[name].filter(r => !where || where(r)).map(r => pick(r, columns)),
  };
}

function settled<T>(value: T) {
  return { returning: async () => value, then: (res: (v: T) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(value).then(res, rej) };
}

export const db = {
  query: new Proxy({}, { get: (_t, prop: string) => queryApi(prop) }),
  select: () => ({
    from: (t: { __table: string }) => ({
      where: (p: Pred) => {
        const rows = store[t.__table].filter(p).map(r => ({ ...r }));
        return Object.assign(Promise.resolve(rows), { orderBy: async () => rows });
      },
    }),
  }),
  insert: (t: { __table: string }) => ({
    values: (v: Row) => {
      const row = { ...(t.__table === 'workspaceSkills' ? SKILL_DEFAULTS : {}), id: uuid(), ...v };
      store[t.__table].push(row);
      return settled([{ ...row }]);
    },
  }),
  update: (t: { __table: string }) => ({
    set: (patch: Row) => ({
      where: (p: Pred) => {
        const hit = store[t.__table].filter(p);
        for (const r of hit) Object.assign(r, patch);
        return settled(hit.map(r => ({ ...r })));
      },
    }),
  }),
  delete: (t: { __table: string }) => ({
    where: (p: Pred) => {
      const keep = store[t.__table].filter(r => !p(r));
      const gone = store[t.__table].length - keep.length;
      store[t.__table] = keep;
      return settled(gone);
    },
  }),
};

export function installPersonalRoleMocks() {
  mock.module('@buildd/core/db', () => ({ db }));
  mock.module('drizzle-orm', () => drizzle);
  mock.module('@buildd/core/db/schema', () => ({
    workspaceSkills: table('workspaceSkills'),
    secrets: table('secrets'),
    connectors: table('connectors'),
    connectorShares: table('connectorShares'),
    users: table('users'),
    workspaces: table('workspaces'),
    accounts: table('accounts'),
    connectorCatalogTeamPolicies: table('connectorCatalogTeamPolicies'),
  }));
  mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: async () => session.user }));
  mock.module('@/lib/api-auth', () => ({ authenticateApiKey: async () => null }));
  const teamIdsOf = async (userId: string) => Object.keys(teamRoles[userId] ?? {});
  mock.module('@/lib/team-access', () => ({
    getUserTeamIds: teamIdsOf,
    getUserWorkspaceIds: async (userId: string) => {
      const teams = await teamIdsOf(userId);
      return store.workspaces.filter(w => teams.includes(w.teamId)).map(w => w.id);
    },
    resolveActiveTeamId: async (userId: string, cookie: string | null) => {
      const teams = await teamIdsOf(userId);
      if (cookie && teams.includes(cookie)) return cookie;
      return teams[0] ?? null;
    },
    verifyWorkspaceAccess: async (userId: string, wsId: string) => {
      const ws = store.workspaces.find(w => w.id === wsId);
      const role = ws ? teamRoles[userId]?.[ws.teamId] : undefined;
      return ws && role ? { teamId: ws.teamId, role } : null;
    },
    verifyAccountWorkspaceAccess: async () => false,
  }));
  // `can` through the real registry with default grants.
  mock.module('@/lib/permissions', () => ({
    can: async (caller: { kind: string; userId?: string }, permission: any, teamId: string) =>
      caller.kind === 'user' && roleHas(teamRoles[caller.userId!]?.[teamId], permission, {}),
    roleHas,
    getTeamPermissionOverrides: async () => ({}),
  }));
  mock.module('@/lib/mission-context', () => ({
    // Reproduces the workspace view's reach: workspace rows + every team-level
    // row of the workspace's team, personal ones included.
    getWorkspaceRoles: async (wsId: string) => {
      const ws = store.workspaces.find(w => w.id === wsId);
      return store.workspaceSkills
        .filter(r => r.isRole && r.enabled && (r.workspaceId === wsId || (r.workspaceId == null && r.teamId === ws?.teamId)))
        .map(r => ({ slug: r.slug, name: r.name, workspaceId: r.workspaceId, currentLoad: 0 }));
    },
  }));
  mock.module('@/lib/account-workspace-cache', () => ({ getAccountWorkspacePermissions: async () => [] }));
  mock.module('@/lib/open-workspaces', () => ({ listOpenWorkspaces: async () => [] }));
  mock.module('@/lib/storage', () => ({ isStorageConfigured: () => false }));
  mock.module('@/lib/role-config', () => ({
    packageRoleConfig: async () => ({}),
    uploadRoleConfig: async () => ({ configHash: 'h', configStorageKey: 'k' }),
    deleteRoleConfig: async () => {},
  }));
}

export function jsonReq(url: string, method: string, body?: unknown) {
  // Lazy import keeps next/server out of the module graph until a test runs.
  const { NextRequest } = require('next/server') as typeof import('next/server');
  return new NextRequest(url, {
    method,
    ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}),
  });
}

export const params = (id: string) => ({ params: Promise.resolve({ id }) });
