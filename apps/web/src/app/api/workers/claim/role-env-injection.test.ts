import { describe, it, expect, mock, beforeEach, afterAll } from 'bun:test';

/**
 * `attachRoleEnvSecrets` is the claim-time channel that resolves a role's (or
 * workspace's) declared ENV_NAME -> secret label mapping against the `secrets`
 * table (purpose='role_env_secret') and delivers the values inline so the
 * runner can merge them into the role env `resolveWorkerRoleEnv` assembles.
 *
 * It reuses `resolveRoleRow` (skill-and-role-injection.ts) for the role
 * lookup, so `db.select()` (the §C.2 precedence query) and
 * `db.query.workspaceSkills.findFirst` (legacy account fallback) both need to
 * be mocked here too, alongside `db.query.secrets.findMany` for the label
 * resolution itself.
 */

const mockSelectRows = mock(async () => [] as any[]);
const mockSkillsFindFirst = mock(async (_args?: any) => null as any);
const mockSecretsFindMany = mock(async (_args?: any) => [] as any[]);
const mockProviderGet = mock(async (_id: string) => null as string | null);

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
    requiredEnvVars: 'requiredEnvVars',
  },
  secrets: {
    id: 'id', teamId: 'teamId', purpose: 'purpose', label: 'label',
    accountId: 'accountId', workspaceId: 'workspaceId', updatedAt: 'updatedAt',
  },
}));

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
      workspaceSkills: { findFirst: mockSkillsFindFirst },
      secrets: { findMany: mockSecretsFindMany },
    },
  },
}));
mock.module('@buildd/core/secrets', () => ({
  getSecretsProvider: () => ({ get: mockProviderGet }),
}));
mock.module('@/lib/storage', () => ({
  isStorageConfigured: () => true,
  generateDownloadUrl: async (key: string) => `https://r2.test/${key}`,
}));

const { attachRoleEnvSecrets } = await import('./role-env-injection');

const ORIGINAL_KEY = process.env.ENCRYPTION_KEY;

/** A claimed worker as the claim route builds it, before enrichment. */
function worker(taskId: string) {
  return { id: `w-${taskId}`, taskId } as any;
}

/** A claim-candidate task row: roleSlug drives the role lookup, gitConfig.envMapping the workspace default. */
function task(id: string, opts: {
  roleSlug?: string | null;
  teamId?: string | null;
  envMapping?: Record<string, string>;
} = {}) {
  const { roleSlug = null, teamId = 'team-1', envMapping } = opts;
  return {
    id,
    workspaceId: `ws-${id}`,
    roleSlug,
    workspace: teamId ? { teamId, gitConfig: envMapping ? { envMapping } : undefined } : undefined,
  } as any;
}

/** A workspace_skills role row carrying `requiredEnvVars`. */
function roleRow(requiredEnvVars: Record<string, string> = {}, extra: Record<string, unknown> = {}) {
  return { slug: 'builder', requiredEnvVars, ...extra } as any;
}

/** A `secrets` row as `db.query.secrets.findMany` would return it (never the decrypted value). */
function secretRow(label: string, opts: { accountId?: string | null; workspaceId?: string | null; updatedAt?: Date } = {}) {
  return {
    id: `secret-${label}-${opts.workspaceId ?? opts.accountId ?? 'team'}`,
    label,
    accountId: opts.accountId ?? null,
    workspaceId: opts.workspaceId ?? null,
    updatedAt: opts.updatedAt ?? new Date('2026-01-01'),
  };
}

beforeEach(() => {
  process.env.ENCRYPTION_KEY = 'test-key';
  mockSelectRows.mockReset();
  mockSelectRows.mockResolvedValue([]);
  mockSkillsFindFirst.mockReset();
  mockSkillsFindFirst.mockResolvedValue(null);
  mockSecretsFindMany.mockReset();
  mockSecretsFindMany.mockResolvedValue([]);
  mockProviderGet.mockReset();
  mockProviderGet.mockResolvedValue(null);
});

afterAll(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = ORIGINAL_KEY;
});

describe('attachRoleEnvSecrets', () => {
  it('resolves a role-declared env var against the secrets table and attaches it', async () => {
    mockSelectRows.mockResolvedValue([roleRow({ NODE_AUTH_TOKEN: 'REGISTRY_TOKEN_LABEL' })]);
    mockSecretsFindMany.mockResolvedValue([secretRow('REGISTRY_TOKEN_LABEL')]);
    mockProviderGet.mockResolvedValue('super-secret-value');

    const workers = [worker('t1')];
    await attachRoleEnvSecrets(workers, [task('t1', { roleSlug: 'builder' })], 'acct-1');

    expect(workers[0].roleEnvSecrets).toEqual({ NODE_AUTH_TOKEN: 'super-secret-value' });
    expect(workers[0].roleEnvMissing).toBeUndefined();
  });

  it('merges the workspace-wide default under the role mapping, role wins on a shared key', async () => {
    mockSelectRows.mockResolvedValue([roleRow({ NODE_AUTH_TOKEN: 'ROLE_LABEL' })]);
    mockSecretsFindMany.mockResolvedValue([secretRow('ROLE_LABEL'), secretRow('WORKSPACE_LABEL')]);
    mockProviderGet.mockImplementation(async (id: string) =>
      id.startsWith('secret-ROLE_LABEL') ? 'role-value' : 'workspace-value');

    const workers = [worker('t1')];
    await attachRoleEnvSecrets(workers, [task('t1', {
      roleSlug: 'builder',
      envMapping: { NODE_AUTH_TOKEN: 'WORKSPACE_LABEL', OTHER_TOKEN: 'WORKSPACE_LABEL' },
    })], 'acct-1');

    // NODE_AUTH_TOKEN: role's own mapping (ROLE_LABEL) overrides the workspace default.
    // OTHER_TOKEN: only declared at the workspace level, still resolved.
    expect(workers[0].roleEnvSecrets).toEqual({ NODE_AUTH_TOKEN: 'role-value', OTHER_TOKEN: 'workspace-value' });
  });

  it('reports a declared label with no matching secret in roleEnvMissing, not silently', async () => {
    mockSelectRows.mockResolvedValue([roleRow({ NODE_AUTH_TOKEN: 'GONE_LABEL' })]);
    mockSecretsFindMany.mockResolvedValue([]);

    const workers = [worker('t1')];
    await attachRoleEnvSecrets(workers, [task('t1', { roleSlug: 'builder' })], 'acct-1');

    expect(workers[0].roleEnvSecrets).toBeUndefined();
    expect(workers[0].roleEnvMissing).toEqual(['NODE_AUTH_TOKEN']);
  });

  it('picks the most specific secret per label: workspace-scoped over account-scoped over team-wide', async () => {
    mockSelectRows.mockResolvedValue([roleRow({ TOKEN: 'LABEL' })]);
    mockSecretsFindMany.mockResolvedValue([
      secretRow('LABEL', { updatedAt: new Date('2026-01-01') }), // team-wide
      secretRow('LABEL', { accountId: 'acct-1', updatedAt: new Date('2025-01-01') }), // older, but more specific
      secretRow('LABEL', { workspaceId: 'ws-t1', updatedAt: new Date('2020-01-01') }), // oldest, but most specific
    ]);
    mockProviderGet.mockImplementation(async (id: string) => id);

    const workers = [worker('t1')];
    await attachRoleEnvSecrets(workers, [task('t1', { roleSlug: 'builder' })], 'acct-1');

    expect(workers[0].roleEnvSecrets!.TOKEN).toBe('secret-LABEL-ws-t1');
  });

  it('skips a task with no roleSlug', async () => {
    const workers = [worker('t1')];
    await attachRoleEnvSecrets(workers, [task('t1', { roleSlug: null })], 'acct-1');

    expect(workers[0].roleEnvSecrets).toBeUndefined();
    expect(mockSecretsFindMany).not.toHaveBeenCalled();
  });

  it('does nothing when the role and workspace declare no env mapping at all', async () => {
    mockSelectRows.mockResolvedValue([roleRow({})]);

    const workers = [worker('t1')];
    await attachRoleEnvSecrets(workers, [task('t1', { roleSlug: 'builder' })], 'acct-1');

    expect(workers[0].roleEnvSecrets).toBeUndefined();
    expect(mockSecretsFindMany).not.toHaveBeenCalled();
  });

  it('is a no-op without ENCRYPTION_KEY', async () => {
    delete process.env.ENCRYPTION_KEY;
    mockSelectRows.mockResolvedValue([roleRow({ NODE_AUTH_TOKEN: 'LABEL' })]);

    const workers = [worker('t1')];
    await attachRoleEnvSecrets(workers, [task('t1', { roleSlug: 'builder' })], 'acct-1');

    expect(workers[0].roleEnvSecrets).toBeUndefined();
    expect(mockSelectRows).not.toHaveBeenCalled();
  });

  it('scopes the secrets lookup to the task team, the role_env_secret purpose and the declared labels', async () => {
    mockSelectRows.mockResolvedValue([roleRow({ NODE_AUTH_TOKEN: 'REGISTRY_TOKEN_LABEL' })]);

    const workers = [worker('t1')];
    await attachRoleEnvSecrets(workers, [task('t1', { roleSlug: 'builder', teamId: 'team-9' })], 'acct-1');

    const where = (mockSecretsFindMany.mock.calls[0]?.[0] as any)?.where;
    const findPredicate = (type: string, field: string) => (where?.args ?? []).find((n: any) => n?.type === type && n.field === field);
    expect(findPredicate('eq', 'teamId')).toEqual({ field: 'teamId', value: 'team-9', type: 'eq' });
    expect(findPredicate('eq', 'purpose')).toEqual({ field: 'purpose', value: 'role_env_secret', type: 'eq' });
    expect(findPredicate('inArray', 'label').values).toEqual(['REGISTRY_TOKEN_LABEL']);
  });

  it('does not throw and attaches nothing when the secrets lookup fails', async () => {
    mockSelectRows.mockResolvedValue([roleRow({ NODE_AUTH_TOKEN: 'LABEL' })]);
    mockSecretsFindMany.mockImplementation(async () => { throw new Error('db down'); });

    const workers = [worker('t1')];
    await expect(attachRoleEnvSecrets(workers, [task('t1', { roleSlug: 'builder' })], 'acct-1')).resolves.toBeUndefined();

    expect(workers[0].roleEnvSecrets).toBeUndefined();
  });
});
