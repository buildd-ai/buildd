import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// Mock functions
const mockGetCurrentUser = mock(() => null as any);
const mockGetUserTeamIds = mock(() => Promise.resolve([] as string[]));
const mockGetUserAdminTeamIds = mock(() => Promise.resolve([] as string[]));
// POST now uses provider.replaceScoped (replace-on-store), not set(null, …).
const mockSecretsReplaceScoped = mock(() => Promise.resolve('secret-1'));
const mockSecretsSet = mock(() => Promise.resolve('secret-1'));
const mockSecretsList = mock(() => Promise.resolve([] as any[]));
const mockSecretsDelete = mock(() => Promise.resolve());

mock.module('@/lib/auth-helpers', () => ({
  getCurrentUser: mockGetCurrentUser,
}));

mock.module('@/lib/team-access', () => ({
  getUserTeamIds: mockGetUserTeamIds,
  getUserAdminTeamIds: mockGetUserAdminTeamIds,
}));

// API-key callers resolve through the shared auth helper.
const mockAccountsFindFirst = mock(() => Promise.resolve(null as any));
mock.module('@/lib/api-auth', () => ({
  authenticateApiKey: (key: string | null) => (key ? mockAccountsFindFirst() : Promise.resolve(null)),
}));

mock.module('@buildd/core/secrets', () => ({
  getSecretsProvider: () => ({
    set: mockSecretsSet,
    replaceScoped: mockSecretsReplaceScoped,
    list: mockSecretsList,
    delete: mockSecretsDelete,
  }),
}));

// POST calls requeueAuthFailedTasks after storing a Claude credential; stub it so
// the test doesn't reach the real DB (it's best-effort/try-caught in the route anyway).
const mockRequeue = mock(() => Promise.resolve({ requeued: [], skippedOverCap: 0 }));
mock.module('@/lib/credential-recovery', () => ({
  requeueAuthFailedTasks: mockRequeue,
}));

import { POST, DELETE, GET } from './route';

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
    mockSecretsReplaceScoped.mockReset();
    mockSecretsSet.mockReset();
    mockSecretsList.mockReset();

    // Default: authenticated user with a team
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockGetUserTeamIds.mockResolvedValue(['team-1']);
    mockGetUserAdminTeamIds.mockReset();
    mockGetUserAdminTeamIds.mockResolvedValue(['team-1']);
    mockSecretsReplaceScoped.mockResolvedValue('secret-1');
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
    expect(mockSecretsReplaceScoped).toHaveBeenCalledWith('dispatch-api-key-value', {
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
      value: 'sk-ant-api03-xxx',
      purpose: 'anthropic_api_key',
      accountId: 'account-1',
    }));
    expect(res.status).toBe(200);
  });

  it('stores a decision_key (OpenRouter) team-wide, quote-stripped, with no prefix rule', async () => {
    const res = await POST(createPostRequest({ value: '"sk-or-v1-abc"', purpose: 'decision_key' }));
    expect(res.status).toBe(200);
    expect(mockSecretsReplaceScoped).toHaveBeenCalledWith('sk-or-v1-abc', expect.objectContaining({
      teamId: 'team-1',
      accountId: undefined,
      purpose: 'decision_key',
    }));
  });

  it('keeps a decision_key team-wide even when stored with an API key, unless accountId is explicit', async () => {
    mockAccountsFindFirst.mockResolvedValue({ id: 'acct-caller', teamId: 'team-1', level: 'admin' });
    const req = (body: any) => new NextRequest('http://localhost:3000/api/secrets', {
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json', authorization: 'Bearer bld_test' }),
      body: JSON.stringify(body),
    });

    await POST(req({ value: 'sk-or-v1-abc', purpose: 'decision_key' }));
    expect((mockSecretsReplaceScoped.mock.calls.at(-1) as any[])[1].accountId).toBeUndefined();

    await POST(req({ value: 'sk-or-v1-abc', purpose: 'decision_key', accountId: 'acct-caller' }));
    expect((mockSecretsReplaceScoped.mock.calls.at(-1) as any[])[1].accountId).toBe('acct-caller');
    mockAccountsFindFirst.mockResolvedValue(null);
  });

  it('keeps an inference_key team-wide when stored with an API key, so it serves every caller', async () => {
    // An account-scoped inference key only reaches callers acting as that
    // account; chat turns and cron judgments act as nobody's account.
    mockAccountsFindFirst.mockResolvedValue({ id: 'acct-caller', teamId: 'team-1', level: 'admin' });
    const res = await POST(new NextRequest('http://localhost:3000/api/secrets', {
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json', authorization: 'Bearer bld_test' }),
      body: JSON.stringify({ value: 'sk-or-v1-abc', purpose: 'inference_key', label: 'openrouter' }),
    }));
    expect(res.status).toBe(200);
    expect((mockSecretsReplaceScoped.mock.calls.at(-1) as any[])[1].accountId).toBeUndefined();
    mockAccountsFindFirst.mockResolvedValue(null);
  });

  it('accepts all valid purpose values', async () => {
    const valueFor: Record<string, string> = {
      anthropic_api_key: 'sk-ant-api03-xxx',
      oauth_token: 'sk-ant-oat01-xxx',
      webhook_token: 'val',
      custom: 'val',
    };
    for (const purpose of ['anthropic_api_key', 'oauth_token', 'webhook_token', 'custom']) {
      mockSecretsReplaceScoped.mockResolvedValue('secret-1');
      const res = await POST(createPostRequest({ value: valueFor[purpose], purpose }));
      expect(res.status).toBe(200);
    }
  });

  it('strips a single pair of wrapping double quotes before storing (the bug fix)', async () => {
    const res = await POST(createPostRequest({
      value: '"sk-ant-oat01-abc123"',
      purpose: 'oauth_token',
    }));
    expect(res.status).toBe(200);
    // Stored value must NOT contain the wrapping quotes.
    expect(mockSecretsReplaceScoped).toHaveBeenCalledWith('sk-ant-oat01-abc123', expect.anything());
  });

  it('strips wrapping single quotes too', async () => {
    const res = await POST(createPostRequest({
      value: "'sk-ant-api03-abc123'",
      purpose: 'anthropic_api_key',
    }));
    expect(res.status).toBe(200);
    expect(mockSecretsReplaceScoped).toHaveBeenCalledWith('sk-ant-api03-abc123', expect.anything());
  });

  it('trims surrounding whitespace before storing', async () => {
    const res = await POST(createPostRequest({
      value: '   sk-ant-oat01-abc123  \n',
      purpose: 'oauth_token',
    }));
    expect(res.status).toBe(200);
    expect(mockSecretsReplaceScoped).toHaveBeenCalledWith('sk-ant-oat01-abc123', expect.anything());
  });

  it('trims and strips quotes together (whitespace outside quotes)', async () => {
    const res = await POST(createPostRequest({
      value: '  "sk-ant-oat01-abc123"  ',
      purpose: 'oauth_token',
    }));
    expect(res.status).toBe(200);
    expect(mockSecretsReplaceScoped).toHaveBeenCalledWith('sk-ant-oat01-abc123', expect.anything());
  });

  it('rejects oauth_token with the wrong prefix (400)', async () => {
    const res = await POST(createPostRequest({
      value: 'sk-ant-api03-wrongkind',
      purpose: 'oauth_token',
    }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('sk-ant-oat');
    expect(mockSecretsReplaceScoped).not.toHaveBeenCalled();
  });

  it('rejects anthropic_api_key with the wrong prefix (400)', async () => {
    const res = await POST(createPostRequest({
      value: 'sk-ant-oat01-wrongkind',
      purpose: 'anthropic_api_key',
    }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('sk-ant-api');
    expect(mockSecretsReplaceScoped).not.toHaveBeenCalled();
  });

  it('rejects a quoted oauth_token whose real prefix is wrong (quotes stripped first)', async () => {
    const res = await POST(createPostRequest({
      value: '"not-a-real-token"',
      purpose: 'oauth_token',
    }));
    expect(res.status).toBe(400);
    expect(mockSecretsReplaceScoped).not.toHaveBeenCalled();
  });

  it('does NOT strip quotes from JSON-blob purposes like claude_credential', async () => {
    const json = '{"access_token":"a","refresh_token":"b"}';
    const res = await POST(createPostRequest({
      value: json,
      purpose: 'claude_credential',
    }));
    expect(res.status).toBe(200);
    // JSON blob stored verbatim (only trimmed) — not quote-stripped.
    expect(mockSecretsReplaceScoped).toHaveBeenCalledWith(json, expect.anything());
  });
});

// A team model key (inference_key / decision_key) at team, workspace or account
// scope pays for — and is read by — every member's chat turn and every decision
// call. Only a team owner/admin (or an admin-level API key) may write or remove
// one, the same bar /api/inference-keys holds for scope 'team'.
describe('team model keys need a team admin', () => {
  const apiReq = (method: 'POST' | 'DELETE', body?: any, qs = '') =>
    new NextRequest(`http://localhost:3000/api/secrets${qs}`, {
      method,
      headers: new Headers({ 'content-type': 'application/json', authorization: 'Bearer bld_test' }),
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockGetUserTeamIds.mockReset();
    mockGetUserAdminTeamIds.mockReset();
    mockSecretsReplaceScoped.mockReset();
    mockSecretsList.mockReset();
    mockSecretsDelete.mockReset();
    mockAccountsFindFirst.mockReset();
    mockAccountsFindFirst.mockResolvedValue(null);
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockGetUserTeamIds.mockResolvedValue(['team-1']);
    mockGetUserAdminTeamIds.mockResolvedValue([]); // a plain member
    mockSecretsReplaceScoped.mockResolvedValue('secret-1');
  });

  for (const [purpose, label] of [['inference_key', 'openrouter'], ['decision_key', undefined]] as const) {
    it(`refuses a member storing a ${purpose}`, async () => {
      const res = await POST(createPostRequest({ value: 'sk-or-v1-abcdefghijklmnop', purpose, label }));
      expect(res.status).toBe(403);
      expect(mockSecretsReplaceScoped).not.toHaveBeenCalled();
    });

    it(`refuses a member storing a workspace-scoped ${purpose}`, async () => {
      const res = await POST(createPostRequest({ value: 'sk-or-v1-abcdefghijklmnop', purpose, label, workspaceId: 'ws-1' }));
      expect(res.status).toBe(403);
      expect(mockSecretsReplaceScoped).not.toHaveBeenCalled();
    });

    it(`refuses a non-admin API key storing a ${purpose}`, async () => {
      mockAccountsFindFirst.mockResolvedValue({ id: 'acct-w', teamId: 'team-1', level: 'worker' });
      const res = await POST(apiReq('POST', { value: 'sk-or-v1-abcdefghijklmnop', purpose, label }));
      expect(res.status).toBe(403);
      expect(mockSecretsReplaceScoped).not.toHaveBeenCalled();
    });

    it(`refuses a member deleting a ${purpose}`, async () => {
      mockSecretsList.mockResolvedValue([{ id: 'sec-team', purpose, teamId: 'team-1' }]);
      const res = await DELETE(new NextRequest('http://localhost:3000/api/secrets?id=sec-team', { method: 'DELETE' }));
      expect(res.status).toBe(403);
      expect(mockSecretsDelete).not.toHaveBeenCalled();
    });
  }

  it('lets a team admin store and delete a team model key', async () => {
    mockGetUserAdminTeamIds.mockResolvedValue(['team-1']);
    const put = await POST(createPostRequest({ value: 'sk-or-v1-abcdefghijklmnop', purpose: 'inference_key', label: 'openrouter' }));
    expect(put.status).toBe(200);
    mockSecretsList.mockResolvedValue([{ id: 'sec-team', purpose: 'inference_key', teamId: 'team-1' }]);
    const del = await DELETE(new NextRequest('http://localhost:3000/api/secrets?id=sec-team', { method: 'DELETE' }));
    expect(del.status).toBe(200);
    expect(mockSecretsDelete).toHaveBeenCalledWith('sec-team');
  });

  it('holds the admin check to the target team, not any team the caller admins', async () => {
    mockGetUserTeamIds.mockResolvedValue(['team-1', 'team-2']);
    mockGetUserAdminTeamIds.mockResolvedValue(['team-2']);
    const res = await POST(createPostRequest({ value: 'sk-or-v1-abcdefghijklmnop', purpose: 'inference_key', label: 'openrouter', teamId: 'team-1' }));
    expect(res.status).toBe(403);
  });

  it('still lets a member store other purposes', async () => {
    const res = await POST(createPostRequest({ value: 'val', purpose: 'custom' }));
    expect(res.status).toBe(200);
  });
});

// Connector and MCP credential lookups read team rows only (user_id IS NULL).
// A userId-scoped row of those purposes would be invisible to them at best and,
// before that filter, mountable as the team's credential — so this route never
// creates one. Personal keys have their own route (/api/inference-keys).
describe('POST /api/secrets never creates a personal row', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockGetUserTeamIds.mockReset();
    mockGetUserAdminTeamIds.mockReset();
    mockSecretsReplaceScoped.mockReset();
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockGetUserTeamIds.mockResolvedValue(['team-1']);
    mockGetUserAdminTeamIds.mockResolvedValue(['team-1']);
    mockSecretsReplaceScoped.mockResolvedValue('secret-1');
  });

  for (const purpose of ['mcp_credential', 'role_env_secret', 'anthropic_api_key', 'oauth_token', 'custom', 'decision_key']) {
    it(`refuses a userId-scoped ${purpose}`, async () => {
      const value = purpose === 'anthropic_api_key' ? 'sk-ant-api-x' : purpose === 'oauth_token' ? 'sk-ant-oat-x' : 'v';
      const res = await POST(createPostRequest({ value, purpose, label: 'GITHUB_TOKEN', userId: 'user-1' }));
      expect(res.status).toBe(400);
      expect(mockSecretsReplaceScoped).not.toHaveBeenCalled();
    });
  }

  it('points a personal inference key at /api/inference-keys instead of storing it here', async () => {
    const res = await POST(createPostRequest({ value: 'sk-or-v1-x', purpose: 'inference_key', label: 'openrouter', userId: 'user-1' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('/api/inference-keys');
    expect(mockSecretsReplaceScoped).not.toHaveBeenCalled();
  });

  it('never forwards a userId to the provider for a team row', async () => {
    const res = await POST(createPostRequest({ value: 'v', purpose: 'mcp_credential', label: 'GITHUB_TOKEN' }));
    expect(res.status).toBe(200);
    const meta = (mockSecretsReplaceScoped.mock.calls[0] as any[])[1];
    expect(meta.userId ?? null).toBeNull();
  });
});

// ── GET: listing is for people and flagged host runner keys only ─────────────

describe('GET /api/secrets — credential custody', () => {
  function listReq(key?: string): NextRequest {
    return new NextRequest('http://localhost:3000/api/secrets', {
      headers: key ? { Authorization: `Bearer ${key}` } : {},
    });
  }

  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockGetUserTeamIds.mockReset();
    mockAccountsFindFirst.mockReset();
    mockSecretsList.mockReset();
    mockSecretsList.mockResolvedValue([{ id: 'secret-1', purpose: 'claude_credential' }]);
  });

  it('lists for a signed-in team member', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockGetUserTeamIds.mockResolvedValue(['team-1']);
    const res = await GET(listReq());
    expect(res.status).toBe(200);
  });

  it('refuses an API key not flagged as a host runner, whatever its level', async () => {
    for (const level of ['worker', 'admin']) {
      mockAccountsFindFirst.mockResolvedValue({ id: 'acct-1', teamId: 'team-1', level, hostRunner: false });
      const res = await GET(listReq('bld_runner_key'));
      expect(res.status).toBe(403);
    }
    expect(mockSecretsList).not.toHaveBeenCalled();
  });

  it('lists for a flagged host runner key', async () => {
    mockAccountsFindFirst.mockResolvedValue({ id: 'acct-1', teamId: 'team-1', level: 'worker', hostRunner: true });
    const res = await GET(listReq('bld_runner_key'));
    expect(res.status).toBe(200);
  });

  it("lists for a person's OAuth session", async () => {
    mockAccountsFindFirst.mockResolvedValue({ id: 'acct-1', teamId: 'team-1', level: 'admin', hostRunner: false, sessionUserId: 'user-1' });
    const res = await GET(listReq('eyJ.a.b'));
    expect(res.status).toBe(200);
  });

  it('refuses a per-task token even when it resolves to a flagged account', async () => {
    mockAccountsFindFirst.mockResolvedValue({ id: 'acct-1', teamId: 'team-1', level: 'worker', hostRunner: true });
    const res = await GET(listReq('bldt_payload.sig'));
    expect(res.status).toBe(403);
    expect(mockSecretsList).not.toHaveBeenCalled();
  });

  it('does not fall back to the browser session for a rejected per-task token', async () => {
    mockAccountsFindFirst.mockResolvedValue(null);
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockGetUserTeamIds.mockResolvedValue(['team-1']);
    const res = await GET(listReq('bldt_payload.sig'));
    expect(res.status).toBe(401);
    expect(mockSecretsList).not.toHaveBeenCalled();
  });
});

// Cloudflare API token for the cloud runner: a JSON blob, validated before it
// is encrypted, stored team-wide, and only by a team owner/admin (it can deploy
// code to the team's Cloudflare account).
describe('POST /api/secrets (cloudflare_token)', () => {
  const ACCOUNT = '0123456789abcdef0123456789abcdef';
  const TOKEN = 'cf_test_token_not_real_000000000000000000';

  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockGetUserTeamIds.mockReset();
    mockGetUserAdminTeamIds.mockReset();
    mockSecretsReplaceScoped.mockReset();
    mockAccountsFindFirst.mockReset();
    mockAccountsFindFirst.mockResolvedValue(null);
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockGetUserTeamIds.mockResolvedValue(['team-1']);
    mockGetUserAdminTeamIds.mockResolvedValue(['team-1']);
    mockSecretsReplaceScoped.mockResolvedValue('secret-cf');
  });

  it('stores a normalized JSON value team-wide', async () => {
    const value = JSON.stringify({ apiToken: ` "${TOKEN}" `, accountId: ACCOUNT, aiGatewayId: 'buildd', junk: 1 });
    const res = await POST(createPostRequest({ value, purpose: 'cloudflare_token' }));
    expect(res.status).toBe(200);
    const [stored, meta] = mockSecretsReplaceScoped.mock.calls[0] as any[];
    expect(JSON.parse(stored)).toEqual({ apiToken: TOKEN, accountId: ACCOUNT, aiGatewayId: 'buildd' });
    expect(meta).toMatchObject({ teamId: 'team-1', purpose: 'cloudflare_token' });
    expect(meta.accountId ?? null).toBeNull();
    expect(meta.workspaceId ?? null).toBeNull();
  });

  it('does not echo the token in the response', async () => {
    const res = await POST(createPostRequest({ value: JSON.stringify({ apiToken: TOKEN, accountId: ACCOUNT }), purpose: 'cloudflare_token' }));
    expect(JSON.stringify(await res.json())).not.toContain(TOKEN);
  });

  it('rejects an invalid value without storing it', async () => {
    const res = await POST(createPostRequest({ value: JSON.stringify({ apiToken: TOKEN, accountId: 'nope' }), purpose: 'cloudflare_token' }));
    expect(res.status).toBe(400);
    expect(mockSecretsReplaceScoped).not.toHaveBeenCalled();
  });

  it('refuses a workspace-scoped row', async () => {
    const res = await POST(createPostRequest({ value: JSON.stringify({ apiToken: TOKEN, accountId: ACCOUNT }), purpose: 'cloudflare_token', workspaceId: 'ws-1' }));
    expect(res.status).toBe(400);
    expect(mockSecretsReplaceScoped).not.toHaveBeenCalled();
  });

  it('refuses a non-admin team member', async () => {
    mockGetUserAdminTeamIds.mockResolvedValue([]);
    const res = await POST(createPostRequest({ value: JSON.stringify({ apiToken: TOKEN, accountId: ACCOUNT }), purpose: 'cloudflare_token' }));
    expect(res.status).toBe(403);
    expect(mockSecretsReplaceScoped).not.toHaveBeenCalled();
  });

  it('refuses a worker-level API key', async () => {
    mockAccountsFindFirst.mockResolvedValue({ id: 'acct-w', teamId: 'team-1', level: 'worker' });
    const req = new NextRequest('http://localhost:3000/api/secrets', {
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json', authorization: 'Bearer bld_x' }),
      body: JSON.stringify({ value: JSON.stringify({ apiToken: TOKEN, accountId: ACCOUNT }), purpose: 'cloudflare_token' }),
    });
    const res = await POST(req);
    expect(res.status).toBe(403);
  });
});

describe('DELETE /api/secrets (cloudflare_token)', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockGetUserTeamIds.mockReset();
    mockGetUserAdminTeamIds.mockReset();
    mockSecretsList.mockReset();
    mockSecretsDelete.mockReset();
    mockAccountsFindFirst.mockReset();
    mockAccountsFindFirst.mockResolvedValue(null);
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockGetUserTeamIds.mockResolvedValue(['team-1']);
    mockSecretsList.mockResolvedValue([{ id: 'sec-cf', purpose: 'cloudflare_token' }]);
  });

  it('refuses a non-admin member', async () => {
    mockGetUserAdminTeamIds.mockResolvedValue([]);
    const res = await DELETE(new NextRequest('http://localhost:3000/api/secrets?id=sec-cf', { method: 'DELETE' }));
    expect(res.status).toBe(403);
    expect(mockSecretsDelete).not.toHaveBeenCalled();
  });

  it('lets a team admin delete it', async () => {
    mockGetUserAdminTeamIds.mockResolvedValue(['team-1']);
    const res = await DELETE(new NextRequest('http://localhost:3000/api/secrets?id=sec-cf', { method: 'DELETE' }));
    expect(res.status).toBe(200);
    expect(mockSecretsDelete).toHaveBeenCalledWith('sec-cf');
  });
});
