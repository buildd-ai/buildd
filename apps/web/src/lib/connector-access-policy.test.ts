import { describe, it, expect, mock, beforeEach } from 'bun:test';

const mockPolicyFindMany = mock(async (): Promise<any[]> => []);
const mockLoadTeamCatalog = mock(async (_teamId: string): Promise<any[]> => []);

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      connectorCatalogTeamPolicies: { findMany: mockPolicyFindMany },
    },
  },
}));
mock.module('@buildd/core/db/schema', () => ({
  connectorCatalogTeamPolicies: { teamId: 'teamId', policy: 'policy' },
}));
mock.module('@/lib/connector-catalog-store', () => ({ loadTeamCatalog: mockLoadTeamCatalog }));

import {
  blockedUrlIndex,
  connectorBlock,
  loadBlockedCatalogs,
  checkConnectorBlocked,
} from './connector-access-policy';

const entry = (slug: string, url: string, policy: 'blocked' | 'available' | 'preinstalled') => ({
  slug, name: slug.toUpperCase(), url, policy, id: null, source: 'builtin' as const,
  authMode: 'oauth' as const, description: '', category: 'other' as const, iconUrl: '',
});

const AXIOM = 'https://mcp.axiom.co/mcp';
const VERCEL = 'https://mcp.vercel.com';

beforeEach(() => {
  mockPolicyFindMany.mockReset();
  mockPolicyFindMany.mockResolvedValue([]);
  mockLoadTeamCatalog.mockReset();
  mockLoadTeamCatalog.mockResolvedValue([]);
});

describe('blockedUrlIndex', () => {
  it('indexes only blocked entries, by host', () => {
    const idx = blockedUrlIndex([entry('axiom', AXIOM + '/', 'blocked'), entry('vercel', VERCEL, 'preinstalled')]);
    expect([...idx.keys()]).toEqual(['mcp.axiom.co']);
    expect(idx.get('mcp.axiom.co')).toEqual({ slug: 'axiom', name: 'AXIOM' });
  });
});

describe('connectorBlock', () => {
  const blocked = new Map([['team-a', blockedUrlIndex([entry('axiom', AXIOM, 'blocked')])]]);
  const block = (url: string, teamId = 'team-a', consumer = 'team-a') => connectorBlock({ url, teamId }, consumer, blocked);

  it('blocks a connector whose URL matches an entry the consuming team blocked', () => {
    expect(connectorBlock({ url: 'https://MCP.axiom.co/mcp/', teamId: 'team-a' }, 'team-a', blocked))
      .toEqual({ slug: 'axiom', name: 'AXIOM', blockedByTeamId: 'team-a' });
  });

  // A block covers the entry's server, not one spelling of its URL: a
  // connector on the same host under another path is the same provider.
  it.each([
    ['trailing slash', 'https://mcp.axiom.co/mcp/'],
    ['host case', 'https://MCP.AXIOM.CO/mcp'],
    ['path case', 'https://mcp.axiom.co/MCP'],
    ['sse path', 'https://mcp.axiom.co/sse'],
    ['root path', 'https://mcp.axiom.co'],
    ['nested path', 'https://mcp.axiom.co/mcp/v2/'],
    ['query string', 'https://mcp.axiom.co/mcp?x=1'],
    ['explicit port', 'https://mcp.axiom.co:8443/mcp'],
    ['plain http', 'http://mcp.axiom.co/mcp'],
    ['trailing-dot host', 'https://mcp.axiom.co./mcp'],
  ])('blocks a path/spelling variant on the blocked host (%s)', (_label, url) => {
    expect(block(url)?.slug).toBe('axiom');
  });

  it('does not block a different host that merely shares a suffix or path', () => {
    expect(block('https://axiom.co/mcp')).toBeNull();
    expect(block('https://evil-mcp.axiom.co/mcp')).toBeNull();
    expect(block('https://mcp.axiom.co.example.com/mcp')).toBeNull();
    expect(block('https://example.com/mcp.axiom.co/mcp')).toBeNull();
  });

  it('blocks a path variant shared in from an owner team that blocked it', () => {
    expect(block('https://mcp.axiom.co/sse', 'team-a', 'team-b')?.blockedByTeamId).toBe('team-a');
  });

  it('blocks a path variant a grantee team shares in when the consuming team blocked it', () => {
    expect(block('https://mcp.axiom.co/sse/', 'team-c', 'team-a')?.blockedByTeamId).toBe('team-a');
  });

  it("blocks a connector shared in from an owner team that blocked it", () => {
    expect(connectorBlock({ url: AXIOM, teamId: 'team-a' }, 'team-b', blocked)?.blockedByTeamId).toBe('team-a');
  });

  it("does not leak team A's block onto team B's own connector", () => {
    expect(connectorBlock({ url: AXIOM, teamId: 'team-b' }, 'team-b', blocked)).toBeNull();
  });

  it('ignores connectors with no or unmatched URL', () => {
    expect(connectorBlock({ url: VERCEL, teamId: 'team-a' }, 'team-a', blocked)).toBeNull();
    expect(connectorBlock({ url: null, teamId: 'team-a' }, 'team-a', blocked)).toBeNull();
  });
});

describe('loadBlockedCatalogs', () => {
  it('does one query and builds no catalog when no team blocks anything', async () => {
    const out = await loadBlockedCatalogs(['team-a', 'team-a', 'team-b']);
    expect(out.size).toBe(0);
    expect(mockPolicyFindMany).toHaveBeenCalledTimes(1);
    expect(mockLoadTeamCatalog).not.toHaveBeenCalled();
  });

  it('builds the merged catalog only for teams with a blocked policy', async () => {
    mockPolicyFindMany.mockResolvedValue([{ teamId: 'team-a' }]);
    mockLoadTeamCatalog.mockResolvedValue([entry('axiom', AXIOM, 'blocked')]);
    const out = await loadBlockedCatalogs(['team-a', 'team-b']);
    expect(mockLoadTeamCatalog.mock.calls.map(c => c[0])).toEqual(['team-a']);
    expect(out.get('team-a')?.has('mcp.axiom.co')).toBe(true);
    expect(out.has('team-b')).toBe(false);
  });

  it('propagates DB failure so an agent boundary fails closed', async () => {
    mockPolicyFindMany.mockRejectedValue(new Error('db down'));
    await expect(loadBlockedCatalogs(['team-a'])).rejects.toThrow('db down');
  });

  it('checkConnectorBlocked combines both', async () => {
    mockPolicyFindMany.mockResolvedValue([{ teamId: 'team-a' }]);
    mockLoadTeamCatalog.mockResolvedValue([entry('axiom', AXIOM, 'blocked')]);
    expect((await checkConnectorBlocked({ url: AXIOM, teamId: 'team-a' }, 'team-a'))?.slug).toBe('axiom');
    expect((await checkConnectorBlocked({ url: 'https://mcp.axiom.co/sse', teamId: 'team-a' }, 'team-a'))?.slug).toBe('axiom');
  });
});
