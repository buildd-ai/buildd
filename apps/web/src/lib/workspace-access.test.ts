import { describe, it, expect, beforeEach, mock } from 'bun:test';

// The shared workspace-reach rule (workspace-reach.ts) and the resolver/listing
// built on it (workspace-access.ts). Route-level coverage of the same three
// cases lives in the workspaces, tasks and missions route tests.

let links: Array<{ workspaceId: string; canClaim: boolean; canCreate: boolean }> = [];
let ownOpenRows: Array<{ id: string; teamId: string; accessMode: string }> = [];
let resolved: Record<string, any> | null = null;
let existing: Record<string, any> | undefined;
let linkRow: { canClaim: boolean; canCreate: boolean } | undefined;
const findManyWheres: unknown[] = [];

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workspaces: {
        findMany: async (opts: { where: unknown }) => (findManyWheres.push(opts.where), ownOpenRows),
        findFirst: async () => existing,
      },
      accountWorkspaces: { findFirst: async () => linkRow },
    },
  },
}));
mock.module('@/lib/team-access', () => ({
  getUserTeamIds: async () => ['team-u'],
  getUserWorkspaceIds: async () => ['ws-of-user'],
}));
mock.module('@/lib/account-workspace-cache', () => ({
  getAccountWorkspacePermissions: async () => links,
}));
mock.module('@/lib/workspace-resolver', () => ({
  resolveWorkspace: async () => resolved,
}));

const { accountReachesWorkspace } = await import('./workspace-reach');
const { listReachableWorkspaceIds, resolveWorkspaceAccess } = await import('./workspace-access');
const { PgDialect } = await import('drizzle-orm/pg-core');

const ACCOUNT = { account: { id: 'acct-a', name: 'runner', teamId: 'team-a' } };
const UUID = '30000000-0000-4000-8000-000000000001';

beforeEach(() => {
  links = [];
  ownOpenRows = [];
  resolved = null;
  existing = undefined;
  linkRow = undefined;
  findManyWheres.length = 0;
});

describe('accountReachesWorkspace — the one rule', () => {
  const a = { teamId: 'team-a' };
  it('own team + open: reachable', () => {
    expect(accountReachesWorkspace(a, { teamId: 'team-a', accessMode: 'open' }, null, 'canCreate')).toBe(true);
  });
  it('own team + restricted, no link: not reachable', () => {
    expect(accountReachesWorkspace(a, { teamId: 'team-a', accessMode: 'restricted' }, null)).toBe(false);
  });
  it('other team + open, no link: never reachable', () => {
    expect(accountReachesWorkspace(a, { teamId: 'team-b', accessMode: 'open' }, null)).toBe(false);
    expect(accountReachesWorkspace(a, { teamId: 'team-b', accessMode: 'open' }, null, 'canClaim')).toBe(false);
  });
  it('explicit link: reachable when it carries the permission', () => {
    const ws = { teamId: 'team-b', accessMode: 'restricted' };
    expect(accountReachesWorkspace(a, ws, { canClaim: true, canCreate: false })).toBe(true);
    expect(accountReachesWorkspace(a, ws, { canClaim: true, canCreate: false }, 'canClaim')).toBe(true);
    expect(accountReachesWorkspace(a, ws, { canClaim: true, canCreate: false }, 'canCreate')).toBe(false);
  });
});

describe('listReachableWorkspaceIds', () => {
  it("queries only the account's own team's open workspaces", async () => {
    await listReachableWorkspaceIds(ACCOUNT);
    const q = new PgDialect().sqlToQuery(findManyWheres[0] as any);
    expect(q.sql).toContain('"team_id" =');
    expect(q.sql).toContain('"access_mode" =');
    expect(q.params).toEqual(['team-a', 'open']);
  });

  it('lists own open + linked, and drops a foreign open row even if the db returned one', async () => {
    links = [{ workspaceId: 'ws-linked', canClaim: true, canCreate: true }];
    ownOpenRows = [
      { id: 'ws-own-open', teamId: 'team-a', accessMode: 'open' },
      { id: 'ws-foreign-open', teamId: 'team-b', accessMode: 'open' },
    ];
    expect((await listReachableWorkspaceIds(ACCOUNT)).sort()).toEqual(['ws-linked', 'ws-own-open']);
  });

  it('narrows links by permission', async () => {
    links = [
      { workspaceId: 'ws-claim-only', canClaim: true, canCreate: false },
      { workspaceId: 'ws-create', canClaim: false, canCreate: true },
    ];
    expect(await listReachableWorkspaceIds(ACCOUNT, 'canCreate')).toEqual(['ws-create']);
  });

  it('a session user lists their teams\' workspaces', async () => {
    expect(await listReachableWorkspaceIds({ userId: 'u-1' })).toEqual(['ws-of-user']);
  });
});

describe('resolveWorkspaceAccess', () => {
  it('own team open workspace: ok', async () => {
    resolved = { id: UUID, teamId: 'team-a', accessMode: 'open' };
    const r = await resolveWorkspaceAccess(UUID, ACCOUNT, 'canCreate');
    expect(r.ok).toBe(true);
  });

  it('linked workspace in another team: ok', async () => {
    resolved = { id: UUID, teamId: 'team-b', accessMode: 'restricted' };
    linkRow = { canClaim: true, canCreate: true };
    expect((await resolveWorkspaceAccess(UUID, ACCOUNT, 'canCreate')).ok).toBe(true);
  });

  it("another team's open workspace: 403 no_access, not 'not found'", async () => {
    resolved = null; // outside the account's resolution scope
    existing = { id: UUID };
    const r = await resolveWorkspaceAccess(UUID, ACCOUNT, 'canCreate');
    expect(r).toMatchObject({ ok: false, reason: 'no_access', status: 403 });
    if (!r.ok) expect(r.error).toStartWith(`No access to workspace "${UUID}"`);
  });

  it('own team restricted without a link: 403 no_access', async () => {
    resolved = { id: UUID, teamId: 'team-a', accessMode: 'restricted' };
    const r = await resolveWorkspaceAccess(UUID, ACCOUNT, 'canCreate');
    expect(r).toMatchObject({ ok: false, reason: 'no_access', status: 403 });
  });

  it('nonexistent UUID: 404 not_found', async () => {
    const r = await resolveWorkspaceAccess(UUID, ACCOUNT);
    expect(r).toMatchObject({ ok: false, reason: 'not_found', status: 404 });
    if (!r.ok) expect(r.error).toContain('No workspace found matching');
  });

  it('a bare name outside scope is never confirmed to exist elsewhere', async () => {
    existing = { id: UUID };
    const r = await resolveWorkspaceAccess('some-name', ACCOUNT);
    expect(r).toMatchObject({ ok: false, reason: 'not_found' });
  });

  it("session user: own team ok, another team's workspace no_access", async () => {
    resolved = { id: UUID, teamId: 'team-u', accessMode: 'restricted' };
    expect((await resolveWorkspaceAccess(UUID, { userId: 'u-1' })).ok).toBe(true);
    resolved = null;
    existing = { id: UUID };
    expect(await resolveWorkspaceAccess(UUID, { userId: 'u-1' })).toMatchObject({ reason: 'no_access' });
  });
});
