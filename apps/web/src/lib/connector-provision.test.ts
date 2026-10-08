import { describe, it, expect, mock, beforeEach } from 'bun:test';

const owned: any[] = [];
const inserted: any[] = [];
const enabled: any[] = [];
let insertReturns: any[] | null = null;
const mockDiscoverAndRegisterDeps = {
  discover: mock(async (_u: string) => ({ authMode: 'oauth', authorizationServer: { registration_endpoint: 'https://as/reg' } } as any)),
  register: mock(async () => ({ client_id: 'cid', client_secret: 'csecret' })),
};

class FakeRejected extends Error {
  constructor(readonly needsApprovedClient: boolean, readonly description: string | null = null) { super('DCR failed'); }
}
mock.module('@/lib/mcp-oauth', () => ({
  ClientRegistrationRejectedError: FakeRejected,
  discoverOAuthMetadata: mockDiscoverAndRegisterDeps.discover,
  registerClient: mockDiscoverAndRegisterDeps.register,
  getCallbackUrl: (o: string) => `${o}/api/connectors/callback`,
}));
mock.module('@buildd/core/secrets', () => ({ encrypt: (v: string) => `enc:${v}` }));
mock.module('@/lib/connector-icon', () => ({ resolveConnectorIcon: async () => 'https://resolved/icon.png' }));
mock.module('drizzle-orm', () => ({
  eq: (a: any, b: any) => ({ op: 'eq', a, b }),
  and: (...args: any[]) => ({ op: 'and', args }),
}));
mock.module('@buildd/core/db/schema', () => ({
  connectors: { teamId: 'connectors.team_id', name: 'connectors.name' },
  connectorWorkspaces: { connectorId: 'cw.connector_id', workspaceId: 'cw.workspace_id' },
  workspaces: { teamId: 'workspaces.team_id' },
}));
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      connectors: {
        findMany: async ({ where }: any) => owned.filter(c => where.op === 'eq' && c.teamId === where.b),
        findFirst: async () => owned[0] ?? null,
      },
      workspaces: { findMany: async ({ where }: any) => [{ id: 'ws-1', teamId: where.b }, { id: 'ws-2', teamId: where.b }] },
    },
    insert: (table: any) => ({
      values: (v: any) => {
        if (table.workspaceId) { enabled.push(...(Array.isArray(v) ? v : [v])); return { onConflictDoUpdate: async () => undefined }; }
        inserted.push(v);
        return { onConflictDoNothing: () => ({ returning: async () => insertReturns ?? [{ id: 'conn-new', ...v }] }) };
      },
    }),
  },
}));

const { ensureCatalogConnector, preinstallForTeam, applyPreinstalledToWorkspace, discoverAndRegister, registrationRefusalBody } = await import('./connector-provision');

const entry = (over: any = {}) => ({
  id: null, source: 'builtin', policy: 'preinstalled', slug: 'neon', name: 'Neon', url: 'https://mcp.neon.tech/mcp',
  authMode: 'oauth', description: '', category: 'database', iconUrl: 'https://neon/icon.ico', ...over,
});

beforeEach(() => { owned.length = 0; inserted.length = 0; enabled.length = 0; insertReturns = null; });

describe('discoverAndRegister', () => {
  it('registers a client and encrypts its secret', async () => {
    const r = await discoverAndRegister('https://mcp.x', 'https://buildd.dev');
    expect(r).toMatchObject({ authMode: 'oauth', clientId: 'cid', encryptedClientSecret: 'enc:csecret' });
    expect(mockDiscoverAndRegisterDeps.register).toHaveBeenCalledWith('https://as/reg', 'https://buildd.dev/api/connectors/callback', { grantTypesSupported: undefined });
  });

  it("passes the AS's supported grant types so refresh_token is registered when offered", async () => {
    mockDiscoverAndRegisterDeps.discover.mockResolvedValueOnce({
      authMode: 'oauth',
      authorizationServer: { registration_endpoint: 'https://as/reg', grant_types_supported: ['authorization_code', 'refresh_token'] },
    } as any);
    await discoverAndRegister('https://mcp.axiom.co/mcp', 'https://buildd.dev');
    expect(mockDiscoverAndRegisterDeps.register).toHaveBeenLastCalledWith('https://as/reg', 'https://buildd.dev/api/connectors/callback', {
      grantTypesSupported: ['authorization_code', 'refresh_token'],
    });
  });
});

describe('registrationRefusalBody', () => {
  it("uses the catalog's Vercel guidance for Vercel's approved-clients-only refusal", () => {
    const body = registrationRefusalBody(new FakeRejected(true), 'https://mcp.vercel.com/');
    expect(body?.error).toBe('needs_approved_client');
    expect(body?.message).toContain('Vercel');
    expect(body?.actionUrl).toContain('vercel.com/docs');
  });

  it('names the host and the provider reason for an unlisted server', () => {
    const body = registrationRefusalBody(new FakeRejected(true, 'redirect not approved'), 'https://mcp.example.org/mcp');
    expect(body?.message).toContain('mcp.example.org');
    expect(body?.message).toContain('redirect not approved');
  });

  it('returns null for outages and unrelated errors, leaving the generic error', () => {
    expect(registrationRefusalBody(new FakeRejected(false), 'https://mcp.vercel.com')).toBeNull();
    expect(registrationRefusalBody(new Error('ECONNRESET'), 'https://mcp.vercel.com')).toBeNull();
  });
});

describe('ensureCatalogConnector', () => {
  it('reuses a team connector at the same URL (trailing slash / case insensitive)', async () => {
    owned.push({ id: 'c-existing', teamId: 't1', name: 'my neon', url: 'https://MCP.neon.tech/mcp/' });
    const c = await ensureCatalogConnector('t1', entry() as any, 'https://buildd.dev');
    expect(c.id).toBe('c-existing');
    expect(inserted).toHaveLength(0);
  });

  it('does not reuse another team\'s connector', async () => {
    owned.push({ id: 'c-other', teamId: 't2', name: 'Neon', url: 'https://mcp.neon.tech/mcp' });
    const c = await ensureCatalogConnector('t1', entry() as any, 'https://buildd.dev');
    expect(c.id).toBe('conn-new');
    expect(inserted[0]).toMatchObject({ teamId: 't1', name: 'Neon', authMode: 'oauth', clientId: 'cid', iconUrl: 'https://neon/icon.ico' });
  });

  it('creates a no-auth entry without discovery', async () => {
    mockDiscoverAndRegisterDeps.discover.mockClear();
    await ensureCatalogConnector('t1', entry({ slug: 'context7', name: 'Context7', url: 'https://mcp.context7.com/mcp', authMode: 'none' }) as any, 'o');
    expect(mockDiscoverAndRegisterDeps.discover).not.toHaveBeenCalled();
    expect(inserted[0]).toMatchObject({ authMode: 'none', clientId: null });
  });
});

describe('preinstallForTeam', () => {
  it('enables the connector in every workspace of the team', async () => {
    await preinstallForTeam('t1', entry() as any, 'o');
    expect(enabled).toEqual([
      { connectorId: 'conn-new', workspaceId: 'ws-1', enabled: true },
      { connectorId: 'conn-new', workspaceId: 'ws-2', enabled: true },
    ]);
  });
});

describe('applyPreinstalledToWorkspace', () => {
  it('installs only preinstalled entries and keeps going past a failure', async () => {
    mockDiscoverAndRegisterDeps.discover.mockRejectedValueOnce(new Error('down'));
    const r = await applyPreinstalledToWorkspace('t1', 'ws-9', 'o', [
      entry({ slug: 'neon' }),
      entry({ slug: 'context7', name: 'Context7', url: 'https://mcp.context7.com/mcp', authMode: 'none' }),
      entry({ slug: 'vercel', name: 'Vercel', url: 'https://mcp.vercel.com', policy: 'available' }),
    ] as any);
    expect(r).toEqual({ installed: ['context7'], failed: ['neon'] });
    expect(enabled).toEqual([{ connectorId: 'conn-new', workspaceId: 'ws-9', enabled: true }]);
  });
});
