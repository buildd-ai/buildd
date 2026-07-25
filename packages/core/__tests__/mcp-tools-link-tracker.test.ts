import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { handleBuilddAction, adminActions, type ApiFn, type ActionContext } from '../mcp-tools';

const MOCK_WORKSPACE_ID = '00000000-0000-0000-0000-000000000001';

function createMockContext(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    workspaceId: MOCK_WORKSPACE_ID,
    getWorkspaceId: async () => MOCK_WORKSPACE_ID,
    getLevel: async () => 'admin',
    ...overrides,
  };
}

describe('link_tracker', () => {
  let mockApi: ReturnType<typeof mock>;
  beforeEach(() => { mockApi = mock(); });

  it('is an admin-tier action', () => {
    expect(adminActions).toContain('link_tracker');
  });

  it('POSTs the URL to the mission link route and confirms the linked id/url', async () => {
    mockApi.mockResolvedValueOnce({
      id: 'link-1',
      provider: 'linear',
      externalId: 'mobile-app-9f8e7d6c',
      externalUrl: 'https://linear.app/acme/project/mobile-app-9f8e7d6c',
    });
    const res = await handleBuilddAction(mockApi as unknown as ApiFn, 'link_tracker',
      { entityType: 'mission', entityId: 'm-9', url: 'https://linear.app/acme/project/mobile-app-9f8e7d6c' },
      createMockContext());

    const [endpoint, opts] = mockApi.mock.calls[0];
    expect(endpoint).toBe('/api/missions/m-9/link');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body).url).toBe('https://linear.app/acme/project/mobile-app-9f8e7d6c');

    const text = (res as any).content[0].text;
    expect(text).toContain('mobile-app-9f8e7d6c');
    expect(text).toContain('m-9');
  });

  it('defaults entityType to mission when omitted', async () => {
    mockApi.mockResolvedValueOnce({ id: 'link-1', provider: 'linear', externalId: 'ACM-42' });
    await handleBuilddAction(mockApi as unknown as ApiFn, 'link_tracker',
      { entityId: 'm-9', url: 'https://linear.app/acme/issue/ACM-42' }, createMockContext());
    expect(mockApi.mock.calls[0][0]).toBe('/api/missions/m-9/link');
  });

  it('rejects an unsupported entityType (keeps the shape generic)', async () => {
    await expect(handleBuilddAction(mockApi as unknown as ApiFn, 'link_tracker',
      { entityType: 'task', entityId: 't-1', url: 'https://linear.app/acme/issue/ACM-1' }, createMockContext()))
      .rejects.toThrow('Unsupported entityType');
    expect(mockApi).not.toHaveBeenCalled();
  });

  it('requires entityId and url', async () => {
    await expect(handleBuilddAction(mockApi as unknown as ApiFn, 'link_tracker',
      { entityType: 'mission', url: 'https://linear.app/acme/project/x-1' }, createMockContext()))
      .rejects.toThrow('entityId is required');
    await expect(handleBuilddAction(mockApi as unknown as ApiFn, 'link_tracker',
      { entityType: 'mission', entityId: 'm-9' }, createMockContext()))
      .rejects.toThrow('url is required');
  });
});
