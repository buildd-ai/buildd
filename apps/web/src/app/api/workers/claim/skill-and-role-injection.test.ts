import { describe, it, expect, mock, beforeEach } from 'bun:test';

/**
 * Coverage note — why this file exists.
 *
 * `route.test.ts` never mentions skillBundles, roleConfig or cbmDisabled: the
 * server-side resolution had no test anywhere in the repo (the runner tests
 * consume the wire fields but never exercise the claim-side lookup). Two
 * mutations proved it — inverting the account-level fallback filter, and
 * swapping the builder/service discriminator — both left the whole claim suite
 * green. Extracting these blocks made them testable directly.
 */

const mockSkillsFindMany = mock(async (_args?: any) => [] as any[]);
const mockSkillsFindFirst = mock(async (_args?: any) => null as any);
const mockSelectRows = mock(async () => [] as any[]);
const mockSelectWhere = mock((_where: any) => {});
const mockSelectOrderBy = mock((_orderBy: any) => {});
const mockGenerateDownloadUrl = mock(async (key: string) => `https://r2.test/${key}`);
const mockIsStorageConfigured = mock(() => true);

// Predicate stubs: `db` is mocked, so the scoping of each skill/role lookup
// (workspace, account, team, enabled) exists ONLY in the WHERE clause, and role
// precedence exists only in the ORDER BY. Plain objects make both assertable.
mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  and: (...args: any[]) => ({ args, type: 'and' }),
  or: (...args: any[]) => ({ args, type: 'or' }),
  isNull: (field: any) => ({ field, type: 'isNull' }),
  inArray: (field: any, values: any[]) => ({ field, values, type: 'inArray' }),
  sql: (strings: TemplateStringsArray, ...values: any[]) => ({ strings: [...strings], values, type: 'sql' }),
}));
mock.module('@buildd/core/db/schema', () => ({
  workspaceSkills: {
    slug: 'slug', name: 'name', enabled: 'enabled', isRole: 'isRole',
    workspaceId: 'workspaceId', accountId: 'accountId', teamId: 'teamId',
  },
}));

/** db.select().from().where().orderBy().limit() → mockSelectRows() */
function selectChain() {
  const chain: any = {
    from: () => chain,
    where: (w: any) => { mockSelectWhere(w); return chain; },
    orderBy: (o: any) => { mockSelectOrderBy(o); return chain; },
    limit: () => mockSelectRows(),
  };
  return chain;
}

/** Reads one predicate out of the stubbed WHERE tree by node type + field. */
function predicate(where: any, type: string, field: string) {
  return (where?.args ?? []).find((n: any) => n?.type === type && n.field === field);
}

/** Reads a top-level OR node by the field its branches are about. */
function orBranches(where: any, field: string) {
  return (where?.args ?? [])
    .find((n: any) => n?.type === 'or' && n.args?.some((b: any) => b.field === field))?.args;
}

mock.module('@buildd/core/db', () => ({
  db: {
    select: () => selectChain(),
    query: {
      workspaceSkills: { findMany: mockSkillsFindMany, findFirst: mockSkillsFindFirst },
    },
  },
}));
mock.module('@/lib/storage', () => ({
  isStorageConfigured: mockIsStorageConfigured,
  generateDownloadUrl: mockGenerateDownloadUrl,
}));

const { attachSkillBundles, attachRoleConfig } = await import('./skill-and-role-injection');

/** A claimed worker carrying the task context the skill lookup reads. */
function worker(taskId: string, context?: Record<string, unknown>) {
  return { id: `w-${taskId}`, taskId, task: { id: taskId, context } } as any;
}

function task(id: string, extra: Record<string, unknown> = {}) {
  return { id, workspaceId: `ws-${id}`, ...extra } as any;
}

/** A workspace_skills row with the columns these blocks read. */
function skillRow(slug: string, extra: Record<string, unknown> = {}) {
  return {
    slug,
    name: `Skill ${slug}`,
    description: null,
    content: `# ${slug}`,
    metadata: null,
    model: null,
    allowedTools: null,
    canDelegateTo: null,
    background: null,
    maxTurns: null,
    mcpServers: null,
    requiredEnvVars: null,
    ...extra,
  } as any;
}

beforeEach(() => {
  mockSkillsFindMany.mockReset();
  mockSkillsFindMany.mockResolvedValue([]);
  mockSkillsFindFirst.mockReset();
  mockSkillsFindFirst.mockResolvedValue(null);
  mockSelectRows.mockReset();
  mockSelectRows.mockResolvedValue([]);
  mockSelectWhere.mockReset();
  mockSelectOrderBy.mockReset();
  mockGenerateDownloadUrl.mockReset();
  mockGenerateDownloadUrl.mockImplementation(async (key: string) => `https://r2.test/${key}`);
  mockIsStorageConfigured.mockReset();
  mockIsStorageConfigured.mockReturnValue(true);
});

describe('attachSkillBundles', () => {
  it('attaches workspace-level bundles for the requested slugs', async () => {
    mockSkillsFindMany.mockResolvedValue([skillRow('reviewer')]);
    const workers = [worker('t1', { skillSlugs: ['reviewer'] })];

    await attachSkillBundles(workers, [task('t1')], 'acct-1');

    expect(workers[0].skillBundles).toHaveLength(1);
    expect(workers[0].skillBundles[0]).toMatchObject({
      slug: 'reviewer',
      name: 'Skill reviewer',
      content: '# reviewer',
      model: 'inherit',
      allowedTools: [],
      canDelegateTo: [],
      background: false,
      maxTurns: null,
      mcpServers: [],
      requiredEnvVars: {},
    });
  });

  it('carries referenceFiles through from metadata, and omits the key when absent', async () => {
    mockSkillsFindMany.mockResolvedValue([
      skillRow('with-refs', { metadata: { referenceFiles: { 'a.md': 'body' } } }),
      skillRow('no-refs'),
    ]);
    const workers = [worker('t1', { skillSlugs: ['with-refs', 'no-refs'] })];

    await attachSkillBundles(workers, [task('t1')], 'acct-1');

    expect(workers[0].skillBundles[0].referenceFiles).toEqual({ 'a.md': 'body' });
    expect('referenceFiles' in workers[0].skillBundles[1]).toBe(false);
  });

  // The mutation that route.test.ts missed: inverting this filter queries for
  // the slugs already found and silently drops the ones actually missing.
  it('falls back to account-level skills only for slugs missing at workspace level', async () => {
    mockSkillsFindMany.mockImplementation(async (args: any) => {
      // First call = workspace scope, second = account scope.
      return mockSkillsFindMany.mock.calls.length === 1
        ? [skillRow('at-workspace')]
        : [skillRow('at-account')];
    });
    const workers = [worker('t1', { skillSlugs: ['at-workspace', 'at-account'] })];

    await attachSkillBundles(workers, [task('t1')], 'acct-1');

    expect(workers[0].skillBundles.map((b: any) => b.slug)).toEqual(['at-workspace', 'at-account']);
    expect(mockSkillsFindMany).toHaveBeenCalledTimes(2);
  });

  it('does not hit the account fallback when the workspace covers every slug', async () => {
    mockSkillsFindMany.mockResolvedValue([skillRow('reviewer')]);
    const workers = [worker('t1', { skillSlugs: ['reviewer'] })];

    await attachSkillBundles(workers, [task('t1')], 'acct-1');

    expect(mockSkillsFindMany).toHaveBeenCalledTimes(1);
  });

  it('attaches nothing when the task requested no skills', async () => {
    const workers = [worker('t1', {})];

    await attachSkillBundles(workers, [task('t1')], 'acct-1');

    expect(workers[0].skillBundles).toBeUndefined();
    expect(mockSkillsFindMany).not.toHaveBeenCalled();
  });

  it('attaches nothing when no row matches the requested slugs', async () => {
    mockSkillsFindMany.mockResolvedValue([]);
    const workers = [worker('t1', { skillSlugs: ['missing'] })];

    await attachSkillBundles(workers, [task('t1')], 'acct-1');

    expect(workers[0].skillBundles).toBeUndefined();
  });

  it('skips a worker whose task is not among the claimed candidates', async () => {
    const workers = [worker('t1', { skillSlugs: ['reviewer'] })];

    await attachSkillBundles(workers, [task('other')], 'acct-1');

    expect(workers[0].skillBundles).toBeUndefined();
    expect(mockSkillsFindMany).not.toHaveBeenCalled();
  });

  // "Disabled rows are never returned" and "workspace-level rows" are properties
  // of the WHERE clause alone — with `db` mocked, deleting either filter is
  // invisible to every other test in this file.
  it('scopes the workspace lookup to the task workspace, the requested slugs and enabled rows', async () => {
    const workers = [worker('t1', { skillSlugs: ['reviewer', 'writer'] })];

    await attachSkillBundles(workers, [task('t1')], 'acct-1');

    const where = (mockSkillsFindMany.mock.calls[0]?.[0] as any)?.where;
    expect(predicate(where, 'eq', 'workspaceId')).toEqual({ field: 'workspaceId', value: 'ws-t1', type: 'eq' });
    expect(predicate(where, 'inArray', 'slug').values).toEqual(['reviewer', 'writer']);
    expect(predicate(where, 'eq', 'enabled')).toEqual({ field: 'enabled', value: true, type: 'eq' });
  });

  // Same for the fallback: without the account filter this returns any account's
  // skills for a matching slug.
  it('scopes the account fallback to the claiming account, the missing slugs and enabled rows', async () => {
    mockSkillsFindMany.mockImplementation(async () =>
      mockSkillsFindMany.mock.calls.length === 1 ? [skillRow('at-workspace')] : []);
    const workers = [worker('t1', { skillSlugs: ['at-workspace', 'at-account'] })];

    await attachSkillBundles(workers, [task('t1')], 'acct-7');

    const where = (mockSkillsFindMany.mock.calls[1]?.[0] as any)?.where;
    expect(predicate(where, 'eq', 'accountId')).toEqual({ field: 'accountId', value: 'acct-7', type: 'eq' });
    expect(predicate(where, 'inArray', 'slug').values).toEqual(['at-account']);
    expect(predicate(where, 'eq', 'enabled')).toEqual({ field: 'enabled', value: true, type: 'eq' });
  });
});

describe('attachRoleConfig', () => {
  const roleRow = (extra: Record<string, unknown> = {}) => ({
    slug: 'builder',
    configStorageKey: 'roles/builder.tar.gz',
    configHash: 'hash-1',
    repoUrl: null,
    model: 'sonnet',
    allowedTools: null,
    canDelegateTo: null,
    background: null,
    maxTurns: null,
    mcpServers: null,
    ...extra,
  }) as any;

  it('attaches the role config with a presigned config URL', async () => {
    mockSelectRows.mockResolvedValue([roleRow()]);
    const workers = [worker('t1')];

    await attachRoleConfig(workers, [task('t1', { roleSlug: 'builder', workspace: { teamId: 'team-1' } })], 'acct-1');

    expect(workers[0].roleConfig).toEqual({
      slug: 'builder',
      configHash: 'hash-1',
      configUrl: 'https://r2.test/roles/builder.tar.gz',
      type: 'service',
      repoUrl: undefined,
      model: 'sonnet',
      allowedTools: [],
      canDelegateTo: [],
      background: false,
      maxTurns: null,
    });
  });

  // The other mutation route.test.ts missed. repoUrl present = the role checks
  // out a repo = 'builder'; absent = 'service'.
  it('types a role with a repoUrl as builder', async () => {
    mockSelectRows.mockResolvedValue([roleRow({ repoUrl: 'https://github.com/acme/repo' })]);
    const workers = [worker('t1')];

    await attachRoleConfig(workers, [task('t1', { roleSlug: 'builder', workspace: { teamId: 'team-1' } })], 'acct-1');

    expect(workers[0].roleConfig.type).toBe('builder');
    expect(workers[0].roleConfig.repoUrl).toBe('https://github.com/acme/repo');
  });

  it('falls back to the legacy account-level role when no team row matches', async () => {
    mockSelectRows.mockResolvedValue([]);
    mockSkillsFindFirst.mockResolvedValue(roleRow({ slug: 'legacy' }));
    const workers = [worker('t1')];

    await attachRoleConfig(workers, [task('t1', { roleSlug: 'legacy', workspace: { teamId: 'team-1' } })], 'acct-1');

    expect(workers[0].roleConfig.slug).toBe('legacy');
  });

  it('uses the account fallback for a task whose workspace has no team', async () => {
    mockSkillsFindFirst.mockResolvedValue(roleRow());
    const workers = [worker('t1')];

    await attachRoleConfig(workers, [task('t1', { roleSlug: 'builder' })], 'acct-1');

    expect(mockSelectRows).not.toHaveBeenCalled();
    expect(workers[0].roleConfig).toBeDefined();
  });

  // §C.2 precedence is expressed as `(workspaceId IS NOT NULL) DESC LIMIT 1`, so
  // it lives entirely in the ORDER BY: flipping DESC→ASC hands every task the
  // team default and silently discards workspace overrides.
  it('orders workspace overrides ahead of the team default', async () => {
    mockSelectRows.mockResolvedValue([roleRow()]);

    await attachRoleConfig([worker('t1')], [task('t1', { roleSlug: 'builder', workspace: { teamId: 'team-1' } })], 'acct-1');

    const orderBy = mockSelectOrderBy.mock.calls[0]?.[0] as any;
    expect(orderBy.strings.join('')).toContain('IS NOT NULL) DESC');
  });

  it('scopes the role lookup to the task team, slug, enabled roles and the task workspace', async () => {
    mockSelectRows.mockResolvedValue([roleRow()]);

    await attachRoleConfig([worker('t1')], [task('t1', { roleSlug: 'builder', workspace: { teamId: 'team-9' } })], 'acct-1');

    const where = mockSelectWhere.mock.calls[0]?.[0] as any;
    expect(predicate(where, 'eq', 'teamId')).toEqual({ field: 'teamId', value: 'team-9', type: 'eq' });
    expect(predicate(where, 'eq', 'slug')).toEqual({ field: 'slug', value: 'builder', type: 'eq' });
    expect(predicate(where, 'eq', 'enabled')).toEqual({ field: 'enabled', value: true, type: 'eq' });
    expect(predicate(where, 'eq', 'isRole')).toEqual({ field: 'isRole', value: true, type: 'eq' });
    expect(orBranches(where, 'workspaceId')).toEqual([
      { field: 'workspaceId', type: 'isNull' },
      { field: 'workspaceId', value: 'ws-t1', type: 'eq' },
    ]);
  });

  it('scopes the legacy fallback to the claiming account and enabled roles', async () => {
    mockSelectRows.mockResolvedValue([]);
    mockSkillsFindFirst.mockResolvedValue(roleRow());

    await attachRoleConfig([worker('t1')], [task('t1', { roleSlug: 'builder', workspace: { teamId: 'team-1' } })], 'acct-7');

    const where = (mockSkillsFindFirst.mock.calls[0]?.[0] as any)?.where;
    expect(predicate(where, 'eq', 'accountId')).toEqual({ field: 'accountId', value: 'acct-7', type: 'eq' });
    expect(predicate(where, 'eq', 'enabled')).toEqual({ field: 'enabled', value: true, type: 'eq' });
    expect(predicate(where, 'eq', 'isRole')).toEqual({ field: 'isRole', value: true, type: 'eq' });
  });

  // Both halves are required: a key with no hash means the runner cannot verify
  // what it downloaded, and a hash with no key has nothing to download. `&&`
  // → `||` here would ship a roleConfig with `configHash: null`.
  it('needs BOTH a config key and a hash — either alone attaches nothing', async () => {
    mockSelectRows.mockResolvedValue([roleRow({ configHash: null })]);
    const keyOnly = [worker('t1')];

    await attachRoleConfig(keyOnly, [task('t1', { roleSlug: 'builder', workspace: { teamId: 'team-1' } })], 'acct-1');

    expect(keyOnly[0].roleConfig).toBeUndefined();

    mockSelectRows.mockResolvedValue([roleRow({ configStorageKey: null })]);
    const hashOnly = [worker('t2')];

    await attachRoleConfig(hashOnly, [task('t2', { roleSlug: 'builder', workspace: { teamId: 'team-1' } })], 'acct-1');

    expect(hashOnly[0].roleConfig).toBeUndefined();
    expect(mockGenerateDownloadUrl).not.toHaveBeenCalled();
  });

  it('attaches no roleConfig when the role has no packaged config', async () => {
    mockSelectRows.mockResolvedValue([roleRow({ configStorageKey: null, configHash: null })]);
    const workers = [worker('t1')];

    await attachRoleConfig(workers, [task('t1', { roleSlug: 'builder', workspace: { teamId: 'team-1' } })], 'acct-1');

    expect(workers[0].roleConfig).toBeUndefined();
    expect(mockGenerateDownloadUrl).not.toHaveBeenCalled();
  });

  // The CBM opt-out is deliberately checked outside the configStorageKey branch
  // so a role can disable codebase-memory without being packaged to R2.
  it('sets cbmDisabled from the role record even with no packaged config', async () => {
    mockSelectRows.mockResolvedValue([
      roleRow({ configStorageKey: null, configHash: null, mcpServers: { 'codebase-memory': false } }),
    ]);
    const workers = [worker('t1')];

    await attachRoleConfig(workers, [task('t1', { roleSlug: 'builder', workspace: { teamId: 'team-1' } })], 'acct-1');

    expect(workers[0].roleConfig).toBeUndefined();
    expect(workers[0].cbmDisabled).toBe(true);
  });

  it('leaves cbmDisabled unset when codebase-memory is not opted out', async () => {
    mockSelectRows.mockResolvedValue([roleRow({ mcpServers: { 'codebase-memory': true } })]);
    const workers = [worker('t1')];

    await attachRoleConfig(workers, [task('t1', { roleSlug: 'builder', workspace: { teamId: 'team-1' } })], 'acct-1');

    expect(workers[0].cbmDisabled).toBeUndefined();
  });

  // The opt-out is an explicit `=== false`, not "anything but true": CBM stays
  // ON by default. A role with no mcpServers, an empty map, or no role row at
  // all must not disable it — otherwise the default silently inverts.
  it('leaves cbmDisabled unset by default (no mcpServers, empty map, or no role)', async () => {
    for (const mcpServers of [null, undefined, {}, { other: false }]) {
      mockSelectRows.mockResolvedValue([roleRow({ mcpServers })]);
      const workers = [worker('t1')];

      await attachRoleConfig(workers, [task('t1', { roleSlug: 'builder', workspace: { teamId: 'team-1' } })], 'acct-1');

      expect(workers[0].cbmDisabled).toBeUndefined();
    }

    mockSelectRows.mockResolvedValue([]);
    mockSkillsFindFirst.mockResolvedValue(null);
    const noRole = [worker('t9')];

    await attachRoleConfig(noRole, [task('t9', { roleSlug: 'ghost', workspace: { teamId: 'team-1' } })], 'acct-1');

    expect(noRole[0].cbmDisabled).toBeUndefined();
  });

  it('skips a task with no roleSlug', async () => {
    const workers = [worker('t1')];

    await attachRoleConfig(workers, [task('t1')], 'acct-1');

    expect(workers[0].roleConfig).toBeUndefined();
    expect(mockSelectRows).not.toHaveBeenCalled();
  });

  it('is a no-op when object storage is not configured', async () => {
    mockIsStorageConfigured.mockReturnValue(false);
    const workers = [worker('t1')];

    await attachRoleConfig(workers, [task('t1', { roleSlug: 'builder', workspace: { teamId: 'team-1' } })], 'acct-1');

    expect(workers[0].roleConfig).toBeUndefined();
    expect(mockSelectRows).not.toHaveBeenCalled();
  });
});
