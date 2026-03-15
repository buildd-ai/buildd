import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// Mock functions
const mockGetCurrentUser = mock(() => null as any);
const mockGetUserTeamIds = mock(() => Promise.resolve([] as string[]));
const mockSecretsSet = mock(() => Promise.resolve('secret-1'));
const mockSecretsList = mock(() => Promise.resolve([] as any[]));
const mockSecretsDelete = mock(() => Promise.resolve());

mock.module('@/lib/auth-helpers', () => ({
  getCurrentUser: mockGetCurrentUser,
}));

mock.module('@/lib/team-access', () => ({
  getUserTeamIds: mockGetUserTeamIds,
}));

mock.module('@buildd/core/secrets', () => ({
  getSecretsProvider: () => ({
    set: mockSecretsSet,
    list: mockSecretsList,
    delete: mockSecretsDelete,
  }),
}));

import { POST } from './route';

function createPostRequest(body: any): NextRequest {
  return new NextRequest('http://localhost:3000/api/secrets', {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
    body: JSON.stringify(body),
  });
}

describe('POST /api/secrets', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockGetUserTeamIds.mockReset();
    mockSecretsSet.mockReset();
    mockSecretsList.mockReset();

    // Default: authenticated user with a team
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockGetUserTeamIds.mockResolvedValue(['team-1']);
    mockSecretsSet.mockResolvedValue('secret-1');
  });

  it('returns 401 when not authenticated', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    const res = await POST(createPostRequest({ value: 'key', purpose: 'anthropic_api_key' }));
    expect(res.status).toBe(401);
  });

  it('returns 403 when user has no teams', async () => {
    mockGetUserTeamIds.mockResolvedValue([]);
    const res = await POST(createPostRequest({ value: 'key', purpose: 'anthropic_api_key' }));
    expect(res.status).toBe(403);
  });

  it('returns 400 when value or purpose is missing', async () => {
    const res1 = await POST(createPostRequest({ purpose: 'anthropic_api_key' }));
    expect(res1.status).toBe(400);

    const res2 = await POST(createPostRequest({ value: 'key' }));
    expect(res2.status).toBe(400);
  });

  it('returns 400 for invalid purpose', async () => {
    const res = await POST(createPostRequest({ value: 'key', purpose: 'invalid_purpose' }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('Invalid purpose');
  });

  it('accepts mcp_credential purpose with label', async () => {
    const res = await POST(createPostRequest({
      value: 'dispatch-api-key-value',
      purpose: 'mcp_credential',
      label: 'DISPATCH_API_KEY',
      accountId: 'account-1',
    }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.id).toBe('secret-1');

    // Verify provider.set was called with correct args
    expect(mockSecretsSet).toHaveBeenCalledWith(null, 'dispatch-api-key-value', {
      teamId: 'team-1',
      accountId: 'account-1',
      workspaceId: undefined,
      purpose: 'mcp_credential',
      label: 'DISPATCH_API_KEY',
    });
  });

  it('returns 400 for mcp_credential without label', async () => {
    const res = await POST(createPostRequest({
      value: 'some-value',
      purpose: 'mcp_credential',
      accountId: 'account-1',
    }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('label is required');
  });

  it('accepts anthropic_api_key purpose without label', async () => {
    const res = await POST(createPostRequest({
      value: 'sk-ant-xxx',
      purpose: 'anthropic_api_key',
      accountId: 'account-1',
    }));
    expect(res.status).toBe(200);
  });

  it('accepts all valid purpose values', async () => {
    for (const purpose of ['anthropic_api_key', 'oauth_token', 'webhook_token', 'custom']) {
      mockSecretsSet.mockResolvedValue('secret-1');
      const res = await POST(createPostRequest({ value: 'val', purpose }));
      expect(res.status).toBe(200);
    }
  });
});
