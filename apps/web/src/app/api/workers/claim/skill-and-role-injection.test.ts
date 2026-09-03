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
const mockGenerateDownloadUrl = mock(async (key: string) => `https://r2.test/${key}`);
const mockIsStorageConfigured = mock(() => true);

/** db.select().from().where().orderBy().limit() → mockSelectRows() */
function selectChain() {
  const chain: any = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () => mockSelectRows(),
  };
  return chain;
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
