import { describe, it, expect, mock, beforeEach } from 'bun:test';

/**
 * Coverage note — why this file exists.
 *
 * `resolveMcpConnectorsForTask` decides which MCP servers (and which decrypted
 * credentials) reach an agent. Until now its only coverage was 18 tests inside
 * the 4800-line `route.test.ts`, each of which had to build a full authenticated
 * HTTP claim request to exercise a pure resolution function. Those tests stay as
 * the integration contract; these test the module directly.
 *
 * Contract under test (module doc comment + docs/specs/mcp-connectors-and-roles.md
 * §1b/§2/§3): a connector reaches the agent iff
 *   role.connectorRefs ∩ enabledForWorkspace ∩ visibleConnectors(owned ∪ shared-in)
 * with credentials always resolved by the connector's OWNER team.
 */

// --- drizzle stub: predicates become inspectable plain objects, so a test can
// assert *which team* a secrets lookup was keyed on (the §1b invariant) and the
// secrets mock can dispatch on `purpose` (the module issues two secrets queries).
mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  and: (...args: any[]) => ({ args, type: 'and' }),
  or: (...args: any[]) => ({ args, type: 'or' }),
  isNull: (field: any) => ({ field, type: 'isNull' }),
  inArray: (field: any, values: any[]) => ({ field, values, type: 'inArray' }),
}));

mock.module('@buildd/core/db/schema', () => ({
  workspaceSkills: {
    slug: 'slug', isRole: 'isRole', enabled: 'enabled', workspaceId: 'workspaceId',
    teamId: 'teamId', connectorRefs: 'connectorRefs',
  },
  connectors: { id: 'id', teamId: 'teamId', name: 'name' },
  connectorShares: { connectorId: 'connectorId', sharedWithTeamId: 'sharedWithTeamId' },
  connectorWorkspaces: { connectorId: 'connectorId', workspaceId: 'workspaceId', enabled: 'enabled' },
  secrets: { teamId: 'teamId', purpose: 'purpose', label: 'label' },
}));

const mockWorkspaceSkillsFindMany = mock(async (_args?: any) => [] as any[]);
const mockConnectorsFindMany = mock(async (_args?: any) => [] as any[]);
const mockConnectorSharesFindMany = mock(async (_args?: any) => [] as any[]);
const mockConnectorWorkspacesFindMany = mock(async (_args?: any) => [] as any[]);
const mockSecretsFindMany = mock(async (_args?: any) => [] as any[]);

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workspaceSkills: { findMany: mockWorkspaceSkillsFindMany },
      connectors: { findMany: mockConnectorsFindMany },
      connectorShares: { findMany: mockConnectorSharesFindMany },
      connectorWorkspaces: { findMany: mockConnectorWorkspacesFindMany },
      secrets: { findMany: mockSecretsFindMany },
    },
  },
}));

const mockRefresh = mock(async (_secretId: string) => 'refreshed' as string);
mock.module('@/lib/mcp-connector-refresh', () => ({
  refreshMcpConnectorCredential: mockRefresh,
}));

const { resolveMcpConnectorsForTask, attachMcpConnectors, slugifyConnectorName } =
  await import('./mcp-connector-injection');

// --- fixtures -------------------------------------------------------------

const NOW = new Date('2026-09-04T12:00:00.000Z');
const TEAM = 'team-1';
const OTHER_TEAM = 'team-owner';

/** A claim-candidate task row as the claim route hydrates it. */
function task(overrides: Record<string, any> = {}) {
  return {
    id: 'task-1',
    workspaceId: 'ws-1',
    roleSlug: 'builder',
    workspace: { id: 'ws-1', teamId: TEAM },
    ...overrides,
  } as any;
}

/** A connectors row. Defaults to the simplest mountable shape: http + authMode none. */
function connector(overrides: Record<string, any> = {}) {
  return {
    id: 'conn-1',
    teamId: TEAM,
    name: 'my-mcp',
    url: 'https://mcp.example.com',
    authMode: 'none',
    headerName: null,
    transport: 'http',
    command: null,
    args: [],
    envMapping: {},
    assertionAudience: null,
    assertionTokenEndpoint: null,
    ...overrides,
  };
}

/** A role row. `workspaceId: null` = the team-default row. */
function role(connectorRefs: string[], workspaceId: string | null = null) {
  return { slug: 'builder', isRole: true, enabled: true, workspaceId, connectorRefs };
}

/** Reads the `purpose` a secrets query filtered on, out of the stubbed predicate tree. */
function purposeOf(args: any): string | undefined {
  const nodes = args?.where?.args ?? [];
  return nodes.find((n: any) => n?.type === 'eq' && n.field === 'purpose')?.value;
}

/** Reads the team ids a secrets query was keyed on (the §1b owner-team invariant). */
function teamIdsOf(args: any): string[] | undefined {
  const nodes = args?.where?.args ?? [];
  return nodes.find((n: any) => n?.type === 'inArray' && n.field === 'teamId')?.values;
}

/**
 * Stage the connectors table. The stub honours the `inArray(id, connectorRefs)`
 * filter the module applies, exactly as SQL would: a row no role referenced is
 * never returned. Without this, staging extra rows would make the role-precedence
 * tests pass no matter which role row won.
 */
function stageConnectors(rows: any[]) {
  mockConnectorsFindMany.mockImplementation(async (args: any) => {
    const ids: string[] = args?.where?.values ?? [];
    return rows.filter(r => ids.includes(r.id));
  });
}

/** Stage the two secrets queries the module issues, dispatched by `purpose`. */
function stageSecrets(opts: { credentials?: any[]; envSecrets?: any[] } = {}) {
  mockSecretsFindMany.mockImplementation(async (args: any) => {
    const purpose = purposeOf(args);
    if (purpose === 'mcp_connector_credential') return opts.credentials ?? [];
    if (purpose === 'mcp_credential') return opts.envSecrets ?? [];
    throw new Error(`unexpected secrets purpose: ${purpose}`);
  });
}

/** The SecretsProvider the claim route hands in — a map of secretId → plaintext. */
function provider(values: Record<string, string | null> = {}) {
  return { get: mock(async (id: string) => values[id] ?? null) } as any;
}

const resolve = (t: any = task(), p: any = provider(), now: Date = NOW) =>
  resolveMcpConnectorsForTask(t, now, p);

beforeEach(() => {
  mockWorkspaceSkillsFindMany.mockReset();
  mockWorkspaceSkillsFindMany.mockResolvedValue([role(['conn-1'])]);
  mockConnectorsFindMany.mockReset();
  stageConnectors([connector()]);
  mockConnectorSharesFindMany.mockReset();
  mockConnectorSharesFindMany.mockResolvedValue([]);
  mockConnectorWorkspacesFindMany.mockReset();
  mockConnectorWorkspacesFindMany.mockResolvedValue([
    { connectorId: 'conn-1', workspaceId: 'ws-1', enabled: true },
  ]);
  mockSecretsFindMany.mockReset();
  stageSecrets();
  mockRefresh.mockReset();
  mockRefresh.mockResolvedValue('refreshed');
});

// --- §2: the opt-in intersection -----------------------------------------

describe('resolveMcpConnectorsForTask — role opt-in intersection (§2)', () => {
  it('mounts a role-referenced, workspace-enabled, visible connector', async () => {
    expect(await resolve()).toEqual([
      { id: 'conn-1', name: 'my-mcp', transport: 'http', url: 'https://mcp.example.com' },
    ]);
  });

  // AC-1: enablement is not opt-in. The workspace enabling a connector the role
  // never referenced must not mount it.
  it('mounts only role-referenced connectors even when the workspace enables more', async () => {
    mockWorkspaceSkillsFindMany.mockResolvedValue([role(['conn-1'])]);
    stageConnectors([connector()]);
    mockConnectorWorkspacesFindMany.mockResolvedValue([
      { connectorId: 'conn-1', workspaceId: 'ws-1', enabled: true },
      { connectorId: 'conn-2', workspaceId: 'ws-1', enabled: true },
    ]);

    const result = await resolve();

    expect(result.map(c => c.id)).toEqual(['conn-1']);
    // The connectors query is scoped to the refs, never to "everything enabled".
    const refsFilter = (mockConnectorsFindMany.mock.calls[0]?.[0] as any)?.where;
    expect(refsFilter?.values).toEqual(['conn-1']);
  });

  // AC-3: least privilege. An unrouted task mounts nothing, and must not even
  // reach the role table.
  it('mounts nothing and queries nothing when the task has no roleSlug', async () => {
    expect(await resolve(task({ roleSlug: null }))).toEqual([]);
    expect(mockWorkspaceSkillsFindMany).not.toHaveBeenCalled();
    expect(mockConnectorsFindMany).not.toHaveBeenCalled();
  });

  it('mounts nothing when the resolved role has empty connectorRefs', async () => {
    mockWorkspaceSkillsFindMany.mockResolvedValue([role([])]);
    expect(await resolve()).toEqual([]);
    expect(mockConnectorsFindMany).not.toHaveBeenCalled();
  });

  it('mounts nothing when connectorRefs is null (never set)', async () => {
    mockWorkspaceSkillsFindMany.mockResolvedValue([
      { slug: 'builder', isRole: true, enabled: true, workspaceId: null, connectorRefs: null },
    ]);
    expect(await resolve()).toEqual([]);
    expect(mockConnectorsFindMany).not.toHaveBeenCalled();
  });

  it('mounts nothing when no role row matches (disabled / not a role / other team)', async () => {
    mockWorkspaceSkillsFindMany.mockResolvedValue([]);
    expect(await resolve()).toEqual([]);
    expect(mockConnectorsFindMany).not.toHaveBeenCalled();
  });

  it('mounts nothing when the task workspace has no team', async () => {
    expect(await resolve(task({ workspace: { id: 'ws-1', teamId: null } }))).toEqual([]);
    expect(await resolve(task({ workspace: undefined }))).toEqual([]);
    expect(mockWorkspaceSkillsFindMany).not.toHaveBeenCalled();
  });

  // AC-4: a dangling ref (deleted connector, or one no longer visible) drops out
  // instead of failing the claim.
  it('tolerates a dangling ref and mounts the surviving ones', async () => {
    mockWorkspaceSkillsFindMany.mockResolvedValue([role(['conn-1', 'conn-deleted'])]);
    stageConnectors([connector()]); // deleted row simply absent

    expect((await resolve()).map(c => c.id)).toEqual(['conn-1']);
  });

  it('mounts nothing when every ref is dangling', async () => {
    mockWorkspaceSkillsFindMany.mockResolvedValue([role(['conn-gone'])]);
    stageConnectors([]);

    expect(await resolve()).toEqual([]);
    expect(mockConnectorWorkspacesFindMany).not.toHaveBeenCalled();
  });

  // The role query must be scoped to the TASK's workspace team, not to whatever
  // team the runner belongs to.
  it('scopes the role lookup to the task slug, workspace and workspace team', async () => {
    await resolve(task({ roleSlug: 'researcher', workspaceId: 'ws-9', workspace: { teamId: 'team-9' } }));

    const where = (mockWorkspaceSkillsFindMany.mock.calls[0]?.[0] as any)?.where;
    const eqs = where.args.filter((a: any) => a.type === 'eq');
    expect(eqs).toEqual(expect.arrayContaining([
      { field: 'slug', value: 'researcher', type: 'eq' },
      { field: 'isRole', value: true, type: 'eq' },
      { field: 'enabled', value: true, type: 'eq' },
      { field: 'teamId', value: 'team-9', type: 'eq' },
    ]));
    // …plus (workspaceId IS NULL OR workspaceId = task.workspaceId)
    const orNode = where.args.find((a: any) => a.type === 'or');
    expect(orNode.args).toEqual([
      { field: 'workspaceId', type: 'isNull' },
      { field: 'workspaceId', value: 'ws-9', type: 'eq' },
    ]);
  });
});

describe('resolveMcpConnectorsForTask — role precedence', () => {
  // A workspace-scoped role row is an override of the team-default row; when both
  // match, only the workspace row's refs count.
  it('prefers the workspace-scoped role row over the team default', async () => {
    mockWorkspaceSkillsFindMany.mockResolvedValue([
      role(['conn-team'], null),
      role(['conn-ws'], 'ws-1'),
    ]);
    stageConnectors([
      connector({ id: 'conn-team', name: 'team-mcp' }),
      connector({ id: 'conn-ws', name: 'ws-mcp' }),
    ]);
    mockConnectorWorkspacesFindMany.mockResolvedValue([]);

    expect((await resolve()).map(c => c.id)).toEqual(['conn-ws']);
  });

  // Precedence must come from the scope, not from row order.
  it('prefers the workspace-scoped row regardless of row order', async () => {
    mockWorkspaceSkillsFindMany.mockResolvedValue([
      role(['conn-ws'], 'ws-1'),
      role(['conn-team'], null),
    ]);
    stageConnectors([
      connector({ id: 'conn-team', name: 'team-mcp' }),
      connector({ id: 'conn-ws', name: 'ws-mcp' }),
    ]);
    mockConnectorWorkspacesFindMany.mockResolvedValue([]);

    expect((await resolve()).map(c => c.id)).toEqual(['conn-ws']);
  });

  it('falls back to the team-default row when no workspace override exists', async () => {
    mockWorkspaceSkillsFindMany.mockResolvedValue([role(['conn-team'], null)]);
    stageConnectors([connector({ id: 'conn-team', name: 'team-mcp' })]);
    mockConnectorWorkspacesFindMany.mockResolvedValue([]);

    expect((await resolve()).map(c => c.id)).toEqual(['conn-team']);
  });
});

// --- §2: per-workspace enablement ----------------------------------------

describe('resolveMcpConnectorsForTask — workspace enablement', () => {
  it('treats a missing connector_workspaces row as enabled', async () => {
    mockConnectorWorkspacesFindMany.mockResolvedValue([]);
    expect((await resolve()).map(c => c.id)).toEqual(['conn-1']);
  });

  // AC-2: an explicit opt-out wins over the role's opt-in.
  it('excludes a connector whose row has enabled: false', async () => {
    mockConnectorWorkspacesFindMany.mockResolvedValue([
      { connectorId: 'conn-1', workspaceId: 'ws-1', enabled: false },
    ]);
    expect(await resolve()).toEqual([]);
  });

  it('excludes only the disabled connector, keeping the rest', async () => {
    mockWorkspaceSkillsFindMany.mockResolvedValue([role(['conn-1', 'conn-2'])]);
    stageConnectors([
      connector({ id: 'conn-1', name: 'first' }),
      connector({ id: 'conn-2', name: 'second' }),
    ]);
    mockConnectorWorkspacesFindMany.mockResolvedValue([
      { connectorId: 'conn-1', workspaceId: 'ws-1', enabled: false },
      { connectorId: 'conn-2', workspaceId: 'ws-1', enabled: true },
    ]);

    expect((await resolve()).map(c => c.id)).toEqual(['conn-2']);
  });

  // Enablement is per workspace: the query must be keyed on the task's workspace.
  it('scopes the enablement lookup to the task workspace', async () => {
    await resolve(task({ workspaceId: 'ws-7' }));

    const where = (mockConnectorWorkspacesFindMany.mock.calls[0]?.[0] as any)?.where;
    expect(where.args).toEqual(expect.arrayContaining([
      { field: 'workspaceId', value: 'ws-7', type: 'eq' },
    ]));
  });
});

// --- §1b: cross-team visibility ------------------------------------------

describe('resolveMcpConnectorsForTask — cross-team sharing (§1b)', () => {
  // AC-1: visibility = owned ∪ shared-in, and the credential comes from the OWNER.
  it('mounts a shared-in connector using the owner-team credential', async () => {
    mockWorkspaceSkillsFindMany.mockResolvedValue([role(['conn-shared'])]);
    stageConnectors([
      connector({ id: 'conn-shared', teamId: OTHER_TEAM, name: 'shared-mcp', authMode: 'header', headerName: 'X-API-Key' }),
    ]);
    mockConnectorSharesFindMany.mockResolvedValue([{ connectorId: 'conn-shared' }]);
    mockConnectorWorkspacesFindMany.mockResolvedValue([]);
    stageSecrets({ credentials: [{ id: 'cs-owner', label: 'conn-shared', tokenExpiresAt: null }] });

    const result = await resolve(task(), provider({ 'cs-owner': 'owner-secret' }));

    expect(result).toEqual([{
      id: 'conn-shared', name: 'shared-mcp', transport: 'http',
      url: 'https://mcp.example.com', headers: { 'X-API-Key': 'owner-secret' },
    }]);
    // Keyed on the owner team, NOT the task's workspace team.
    const credCall = mockSecretsFindMany.mock.calls.find(c => purposeOf(c[0]) === 'mcp_connector_credential');
    expect(teamIdsOf(credCall?.[0])).toEqual([OTHER_TEAM]);
  });

  // AC-5: revoking a share removes the row; a stale ref + stale enablement must
  // not keep the connector mounted.
  it('drops another team\'s connector when the share row is absent (revoked)', async () => {
    mockWorkspaceSkillsFindMany.mockResolvedValue([role(['conn-shared'])]);
    stageConnectors([
      connector({ id: 'conn-shared', teamId: OTHER_TEAM, name: 'shared-mcp' }),
    ]);
    mockConnectorSharesFindMany.mockResolvedValue([]);
    mockConnectorWorkspacesFindMany.mockResolvedValue([
      { connectorId: 'conn-shared', workspaceId: 'ws-1', enabled: true },
    ]);

    expect(await resolve()).toEqual([]);
  });

  it('keeps the owned connector when a sibling share is revoked', async () => {
    mockWorkspaceSkillsFindMany.mockResolvedValue([role(['conn-own', 'conn-shared'])]);
    stageConnectors([
      connector({ id: 'conn-own', teamId: TEAM, name: 'owned' }),
      connector({ id: 'conn-shared', teamId: OTHER_TEAM, name: 'shared' }),
    ]);
    mockConnectorSharesFindMany.mockResolvedValue([]);
    mockConnectorWorkspacesFindMany.mockResolvedValue([]);

    expect((await resolve()).map(c => c.id)).toEqual(['conn-own']);
  });

  it('looks up share grants for the task team, restricted to the referenced ids', async () => {
    mockWorkspaceSkillsFindMany.mockResolvedValue([role(['conn-a', 'conn-b'])]);
    stageConnectors([]);

    await resolve(task({ workspace: { teamId: 'team-9' } }));

    const where = (mockConnectorSharesFindMany.mock.calls[0]?.[0] as any)?.where;
    expect(where.args).toEqual(expect.arrayContaining([
      { field: 'sharedWithTeamId', value: 'team-9', type: 'eq' },
      { field: 'connectorId', values: ['conn-a', 'conn-b'], type: 'inArray' },
    ]));
  });

  // AC-3: deterministic slug precedence — the owned connector wins.
  it('mounts only the owned connector when an owned and a shared-in one collide on slug', async () => {
    mockWorkspaceSkillsFindMany.mockResolvedValue([role(['conn-own', 'conn-shared'])]);
    stageConnectors([
      connector({ id: 'conn-shared', teamId: OTHER_TEAM, name: 'github', url: 'https://shared.example.com' }),
      connector({ id: 'conn-own', teamId: TEAM, name: 'github', url: 'https://owned.example.com' }),
    ]);
    mockConnectorSharesFindMany.mockResolvedValue([{ connectorId: 'conn-shared' }]);
    mockConnectorWorkspacesFindMany.mockResolvedValue([]);

    expect(await resolve()).toEqual([
      { id: 'conn-own', name: 'github', transport: 'http', url: 'https://owned.example.com' },
    ]);
  });

  // …and precedence must not depend on which row the DB happened to return first.
  it('mounts the owned connector on slug collision regardless of row order', async () => {
    mockWorkspaceSkillsFindMany.mockResolvedValue([role(['conn-own', 'conn-shared'])]);
    stageConnectors([
      connector({ id: 'conn-own', teamId: TEAM, name: 'github', url: 'https://owned.example.com' }),
      connector({ id: 'conn-shared', teamId: OTHER_TEAM, name: 'github', url: 'https://shared.example.com' }),
    ]);
    mockConnectorSharesFindMany.mockResolvedValue([{ connectorId: 'conn-shared' }]);
    mockConnectorWorkspacesFindMany.mockResolvedValue([]);

    expect((await resolve()).map(c => c.id)).toEqual(['conn-own']);
  });

  it('mounts a shared-in connector when its slug does not collide', async () => {
    mockWorkspaceSkillsFindMany.mockResolvedValue([role(['conn-own', 'conn-shared'])]);
    stageConnectors([
      connector({ id: 'conn-shared', teamId: OTHER_TEAM, name: 'gitlab' }),
      connector({ id: 'conn-own', teamId: TEAM, name: 'github' }),
    ]);
    mockConnectorSharesFindMany.mockResolvedValue([{ connectorId: 'conn-shared' }]);
    mockConnectorWorkspacesFindMany.mockResolvedValue([]);

    // Owned first, then shared-in (the precedence ordering is observable here).
    expect((await resolve()).map(c => c.name)).toEqual(['github', 'gitlab']);
  });

  it('keys credential lookups on every distinct owner team when both are mounted', async () => {
    mockWorkspaceSkillsFindMany.mockResolvedValue([role(['conn-own', 'conn-shared'])]);
    stageConnectors([
      connector({ id: 'conn-own', teamId: TEAM, name: 'a', authMode: 'header', headerName: 'X-A' }),
      connector({ id: 'conn-shared', teamId: OTHER_TEAM, name: 'b', authMode: 'header', headerName: 'X-B' }),
    ]);
    mockConnectorSharesFindMany.mockResolvedValue([{ connectorId: 'conn-shared' }]);
    mockConnectorWorkspacesFindMany.mockResolvedValue([]);
    stageSecrets({ credentials: [] });

    await resolve();

    const credCall = mockSecretsFindMany.mock.calls.find(c => purposeOf(c[0]) === 'mcp_connector_credential');
    expect(teamIdsOf(credCall?.[0])?.sort()).toEqual([TEAM, OTHER_TEAM].sort());
  });
});

// --- §3: transports and auth modes ---------------------------------------

describe('resolveMcpConnectorsForTask — http transport', () => {
  it('injects an authMode=none connector with no headers', async () => {
    const [entry] = await resolve();
    expect(entry).toEqual({ id: 'conn-1', name: 'my-mcp', transport: 'http', url: 'https://mcp.example.com' });
    expect(entry.headers).toBeUndefined();
  });

  it('omits an http connector with no url', async () => {
    stageConnectors([connector({ url: null })]);
    expect(await resolve()).toEqual([]);
  });

  it('injects a header-auth connector with the decrypted value under headerName', async () => {
    stageConnectors([connector({ authMode: 'header', headerName: 'X-API-Key' })]);
    stageSecrets({ credentials: [{ id: 'cs-1', label: 'conn-1', tokenExpiresAt: null }] });

    expect(await resolve(task(), provider({ 'cs-1': 'secret-header-value' }))).toEqual([{
      id: 'conn-1', name: 'my-mcp', transport: 'http',
      url: 'https://mcp.example.com', headers: { 'X-API-Key': 'secret-header-value' },
    }]);
  });

  // AC-4: never mount unauthenticated in place of an authenticated connector.
  it('omits a header connector whose secret row is missing', async () => {
    stageConnectors([connector({ authMode: 'header', headerName: 'X-API-Key' })]);
    stageSecrets({ credentials: [] });

    expect(await resolve()).toEqual([]);
  });

  it('omits a header connector whose secret fails to decrypt', async () => {
    stageConnectors([connector({ authMode: 'header', headerName: 'X-API-Key' })]);
    stageSecrets({ credentials: [{ id: 'cs-1', label: 'conn-1', tokenExpiresAt: null }] });

    expect(await resolve(task(), provider({}))).toEqual([]);
  });

  // The credential secret is matched by label = connector id; another connector's
  // secret must never satisfy this one.
  it('does not use another connector\'s credential secret', async () => {
    stageConnectors([connector({ authMode: 'header', headerName: 'X-API-Key' })]);
    stageSecrets({ credentials: [{ id: 'cs-other', label: 'conn-other', tokenExpiresAt: null }] });

    expect(await resolve(task(), provider({ 'cs-other': 'other-secret' }))).toEqual([]);
  });
});

describe('resolveMcpConnectorsForTask — oauth', () => {
  const oauthConnector = () => connector({ id: 'conn-oauth', name: 'oauth-mcp', authMode: 'oauth' });

  it('injects a bearer token from the stored blob', async () => {
    mockWorkspaceSkillsFindMany.mockResolvedValue([role(['conn-oauth'])]);
    stageConnectors([oauthConnector()]);
    mockConnectorWorkspacesFindMany.mockResolvedValue([]);
    stageSecrets({ credentials: [{ id: 'cs-1', label: 'conn-oauth', tokenExpiresAt: null }] });

    const result = await resolve(task(), provider({ 'cs-1': JSON.stringify({ access_token: 'tok' }) }));

    expect(result).toEqual([{
      id: 'conn-oauth', name: 'oauth-mcp', transport: 'http',
      url: 'https://mcp.example.com', headers: { Authorization: 'Bearer tok' },
    }]);
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('does not refresh a token that is still valid', async () => {
    mockWorkspaceSkillsFindMany.mockResolvedValue([role(['conn-oauth'])]);
    stageConnectors([oauthConnector()]);
    mockConnectorWorkspacesFindMany.mockResolvedValue([]);
    stageSecrets({ credentials: [{ id: 'cs-1', label: 'conn-oauth', tokenExpiresAt: new Date(NOW.getTime() + 60_000) }] });

    await resolve(task(), provider({ 'cs-1': JSON.stringify({ access_token: 'tok' }) }));

    expect(mockRefresh).not.toHaveBeenCalled();
  });

  // Boundary: expiry is strictly before `now`. A token expiring exactly at `now`
  // is not yet treated as expired.
  it('does not refresh a token expiring exactly at now', async () => {
    mockWorkspaceSkillsFindMany.mockResolvedValue([role(['conn-oauth'])]);
    stageConnectors([oauthConnector()]);
    mockConnectorWorkspacesFindMany.mockResolvedValue([]);
    stageSecrets({ credentials: [{ id: 'cs-1', label: 'conn-oauth', tokenExpiresAt: new Date(NOW.getTime()) }] });

    await resolve(task(), provider({ 'cs-1': JSON.stringify({ access_token: 'tok' }) }));

    expect(mockRefresh).not.toHaveBeenCalled();
  });

  // AC-2: an expired token is refreshed at claim time and the fresh value ships.
  it('refreshes an expired token and injects the refreshed value', async () => {
    mockWorkspaceSkillsFindMany.mockResolvedValue([role(['conn-oauth'])]);
    stageConnectors([oauthConnector()]);
    mockConnectorWorkspacesFindMany.mockResolvedValue([]);
    stageSecrets({ credentials: [{ id: 'cs-1', label: 'conn-oauth', tokenExpiresAt: new Date(NOW.getTime() - 60_000) }] });
    mockRefresh.mockResolvedValue('refreshed');

    const result = await resolve(task(), provider({ 'cs-1': JSON.stringify({ access_token: 'fresh-token' }) }));

    expect(mockRefresh).toHaveBeenCalledWith('cs-1');
    expect(result[0].headers).toEqual({ Authorization: 'Bearer fresh-token' });
  });

  // 'locked' means another caller holds the refresh lock and has (or is about to
  // have) written a fresh token — proceed with what is stored.
  it('proceeds when the refresh lock is held by another caller', async () => {
    mockWorkspaceSkillsFindMany.mockResolvedValue([role(['conn-oauth'])]);
    stageConnectors([oauthConnector()]);
    mockConnectorWorkspacesFindMany.mockResolvedValue([]);
    stageSecrets({ credentials: [{ id: 'cs-1', label: 'conn-oauth', tokenExpiresAt: new Date(NOW.getTime() - 60_000) }] });
    mockRefresh.mockResolvedValue('locked');

    const result = await resolve(task(), provider({ 'cs-1': JSON.stringify({ access_token: 'tok' }) }));

    expect(result).toHaveLength(1);
  });

  // AC-3: unrecoverable refresh → omit rather than mount a dead token.
  for (const outcome of ['expired', 'no_credential', 'error', 'skipped'] as const) {
    it(`omits the connector when refresh returns "${outcome}"`, async () => {
      mockWorkspaceSkillsFindMany.mockResolvedValue([role(['conn-oauth'])]);
      stageConnectors([oauthConnector()]);
      mockConnectorWorkspacesFindMany.mockResolvedValue([]);
      stageSecrets({ credentials: [{ id: 'cs-1', label: 'conn-oauth', tokenExpiresAt: new Date(NOW.getTime() - 60_000) }] });
      mockRefresh.mockResolvedValue(outcome);

      expect(await resolve(task(), provider({ 'cs-1': JSON.stringify({ access_token: 'stale' }) }))).toEqual([]);
    });
  }

  it('omits the connector when the stored blob is not JSON', async () => {
    mockWorkspaceSkillsFindMany.mockResolvedValue([role(['conn-oauth'])]);
    stageConnectors([oauthConnector()]);
    mockConnectorWorkspacesFindMany.mockResolvedValue([]);
    stageSecrets({ credentials: [{ id: 'cs-1', label: 'conn-oauth', tokenExpiresAt: null }] });

    expect(await resolve(task(), provider({ 'cs-1': 'not-json' }))).toEqual([]);
  });

  it('omits the connector when the blob carries no access_token', async () => {
    mockWorkspaceSkillsFindMany.mockResolvedValue([role(['conn-oauth'])]);
    stageConnectors([oauthConnector()]);
    mockConnectorWorkspacesFindMany.mockResolvedValue([]);
    stageSecrets({ credentials: [{ id: 'cs-1', label: 'conn-oauth', tokenExpiresAt: null }] });

    expect(await resolve(task(), provider({ 'cs-1': JSON.stringify({ refresh_token: 'r' }) }))).toEqual([]);
  });

  it('omits the connector when its secret row is missing', async () => {
    mockWorkspaceSkillsFindMany.mockResolvedValue([role(['conn-oauth'])]);
    stageConnectors([oauthConnector()]);
    mockConnectorWorkspacesFindMany.mockResolvedValue([]);
    stageSecrets({ credentials: [] });

    expect(await resolve()).toEqual([]);
    expect(mockRefresh).not.toHaveBeenCalled();
  });
});

describe('resolveMcpConnectorsForTask — assertion mode', () => {
  const assertionConnector = (overrides: Record<string, any> = {}) => connector({
    id: 'conn-assert', name: 'cue', url: 'https://cue.buildd.dev/api/mcp', authMode: 'assertion',
    assertionAudience: 'https://cue.buildd.dev/api/mcp',
    assertionTokenEndpoint: 'https://cue.buildd.dev/api/oauth/token',
    ...overrides,
  });

  function stageAssertion(overrides: Record<string, any> = {}) {
    mockWorkspaceSkillsFindMany.mockResolvedValue([role(['conn-assert'])]);
    stageConnectors([assertionConnector(overrides)]);
    mockConnectorWorkspacesFindMany.mockResolvedValue([]);
  }

  it('returns exchange metadata and no bearer token', async () => {
    stageAssertion();

    const result = await resolve();

    expect(result).toEqual([{
      id: 'conn-assert',
      name: 'cue',
      transport: 'http',
      url: 'https://cue.buildd.dev/api/mcp',
      assertionMode: true,
      mintApiUrl: 'https://buildd.dev/api/connectors/conn-assert/assertion',
      audience: 'https://cue.buildd.dev/api/mcp',
      tokenEndpoint: 'https://cue.buildd.dev/api/oauth/token',
    }]);
    expect(result[0].headers).toBeUndefined();
  });

  // assertion is not header/oauth, so no credential lookup happens for it.
  it('needs no stored credential', async () => {
    stageAssertion();
    stageSecrets({ credentials: [] });

    expect(await resolve()).toHaveLength(1);
    const credCall = mockSecretsFindMany.mock.calls.find(c => purposeOf(c[0]) === 'mcp_connector_credential');
    expect(credCall).toBeUndefined();
  });

  it('omits the connector when assertionAudience is missing', async () => {
    stageAssertion({ assertionAudience: null });
    expect(await resolve()).toEqual([]);
  });

  it('omits the connector when assertionTokenEndpoint is missing', async () => {
    stageAssertion({ assertionTokenEndpoint: null });
    expect(await resolve()).toEqual([]);
  });
});

describe('resolveMcpConnectorsForTask — stdio transport', () => {
  const stdioConnector = (overrides: Record<string, any> = {}) => connector({
    id: 'conn-stdio', name: 'github', url: null, transport: 'stdio',
    command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'],
    envMapping: { GITHUB_TOKEN: 'GH_SECRET' },
    ...overrides,
  });

  function stageStdio(overrides: Record<string, any> = {}) {
    mockWorkspaceSkillsFindMany.mockResolvedValue([role(['conn-stdio'])]);
    stageConnectors([stdioConnector(overrides)]);
    mockConnectorWorkspacesFindMany.mockResolvedValue([]);
  }

  it('injects command, args and env resolved from envMapping', async () => {
    stageStdio();
    stageSecrets({ envSecrets: [{ id: 'es-1', label: 'GH_SECRET', teamId: TEAM }] });

    expect(await resolve(task(), provider({ 'es-1': 'ghp_decrypted' }))).toEqual([{
      name: 'github', transport: 'stdio', command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: { GITHUB_TOKEN: 'ghp_decrypted' },
    }]);
  });

  it('omits env entirely when the connector maps no secrets', async () => {
    stageStdio({ envMapping: {} });

    const [entry] = await resolve();

    expect(entry).toEqual({ name: 'github', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] });
    expect('env' in entry).toBe(false);
    // No env-secret query when nothing is mapped.
    expect(mockSecretsFindMany.mock.calls.find(c => purposeOf(c[0]) === 'mcp_credential')).toBeUndefined();
  });

  it('defaults args to [] when the row has none', async () => {
    stageStdio({ args: null, envMapping: {} });
    expect((await resolve())[0].args).toEqual([]);
  });

  it('omits a stdio connector with no command', async () => {
    stageStdio({ command: null, envMapping: {} });
    expect(await resolve()).toEqual([]);
  });

  // No half-formed mount: a missing mapped secret drops the whole connector
  // rather than spawning it with a partial env.
  it('omits a stdio connector when a mapped env secret row is missing', async () => {
    stageStdio();
    stageSecrets({ envSecrets: [] });

    expect(await resolve()).toEqual([]);
  });

  it('omits a stdio connector when only some mapped secrets resolve', async () => {
    stageStdio({ envMapping: { GITHUB_TOKEN: 'GH_SECRET', EXTRA_TOKEN: 'EXTRA_SECRET' } });
    stageSecrets({ envSecrets: [{ id: 'es-1', label: 'GH_SECRET', teamId: TEAM }] });

    expect(await resolve(task(), provider({ 'es-1': 'ghp_decrypted' }))).toEqual([]);
  });

  it('omits a stdio connector when a mapped secret fails to decrypt', async () => {
    stageStdio();
    stageSecrets({ envSecrets: [{ id: 'es-1', label: 'GH_SECRET', teamId: TEAM }] });

    expect(await resolve(task(), provider({}))).toEqual([]);
  });

  it('resolves every mapped env var', async () => {
    stageStdio({ envMapping: { A_TOKEN: 'LABEL_A', B_TOKEN: 'LABEL_B' } });
    stageSecrets({ envSecrets: [
      { id: 'es-a', label: 'LABEL_A', teamId: TEAM },
      { id: 'es-b', label: 'LABEL_B', teamId: TEAM },
    ] });

    expect((await resolve(task(), provider({ 'es-a': 'va', 'es-b': 'vb' })))[0].env)
      .toEqual({ A_TOKEN: 'va', B_TOKEN: 'vb' });
  });

  // The env-secret map is keyed by owner team AND label. One team's secret must
  // never be handed to another team's connector.
  it('gives each connector its own owner team\'s value when labels collide across teams', async () => {
    mockWorkspaceSkillsFindMany.mockResolvedValue([role(['conn-own-stdio', 'conn-shared-stdio'])]);
    stageConnectors([
      stdioConnector({ id: 'conn-own-stdio', teamId: TEAM, name: 'local-tool', args: ['local-tool'], envMapping: { API_TOKEN: 'SHARED_LABEL' } }),
      stdioConnector({ id: 'conn-shared-stdio', teamId: OTHER_TEAM, name: 'remote-tool', args: ['remote-tool'], envMapping: { API_TOKEN: 'SHARED_LABEL' } }),
    ]);
    mockConnectorSharesFindMany.mockResolvedValue([{ connectorId: 'conn-shared-stdio' }]);
    mockConnectorWorkspacesFindMany.mockResolvedValue([]);
    stageSecrets({ envSecrets: [
      { id: 'es-own', label: 'SHARED_LABEL', teamId: TEAM },
      { id: 'es-owner', label: 'SHARED_LABEL', teamId: OTHER_TEAM },
    ] });

    const result = await resolve(task(), provider({ 'es-own': 'own-team-value', 'es-owner': 'owner-team-value' }));

    expect(result.find(c => c.name === 'local-tool')?.env).toEqual({ API_TOKEN: 'own-team-value' });
    expect(result.find(c => c.name === 'remote-tool')?.env).toEqual({ API_TOKEN: 'owner-team-value' });
  });

  // The security case: the label exists, but only under a DIFFERENT team. The
  // connector must be omitted, not mounted with the foreign team's secret.
  it('omits a connector whose mapped label only exists under another team', async () => {
    mockWorkspaceSkillsFindMany.mockResolvedValue([role(['conn-shared-stdio'])]);
    stageConnectors([
      stdioConnector({ id: 'conn-shared-stdio', teamId: OTHER_TEAM, name: 'remote-tool', envMapping: { API_TOKEN: 'SHARED_LABEL' } }),
    ]);
    mockConnectorSharesFindMany.mockResolvedValue([{ connectorId: 'conn-shared-stdio' }]);
    mockConnectorWorkspacesFindMany.mockResolvedValue([]);
    // The only row with this label belongs to the task's own team, not the owner.
    stageSecrets({ envSecrets: [{ id: 'es-own', label: 'SHARED_LABEL', teamId: TEAM }] });

    const result = await resolve(task(), provider({ 'es-own': 'own-team-value' }));

    expect(result).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('own-team-value');
  });

  it('queries env secrets for the owner teams and the mapped labels only', async () => {
    stageStdio({ teamId: OTHER_TEAM, envMapping: { A: 'LABEL_A' } });
    mockConnectorSharesFindMany.mockResolvedValue([{ connectorId: 'conn-stdio' }]);
    stageSecrets({ envSecrets: [] });

    await resolve();

    const envCall = mockSecretsFindMany.mock.calls.find(c => purposeOf(c[0]) === 'mcp_credential')?.[0] as any;
    expect(teamIdsOf(envCall)).toEqual([OTHER_TEAM]);
    expect(envCall.where.args).toEqual(expect.arrayContaining([
      { field: 'label', values: ['LABEL_A'], type: 'inArray' },
    ]));
  });
});

// --- slugification --------------------------------------------------------

describe('slugifyConnectorName', () => {
  it('lowercases and hyphenates', () => {
    expect(slugifyConnectorName('My MCP Server')).toBe('my-mcp-server');
  });

  it('collapses runs of non-alphanumerics into a single hyphen', () => {
    expect(slugifyConnectorName('a__b..c')).toBe('a-b-c');
  });

  it('trims leading and trailing hyphens', () => {
    expect(slugifyConnectorName('--github--')).toBe('github');
  });

  it('leaves an already-slug name untouched', () => {
    expect(slugifyConnectorName('github')).toBe('github');
  });

  // A name of only separators slugifies to '' — the fallback keeps the key
  // non-empty so it can never silently collide with another empty key.
  it('falls back to the lowercased name when slugification empties it', () => {
    expect(slugifyConnectorName('___')).toBe('___');
  });
});

// --- attachMcpConnectors --------------------------------------------------

describe('attachMcpConnectors', () => {
  const worker = (id: string, t: any) => ({ id, task: t } as any);

  it('attaches resolved connectors to each worker', async () => {
    const workers = [worker('w1', task({ id: 't1' })), worker('w2', task({ id: 't2' }))];

    await attachMcpConnectors(workers, NOW, provider());

    expect(workers[0].mcpConnectors).toEqual([
      { id: 'conn-1', name: 'my-mcp', transport: 'http', url: 'https://mcp.example.com' },
    ]);
    expect(workers[1].mcpConnectors).toBeDefined();
  });

  // Absent, not empty: the runner treats a missing key as "no MCP".
  it('leaves mcpConnectors undefined when nothing resolves', async () => {
    mockWorkspaceSkillsFindMany.mockResolvedValue([]);
    const workers = [worker('w1', task())];

    await attachMcpConnectors(workers, NOW, provider());

    expect(workers[0].mcpConnectors).toBeUndefined();
    expect('mcpConnectors' in workers[0]).toBe(false);
  });

  it('never throws — a failure must not fail the claim', async () => {
    mockWorkspaceSkillsFindMany.mockRejectedValue(new Error('db down'));
    const workers = [worker('w1', task())];

    await attachMcpConnectors(workers, NOW, provider());

    expect(workers[0].mcpConnectors).toBeUndefined();
  });

  /**
   * DELIBERATE: the try/catch wraps the WHOLE loop, not each worker. A throw on
   * worker 2 abandons injection for workers 3+ as well — this preserves the
   * pre-extraction behaviour of the claim route. If this ever becomes per-worker
   * (arguably better), this test is the one to update on purpose.
   */
  it('abandons injection for the remaining workers after one throws', async () => {
    mockWorkspaceSkillsFindMany.mockImplementation(async (args: any) => {
      const slug = (args?.where?.args ?? []).find((a: any) => a?.type === 'eq' && a.field === 'slug')?.value;
      if (slug === 'boom') throw new Error('role lookup exploded');
      return [role(['conn-1'])];
    });
    const workers = [
      worker('w1', task({ id: 't1' })),
      worker('w2', task({ id: 't2', roleSlug: 'boom' })),
      worker('w3', task({ id: 't3' })),
    ];

    await attachMcpConnectors(workers, NOW, provider());

    expect(workers[0].mcpConnectors).toHaveLength(1); // ran before the throw
    expect(workers[1].mcpConnectors).toBeUndefined(); // threw
    expect(workers[2].mcpConnectors).toBeUndefined(); // never attempted
    expect(mockWorkspaceSkillsFindMany).toHaveBeenCalledTimes(2);
  });

  it('handles an empty worker list', async () => {
    await attachMcpConnectors([], NOW, provider());
    expect(mockWorkspaceSkillsFindMany).not.toHaveBeenCalled();
  });

  it('passes the caller\'s `now` through to expiry evaluation', async () => {
    mockWorkspaceSkillsFindMany.mockResolvedValue([role(['conn-oauth'])]);
    stageConnectors([connector({ id: 'conn-oauth', authMode: 'oauth' })]);
    mockConnectorWorkspacesFindMany.mockResolvedValue([]);
    stageSecrets({ credentials: [{ id: 'cs-1', label: 'conn-oauth', tokenExpiresAt: new Date('2026-09-04T11:00:00.000Z') }] });
    const workers = [worker('w1', task())];

    // `now` is BEFORE the expiry → no refresh.
    await attachMcpConnectors(workers, new Date('2026-09-04T10:00:00.000Z'), provider({ 'cs-1': JSON.stringify({ access_token: 'tok' }) }));
    expect(mockRefresh).not.toHaveBeenCalled();

    // `now` is AFTER the expiry → refresh.
    await attachMcpConnectors(workers, new Date('2026-09-04T12:00:00.000Z'), provider({ 'cs-1': JSON.stringify({ access_token: 'tok' }) }));
    expect(mockRefresh).toHaveBeenCalledWith('cs-1');
  });
});
