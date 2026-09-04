import { describe, it, expect, mock, beforeEach, afterAll } from 'bun:test';

/**
 * Coverage note — why this file exists.
 *
 * The failure taxonomy is the whole point of this block, and its order is
 * documented as the contract: never_mounted > expired_or_revoked > transient.
 * Yet `route.test.ts` only ever asserts `never_mounted`. Relabelling the
 * credential failure as `transient` left the entire claim suite green.
 *
 * That mode is not cosmetic — it reaches the caller in the 422 `connectorFailures`
 * payload and drives the connector-block notification, so it is the difference
 * between telling an operator "your token was revoked, reconnect it" and
 * "the endpoint is flaky, retry later".
 */

const mockSkillsFindMany = mock(async (_a?: any) => [] as any[]);
const mockConnectorsFindMany = mock(async (_a?: any) => [] as any[]);
const mockSharesFindMany = mock(async (_a?: any) => [] as any[]);
const mockConnWorkspacesFindMany = mock(async (_a?: any) => [] as any[]);
const mockSecretsFindMany = mock(async (_a?: any) => [] as any[]);
const mockProviderGet = mock(async (_id: string) => 'decrypted' as string | null);

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workspaceSkills: { findMany: mockSkillsFindMany },
      connectors: { findMany: mockConnectorsFindMany },
      connectorShares: { findMany: mockSharesFindMany },
      connectorWorkspaces: { findMany: mockConnWorkspacesFindMany },
      secrets: { findMany: mockSecretsFindMany },
    },
  },
}));
mock.module('@buildd/core/secrets', () => ({
  getSecretsProvider: () => ({ get: mockProviderGet }),
}));

const { runConnectorPreFilter } = await import('./connector-prefilter');

const ORIGINAL_KEY = process.env.ENCRYPTION_KEY;
const ORIGINAL_FETCH = globalThis.fetch;

/** A claim candidate whose role opts into connectors. */
function task(id: string, opts: {
  roleSlug?: string | null;
  teamId?: string | null;
  advisory?: boolean;
  requiredConnectors?: string[] | null;
} = {}) {
  const { roleSlug = 'builder', teamId = 'team-1', advisory = false, requiredConnectors = null } = opts;
  return {
    id,
    title: `Task ${id}`,
    workspaceId: 'ws-1',
    roleSlug,
    requiredConnectors,
    workspace: teamId ? { teamId, connectorAdvisoryMode: advisory } : undefined,
  } as any;
}

/** A role row carrying connectorRefs. `workspaceId: null` = team default. */
function role(refs: string[], workspaceId: string | null = null, teamId = 'team-1') {
  return { slug: 'builder', teamId, workspaceId, connectorRefs: refs } as any;
}

function connector(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    teamId: 'team-1',
    name: id,
    authMode: 'none',
    transport: 'http',
    url: `https://mcp.test/${id}`,
    envMapping: null,
    ...extra,
  } as any;
}

beforeEach(() => {
  process.env.ENCRYPTION_KEY = 'test-key';
  for (const m of [
    mockSkillsFindMany, mockConnectorsFindMany, mockSharesFindMany,
    mockConnWorkspacesFindMany, mockSecretsFindMany,
  ]) {
    m.mockReset();
    m.mockResolvedValue([]);
  }
  mockProviderGet.mockReset();
  mockProviderGet.mockResolvedValue('decrypted');
  // HEAD probes succeed unless a test says otherwise, so `transient` never
  // contaminates a scenario that is about a different taxonomy mode.
  globalThis.fetch = mock(async () => new Response(null, { status: 200 })) as any;
});

afterAll(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_KEY === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = ORIGINAL_KEY;
});

describe('runConnectorPreFilter — never_mounted', () => {
  it('classifies a dangling connector ref', async () => {
    mockSkillsFindMany.mockResolvedValue([role(['conn-gone'])]);
    mockConnectorsFindMany.mockResolvedValue([]);

    const r = await runConnectorPreFilter([task('t1')]);

    expect(r.connectorMismatchTaskIds.has('t1')).toBe(true);
    expect(r.taskConnectorFailures.get('t1')).toEqual([
      { connectorId: 'conn-gone', connectorName: 'conn-gone', mode: 'never_mounted' },
    ]);
  });

  // The cross-team isolation guarantee.
  it('classifies a connector owned by another team with no share grant', async () => {
    mockSkillsFindMany.mockResolvedValue([role(['conn-a'])]);
    mockConnectorsFindMany.mockResolvedValue([connector('conn-a', { teamId: 'team-OTHER' })]);
    mockSharesFindMany.mockResolvedValue([]);

    const r = await runConnectorPreFilter([task('t1')]);

    expect(r.taskConnectorFailures.get('t1')?.[0].mode).toBe('never_mounted');
  });

  it('accepts an other-team connector that IS shared to this team', async () => {
    mockSkillsFindMany.mockResolvedValue([role(['conn-a'])]);
    mockConnectorsFindMany.mockResolvedValue([connector('conn-a', { teamId: 'team-OTHER' })]);
    mockSharesFindMany.mockResolvedValue([{ connectorId: 'conn-a', sharedWithTeamId: 'team-1' }]);

    const r = await runConnectorPreFilter([task('t1')]);

    expect(r.taskConnectorFailures.has('t1')).toBe(false);
    expect(r.connectorMismatchTaskIds.size).toBe(0);
  });

  it('classifies a connector explicitly disabled for the workspace', async () => {
    mockSkillsFindMany.mockResolvedValue([role(['conn-a'])]);
    mockConnectorsFindMany.mockResolvedValue([connector('conn-a')]);
    mockConnWorkspacesFindMany.mockResolvedValue([
      { connectorId: 'conn-a', workspaceId: 'ws-1', enabled: false },
    ]);

    const r = await runConnectorPreFilter([task('t1')]);

    expect(r.taskConnectorFailures.get('t1')?.[0].mode).toBe('never_mounted');
  });

  it('treats a missing connector_workspaces row as enabled', async () => {
    mockSkillsFindMany.mockResolvedValue([role(['conn-a'])]);
    mockConnectorsFindMany.mockResolvedValue([connector('conn-a')]);
    mockConnWorkspacesFindMany.mockResolvedValue([]);

    const r = await runConnectorPreFilter([task('t1')]);

    expect(r.taskConnectorFailures.has('t1')).toBe(false);
  });
});

describe('runConnectorPreFilter — expired_or_revoked', () => {
  it('classifies an oauth connector with no credential row', async () => {
    mockSkillsFindMany.mockResolvedValue([role(['conn-a'])]);
    mockConnectorsFindMany.mockResolvedValue([connector('conn-a', { authMode: 'oauth' })]);
    mockSecretsFindMany.mockResolvedValue([]);

    const r = await runConnectorPreFilter([task('t1')]);

    expect(r.taskConnectorFailures.get('t1')?.[0].mode).toBe('expired_or_revoked');
  });

  it('classifies an oauth connector whose token expired and was not refreshed recently', async () => {
    mockSkillsFindMany.mockResolvedValue([role(['conn-a'])]);
    mockConnectorsFindMany.mockResolvedValue([connector('conn-a', { authMode: 'oauth' })]);
    mockSecretsFindMany.mockResolvedValue([
      {
        id: 'sec-1',
        label: 'conn-a',
        tokenExpiresAt: new Date(Date.now() - 60 * 60 * 1000),
        lastRefreshedAt: new Date(Date.now() - 60 * 60 * 1000),
      },
    ]);

    const r = await runConnectorPreFilter([task('t1')]);

    expect(r.taskConnectorFailures.get('t1')?.[0].mode).toBe('expired_or_revoked');
  });

  // The 5-minute grace window: a token that just refreshed is trusted even
  // though its recorded expiry is in the past, because the refresh raced the read.
  it('does NOT fail an expired oauth token refreshed within the last 5 minutes', async () => {
    mockSkillsFindMany.mockResolvedValue([role(['conn-a'])]);
    mockConnectorsFindMany.mockResolvedValue([connector('conn-a', { authMode: 'oauth' })]);
    mockSecretsFindMany.mockResolvedValue([
      {
        id: 'sec-1',
        label: 'conn-a',
        tokenExpiresAt: new Date(Date.now() - 60 * 1000),
        lastRefreshedAt: new Date(Date.now() - 30 * 1000),
      },
    ]);

    const r = await runConnectorPreFilter([task('t1')]);

    expect(r.taskConnectorFailures.has('t1')).toBe(false);
  });

  it('classifies a header connector whose secret will not decrypt', async () => {
    mockSkillsFindMany.mockResolvedValue([role(['conn-a'])]);
    mockConnectorsFindMany.mockResolvedValue([connector('conn-a', { authMode: 'header' })]);
    mockSecretsFindMany.mockResolvedValue([
      { id: 'sec-1', label: 'conn-a', tokenExpiresAt: null, lastRefreshedAt: null },
    ]);
    mockProviderGet.mockResolvedValue(null);

    const r = await runConnectorPreFilter([task('t1')]);

    expect(r.taskConnectorFailures.get('t1')?.[0].mode).toBe('expired_or_revoked');
  });

  it('classifies a header connector whose decrypt throws', async () => {
    mockSkillsFindMany.mockResolvedValue([role(['conn-a'])]);
    mockConnectorsFindMany.mockResolvedValue([connector('conn-a', { authMode: 'header' })]);
    mockSecretsFindMany.mockResolvedValue([
      { id: 'sec-1', label: 'conn-a', tokenExpiresAt: null, lastRefreshedAt: null },
    ]);
    mockProviderGet.mockRejectedValue(new Error('bad key'));

    const r = await runConnectorPreFilter([task('t1')]);

    expect(r.taskConnectorFailures.get('t1')?.[0].mode).toBe('expired_or_revoked');
  });

  it('skips credential classification entirely without ENCRYPTION_KEY', async () => {
    delete process.env.ENCRYPTION_KEY;
    mockSkillsFindMany.mockResolvedValue([role(['conn-a'])]);
    mockConnectorsFindMany.mockResolvedValue([connector('conn-a', { authMode: 'oauth' })]);
    mockSecretsFindMany.mockResolvedValue([]);

    const r = await runConnectorPreFilter([task('t1')]);

    expect(r.taskConnectorFailures.has('t1')).toBe(false);
    expect(mockSecretsFindMany).not.toHaveBeenCalled();
  });
});

describe('runConnectorPreFilter — transient', () => {
  it('classifies an http connector whose HEAD probe fails', async () => {
    globalThis.fetch = mock(async () => { throw new Error('ECONNREFUSED'); }) as any;
    mockSkillsFindMany.mockResolvedValue([role(['conn-a'])]);
    mockConnectorsFindMany.mockResolvedValue([connector('conn-a')]);

    const r = await runConnectorPreFilter([task('t1')]);

    expect(r.taskConnectorFailures.get('t1')?.[0].mode).toBe('transient');
  });

  it('does not probe a stdio connector', async () => {
    const fetchSpy = mock(async () => new Response(null, { status: 200 }));
    globalThis.fetch = fetchSpy as any;
    mockSkillsFindMany.mockResolvedValue([role(['conn-a'])]);
    mockConnectorsFindMany.mockResolvedValue([
      connector('conn-a', { transport: 'stdio', authMode: 'none', url: null }),
    ]);

    const r = await runConnectorPreFilter([task('t1')]);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(r.taskConnectorFailures.has('t1')).toBe(false);
  });
});

// The documented order: the FIRST matching mode is the one reported. Getting
// this wrong sends an operator to the wrong remediation.
describe('runConnectorPreFilter — taxonomy precedence', () => {
  it('reports expired_or_revoked, not transient, when the credential is also bad', async () => {
    globalThis.fetch = mock(async () => { throw new Error('ECONNREFUSED'); }) as any;
    mockSkillsFindMany.mockResolvedValue([role(['conn-a'])]);
    mockConnectorsFindMany.mockResolvedValue([connector('conn-a', { authMode: 'oauth' })]);
    mockSecretsFindMany.mockResolvedValue([]); // no credential

    const r = await runConnectorPreFilter([task('t1')]);

    expect(r.taskConnectorFailures.get('t1')?.[0].mode).toBe('expired_or_revoked');
  });

  it('reports never_mounted, not expired_or_revoked, when the connector is invisible', async () => {
    mockSkillsFindMany.mockResolvedValue([role(['conn-a'])]);
    mockConnectorsFindMany.mockResolvedValue([
      connector('conn-a', { teamId: 'team-OTHER', authMode: 'oauth' }),
    ]);
    mockSharesFindMany.mockResolvedValue([]);
    mockSecretsFindMany.mockResolvedValue([]);

    const r = await runConnectorPreFilter([task('t1')]);

    expect(r.taskConnectorFailures.get('t1')?.[0].mode).toBe('never_mounted');
  });
});

describe('runConnectorPreFilter — advisory mode', () => {
  it('lets a partially degraded task claim, recording degradedConnectors', async () => {
    globalThis.fetch = mock(async (url: any) =>
      String(url).endsWith('conn-bad')
        ? Promise.reject(new Error('down'))
        : new Response(null, { status: 200 }),
    ) as any;
    mockSkillsFindMany.mockResolvedValue([role(['conn-ok', 'conn-bad'])]);
    mockConnectorsFindMany.mockResolvedValue([connector('conn-ok'), connector('conn-bad')]);

    const r = await runConnectorPreFilter([task('t1', { advisory: true })]);

    expect(r.connectorMismatchTaskIds.has('t1')).toBe(false);
    expect(r.taskDegradedConnectors.get('t1')).toEqual([
      { id: 'conn-bad', name: 'conn-bad', failureMode: 'transient' },
    ]);
  });

  // Total degradation always holds the task, flag or not — a task with zero
  // working connectors cannot do the work it was routed for.
  it('still blocks a task when EVERY connector fails, even in advisory mode', async () => {
    globalThis.fetch = mock(async () => { throw new Error('down'); }) as any;
    mockSkillsFindMany.mockResolvedValue([role(['conn-a'])]);
    mockConnectorsFindMany.mockResolvedValue([connector('conn-a')]);

    const r = await runConnectorPreFilter([task('t1', { advisory: true })]);

    expect(r.connectorMismatchTaskIds.has('t1')).toBe(true);
    expect(r.taskDegradedConnectors.has('t1')).toBe(false);
  });

  it('blocks when a failing connector is declared in requiredConnectors', async () => {
    globalThis.fetch = mock(async (url: any) =>
      String(url).endsWith('conn-bad')
        ? Promise.reject(new Error('down'))
        : new Response(null, { status: 200 }),
    ) as any;
    mockSkillsFindMany.mockResolvedValue([role(['conn-ok', 'conn-bad'])]);
    mockConnectorsFindMany.mockResolvedValue([connector('conn-ok'), connector('conn-bad')]);

    const r = await runConnectorPreFilter([
      task('t1', { advisory: true, requiredConnectors: ['conn-bad'] }),
    ]);

    expect(r.connectorMismatchTaskIds.has('t1')).toBe(true);
    expect(r.taskDegradedConnectors.has('t1')).toBe(false);
  });

  it('records required-connector failures only for the declared IDs', async () => {
    globalThis.fetch = mock(async () => { throw new Error('down'); }) as any;
    mockSkillsFindMany.mockResolvedValue([role(['conn-a', 'conn-b'])]);
    mockConnectorsFindMany.mockResolvedValue([connector('conn-a'), connector('conn-b')]);

    const r = await runConnectorPreFilter([task('t1', { requiredConnectors: ['conn-b'] })]);

    expect(r.taskRequiredConnectorFailures.get('t1')?.map(f => f.connectorId)).toEqual(['conn-b']);
    expect(r.taskConnectorFailures.get('t1')).toHaveLength(2);
  });

  it('records no required failures when the task declares none', async () => {
    globalThis.fetch = mock(async () => { throw new Error('down'); }) as any;
    mockSkillsFindMany.mockResolvedValue([role(['conn-a'])]);
    mockConnectorsFindMany.mockResolvedValue([connector('conn-a')]);

    const r = await runConnectorPreFilter([task('t1')]);

    expect(r.connectorMismatchTaskIds.has('t1')).toBe(true);
    expect(r.taskRequiredConnectorFailures.has('t1')).toBe(false);
  });
});

describe('runConnectorPreFilter — role resolution and opt-out', () => {
  it('prefers the workspace-scoped role row over the team default', async () => {
    mockSkillsFindMany.mockResolvedValue([
      role(['conn-team'], null),
      role(['conn-ws'], 'ws-1'),
    ]);
    mockConnectorsFindMany.mockResolvedValue([]);

    const r = await runConnectorPreFilter([task('t1')]);

    // The workspace row's ref is the one that got classified.
    expect(r.taskConnectorFailures.get('t1')).toEqual([
      { connectorId: 'conn-ws', connectorName: 'conn-ws', mode: 'never_mounted' },
    ]);
  });

  it('never fails a task whose role declares no connectorRefs', async () => {
    mockSkillsFindMany.mockResolvedValue([role([])]);

    const r = await runConnectorPreFilter([task('t1')]);

    expect(r.connectorMismatchTaskIds.size).toBe(0);
    expect(mockConnectorsFindMany).not.toHaveBeenCalled();
  });

  it('queries nothing for a task with no roleSlug', async () => {
    const r = await runConnectorPreFilter([task('t1', { roleSlug: null })]);

    expect(r.connectorMismatchTaskIds.size).toBe(0);
    expect(mockSkillsFindMany).not.toHaveBeenCalled();
  });

  it('queries nothing for a task whose workspace has no team', async () => {
    const r = await runConnectorPreFilter([task('t1', { teamId: null })]);

    expect(mockSkillsFindMany).not.toHaveBeenCalled();
  });
});
