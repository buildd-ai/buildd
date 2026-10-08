import { describe, it, expect, mock } from 'bun:test';

const mockDiscover = mock(async (_url: string) => ({ authMode: 'oauth' as 'oauth' | 'none', authorizationServer: {} }));
const mockIcon = mock(async (_url: string) => 'https://x.dev/icon.png' as string | null);
mock.module('@/lib/mcp-oauth', () => ({ discoverOAuthMetadata: mockDiscover }));
mock.module('@/lib/connector-icon', () => ({ resolveConnectorIcon: mockIcon, resolveConnectorIconData: async () => null }));

const { parseCatalogEntryInput, verifyCatalogServer } = await import('./connector-catalog-input');

describe('parseCatalogEntryInput', () => {
  it('fills defaults and derives a slug from the name', () => {
    const r = parseCatalogEntryInput({ name: 'Our Grafana!', url: 'https://mcp.grafana.example/mcp' });
    expect(r).toEqual({ ok: true, value: expect.objectContaining({ slug: 'our-grafana', authMode: 'oauth', category: 'other', description: '', iconUrl: null }) });
  });

  it('requires https (rejects http and the dropped-h typo)', () => {
    for (const url of ['http://mcp.x.dev', 'ttps://mcp.x.dev', 'nope']) {
      expect(parseCatalogEntryInput({ name: 'X', url })).toMatchObject({ ok: false, error: 'invalid_url' });
    }
  });

  it('rejects a bad slug, auth mode, category or icon', () => {
    const base = { name: 'X', url: 'https://mcp.x.dev' };
    expect(parseCatalogEntryInput({ ...base, slug: 'Bad Slug' })).toMatchObject({ ok: false, error: 'invalid_slug' });
    expect(parseCatalogEntryInput({ ...base, authMode: 'assertion' })).toMatchObject({ ok: false, error: 'invalid_auth_mode' });
    expect(parseCatalogEntryInput({ ...base, category: 'weird' })).toMatchObject({ ok: false, error: 'invalid_category' });
    expect(parseCatalogEntryInput({ ...base, iconUrl: 'javascript:1' })).toMatchObject({ ok: false, error: 'invalid_icon_url' });
  });

  it('header auth needs a header name', () => {
    expect(parseCatalogEntryInput({ name: 'X', url: 'https://mcp.x.dev', authMode: 'header' })).toMatchObject({ ok: false, error: 'header_name_required' });
    expect(parseCatalogEntryInput({ name: 'X', url: 'https://mcp.x.dev', authMode: 'header', headerName: 'Authorization' }).ok).toBe(true);
  });

  it('partial mode accepts a subset and adds no defaults', () => {
    expect(parseCatalogEntryInput({ description: 'new' }, true)).toEqual({ ok: true, value: { description: 'new' } });
  });
});

describe('verifyCatalogServer', () => {
  it('keeps oauth when discovery finds an authorization server, and resolves the icon', async () => {
    mockDiscover.mockResolvedValueOnce({ authMode: 'oauth', authorizationServer: {} });
    expect(await verifyCatalogServer({ url: 'https://mcp.x.dev', authMode: 'oauth', iconUrl: null }))
      .toEqual({ ok: true, authMode: 'oauth', iconUrl: 'https://x.dev/icon.png' });
  });

  it('stores an anonymously-reachable server as none', async () => {
    mockDiscover.mockResolvedValueOnce({ authMode: 'none' } as any);
    expect(await verifyCatalogServer({ url: 'https://mcp.x.dev', authMode: 'oauth', iconUrl: 'https://given/i.png' }))
      .toEqual({ ok: true, authMode: 'none', iconUrl: 'https://given/i.png' });
  });

  it('refuses a server that fails discovery (the catalog only lists servers that connect)', async () => {
    mockDiscover.mockRejectedValueOnce(new Error('Failed to fetch Protected Resource Metadata (404)'));
    expect(await verifyCatalogServer({ url: 'https://mcp.x.dev', authMode: 'oauth', iconUrl: null }))
      .toMatchObject({ ok: false, error: 'discovery_failed', message: expect.stringContaining('404') });
  });
});
