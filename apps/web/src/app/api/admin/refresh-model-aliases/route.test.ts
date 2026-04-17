import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(() => null as any);
const mockAuthenticateApiKey = mock(() => null as any);
const mockUpdateModelAliases = mock(() => Promise.resolve());

mock.module('@/lib/auth-helpers', () => ({
  getCurrentUser: mockGetCurrentUser,
}));

mock.module('@/lib/api-auth', () => ({
  authenticateApiKey: mockAuthenticateApiKey,
  hashApiKey: (key: string) => `hashed_${key}`,
  extractApiKeyPrefix: (key: string) => key.substring(0, 12),
}));

mock.module('@buildd/core/model-aliases', () => ({
  updateModelAliases: mockUpdateModelAliases,
  DEFAULT_ALIASES: {
    haiku: 'claude-haiku-4-5-20251001',
    sonnet: 'claude-sonnet-4-6',
    opus: 'claude-opus-4-7',
  },
}));

import { POST } from './route';

function createRequest(body?: unknown) {
  return new NextRequest('http://localhost:3000/api/admin/refresh-model-aliases', {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

describe('POST /api/admin/refresh-model-aliases', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockAuthenticateApiKey.mockReset();
    mockUpdateModelAliases.mockReset();
    mockUpdateModelAliases.mockResolvedValue(undefined);
  });

  it('returns 401 with no auth', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAuthenticateApiKey.mockResolvedValue(null);

    const res = await POST(createRequest());
    expect(res.status).toBe(401);
  });

  it('returns 403 for non-admin API key', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acc-1', level: 'user' });

    const res = await POST(createRequest());
    expect(res.status).toBe(403);
  });

  it('refreshes aliases with defaults when body is empty', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acc-1', level: 'admin' });

    const res = await POST(createRequest());
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.aliases).toEqual({
      haiku: 'claude-haiku-4-5-20251001',
      sonnet: 'claude-sonnet-4-6',
      opus: 'claude-opus-4-7',
    });
    expect(mockUpdateModelAliases).toHaveBeenCalledTimes(1);
  });

  it('applies custom alias values from body', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acc-1', level: 'admin' });

    const res = await POST(createRequest({ opus: 'claude-opus-4-8' }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.aliases.opus).toBe('claude-opus-4-8');
    expect(data.aliases.sonnet).toBe('claude-sonnet-4-6');
    expect(mockUpdateModelAliases).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ value: 'claude-opus-4-8' }),
      ]),
    );
  });

  it('allows session auth', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockAuthenticateApiKey.mockResolvedValue(null);

    const res = await POST(createRequest());
    expect(res.status).toBe(200);
  });
});
