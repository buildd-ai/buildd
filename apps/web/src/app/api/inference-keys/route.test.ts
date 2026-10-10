import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockRequireSessionUser = mock(async () => ({ user: { id: 'u-1' } }) as any);
const mockGetUserTeamIds = mock(async () => ['t-1'] as string[]);
// The caller's team roles and the team's permission overrides, read by the
// real permission check (lib/permissions.ts) through this db mock.
let roles: Record<string, string> = {};
let overrides: Record<string, unknown> | null = null;
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      teamMembers: { findMany: async () => Object.entries(roles).map(([teamId, role]) => ({ teamId, role })) },
      teams: { findFirst: async () => ({ id: 'not-a-personal-team', permissionOverrides: overrides }) },
    },
  },
}));
const mockResolveActiveTeamId = mock(async (_u: string, cookie: string | null) => cookie ?? 't-1');
const mockList = mock(async (teamId: string, userId: string, canManage: boolean) => ({
  teamId, canManageTeamKeys: canManage, providers: [], _userId: userId,
}));
const mockSet = mock(async (_input: any) => ({
  ok: true, key: { id: 's-1', provider: 'openrouter', scope: 'user', last4: 'abcd', health: 'healthy' },
}) as any);
const mockDelete = mock(async (_input: any) => true);

const mockResolveChatModel = mock(async (_opts: any) => ({ ok: false, reason: 'no_key' }) as any);
mock.module('@/lib/chat/models', () => ({ resolveChatModel: mockResolveChatModel }));
mock.module('@/lib/auth-helpers', () => ({ requireSessionUser: mockRequireSessionUser }));
mock.module('@/lib/team-access', () => ({
  getUserTeamIds: mockGetUserTeamIds,
  resolveActiveTeamId: mockResolveActiveTeamId,
}));
mock.module('@/lib/provider-keys', () => ({
  listProviderKeys: mockList,
  setProviderKey: mockSet,
  deleteProviderKey: mockDelete,
}));
const mockRequeue = mock(async (_teamId: string) => ({ requeued: ['task-a'] as string[], skippedOverCap: 0 }));
mock.module('@/lib/credential-recovery', () => ({ requeueAuthFailedTasks: mockRequeue }));

/** A value each provider's team key accepts (agent-read keys keep their legacy prefix). */
const KEY: Record<string, string> = {
  anthropic: 'sk-ant-api03-example-key-for-tests',
  openai: 'sk-proj-example-key-for-tests',
  openrouter: 'sk-or-v1-example-key-for-tests',
};

const { GET, PUT, DELETE } = await import('./route');

function req(method: string, url: string, body?: unknown) {
  return new NextRequest(`http://localhost:3000${url}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

beforeEach(() => {
  mockRequireSessionUser.mockReset();
  mockRequireSessionUser.mockResolvedValue({ user: { id: 'u-1' } });
  mockGetUserTeamIds.mockReset();
  mockGetUserTeamIds.mockResolvedValue(['t-1']);
  roles = {}; overrides = null;
  mockSet.mockClear();
  mockDelete.mockClear();
  mockList.mockClear();
  mockRequeue.mockClear();
  mockResolveChatModel.mockReset();
  mockResolveChatModel.mockResolvedValue({ ok: false, reason: 'no_key' });
});

describe('auth', () => {
  it('refuses API keys and anonymous callers — a personal key needs a person', async () => {
    const denied = new Response('{}', { status: 403 });
    mockRequireSessionUser.mockResolvedValue({ response: denied });
    expect((await GET(req('GET', '/api/inference-keys'))).status).toBe(403);
    expect(mockList).not.toHaveBeenCalled();
  });

  it('404s a team the caller is not in', async () => {
    const res = await GET(req('GET', '/api/inference-keys?teamId=t-other'));
    expect(res.status).toBe(404);
  });
});

describe('GET', () => {
  it('lists for the caller, telling it whether it can manage team keys', async () => {
    roles = { ['t-1']: 'admin' };
    const res = await GET(req('GET', '/api/inference-keys?teamId=t-1'));
    expect(res.status).toBe(200);
    expect(mockList).toHaveBeenCalledWith('t-1', 'u-1', true);
  });

  it('with no teamId, uses the active team from the buildd-team cookie, not the first membership', async () => {
    mockGetUserTeamIds.mockResolvedValue(['t-1', 't-2']);
    const r = new NextRequest('http://localhost:3000/api/inference-keys', { headers: { cookie: 'buildd-team=t-2' } });
    await GET(r);
    expect(mockList.mock.calls.at(-1)![0]).toBe('t-2');
  });

  it('members get canManageTeamKeys false', async () => {
    await GET(req('GET', '/api/inference-keys'));
    expect(mockList).toHaveBeenCalledWith('t-1', 'u-1', false);
  });
});

describe('GET chatUses: the provider and scope chat actually resolves to', () => {
  it('reports the resolved provider and whose key, for the caller', async () => {
    mockResolveChatModel.mockResolvedValue({ ok: true, provider: 'anthropic', keyScope: 'team', modelId: 'm', tier: 'standard' });
    const json = await (await GET(req('GET', '/api/inference-keys?teamId=t-1'))).json();
    expect(json.chatUses).toEqual({ provider: 'anthropic', scope: 'team' });
    expect(mockResolveChatModel.mock.calls[0][0]).toMatchObject({ teamId: 't-1', userId: 'u-1', workspaceId: null });
  });

  it('carries a personal key and a gateway route through', async () => {
    mockResolveChatModel.mockResolvedValue({ ok: true, provider: 'openai', keyScope: 'user', modelId: 'm', tier: 'standard' });
    expect((await (await GET(req('GET', '/api/inference-keys'))).json()).chatUses).toEqual({ provider: 'openai', scope: 'user' });
    mockResolveChatModel.mockResolvedValue({ ok: true, provider: 'anthropic', keyScope: 'team', via: 'litellm', modelId: 'm', tier: 'standard' });
    expect((await (await GET(req('GET', '/api/inference-keys'))).json()).chatUses).toEqual({ provider: 'anthropic', scope: 'team', via: 'litellm' });
  });

  it('is null when nothing resolves or the lookup throws, and the list still returns', async () => {
    expect((await (await GET(req('GET', '/api/inference-keys'))).json()).chatUses).toBeNull();
    mockResolveChatModel.mockRejectedValue(new Error('boom'));
    const res = await GET(req('GET', '/api/inference-keys'));
    expect(res.status).toBe(200);
    expect((await res.json()).chatUses).toBeNull();
  });
});

describe('PUT', () => {
  const body = { teamId: 't-1', provider: 'openrouter', scope: 'user', value: 'sk-or-v1-0123456789abcdef' };

  it('any member can set their own key', async () => {
    const res = await PUT(req('PUT', '/api/inference-keys', body));
    expect(res.status).toBe(200);
    expect(mockSet).toHaveBeenCalledWith({ ...body, userId: 'u-1' });
    const json = await res.json();
    expect(JSON.stringify(json)).not.toContain(body.value);
  });

  it('a member cannot set the team key', async () => {
    const res = await PUT(req('PUT', '/api/inference-keys', { ...body, scope: 'team' }));
    expect(res.status).toBe(403);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('an admin can set the team key', async () => {
    roles = { ['t-1']: 'admin' };
    const res = await PUT(req('PUT', '/api/inference-keys', { ...body, scope: 'team' }));
    expect(res.status).toBe(200);
    expect(mockSet.mock.calls[0][0].scope).toBe('team');
  });

  it('rejects an unknown provider, a workspace scope, and a missing value', async () => {
    expect((await PUT(req('PUT', '/api/inference-keys', { ...body, provider: 'openai-codex' }))).status).toBe(400);
    expect((await PUT(req('PUT', '/api/inference-keys', { ...body, scope: 'workspace' }))).status).toBe(400);
    expect((await PUT(req('PUT', '/api/inference-keys', { ...body, value: '  ' }))).status).toBe(400);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('passes the lib\'s refusal through (e.g. the provider rejected the key)', async () => {
    mockSet.mockResolvedValueOnce({ ok: false, status: 400, error: 'The provider rejected this key.' });
    const res = await PUT(req('PUT', '/api/inference-keys', body));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('rejected');
  });
});

describe('DELETE', () => {
  it('any member can delete their own key', async () => {
    const res = await DELETE(req('DELETE', '/api/inference-keys?teamId=t-1&provider=openai&scope=user'));
    expect(res.status).toBe(200);
    expect(mockDelete).toHaveBeenCalledWith({ teamId: 't-1', userId: 'u-1', provider: 'openai', scope: 'user' });
    expect(await res.json()).toEqual({ deleted: true });
  });

  it('a member cannot delete the team key', async () => {
    const res = await DELETE(req('DELETE', '/api/inference-keys?provider=openai&scope=team'));
    expect(res.status).toBe(403);
    expect(mockDelete).not.toHaveBeenCalled();
  });
});

describe('provider-symmetric authorization', () => {
  for (const provider of ['anthropic', 'openai', 'openrouter']) {
    it(`${provider}: members own their keys, admins manage team keys`, async () => {
      const body = { teamId: 't-1', provider, value: KEY[provider], scope: 'user' };
      expect((await PUT(req('PUT', '/api/inference-keys', body))).status).toBe(200);
      expect(mockSet.mock.calls.at(-1)![0]).toMatchObject({ provider, userId: 'u-1', scope: 'user' });
      expect((await PUT(req('PUT', '/api/inference-keys', { ...body, scope: 'team' }))).status).toBe(403);
      expect((await DELETE(req('DELETE', `/api/inference-keys?provider=${provider}&scope=team`))).status).toBe(403);
      roles = { ['t-1']: 'admin' };
      expect((await PUT(req('PUT', '/api/inference-keys', { ...body, scope: 'team' }))).status).toBe(200);
      expect((await DELETE(req('DELETE', `/api/inference-keys?provider=${provider}&scope=team`))).status).toBe(200);
    });
  }
  it('a chat-only team key follows the team permission overrides for manage_inference_providers', async () => {
    const body = { teamId: 't-1', provider: 'openrouter', value: KEY.openrouter, scope: 'team' };
    roles = { ['t-1']: 'admin' };
    overrides = { manage_inference_providers: ['owner'] };
    expect((await PUT(req('PUT', '/api/inference-keys', body))).status).toBe(403);
    expect((await DELETE(req('DELETE', '/api/inference-keys?teamId=t-1&provider=openrouter&scope=team'))).status).toBe(403);
    expect(mockSet).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
    await GET(req('GET', '/api/inference-keys?teamId=t-1'));
    expect(mockList).toHaveBeenLastCalledWith('t-1', 'u-1', false);

    roles = { ['t-1']: 'member' };
    overrides = { manage_inference_providers: ['owner', 'admin', 'member'] };
    expect((await PUT(req('PUT', '/api/inference-keys', body))).status).toBe(200);
    expect(mockSet.mock.calls.at(-1)![0]).toMatchObject({ teamId: 't-1', scope: 'team' });
    expect((await DELETE(req('DELETE', '/api/inference-keys?teamId=t-1&provider=openrouter&scope=team'))).status).toBe(200);
    expect(mockDelete).toHaveBeenCalledWith({ teamId: 't-1', userId: 'u-1', provider: 'openrouter', scope: 'team' });
    await GET(req('GET', '/api/inference-keys?teamId=t-1'));
    expect(mockList).toHaveBeenLastCalledWith('t-1', 'u-1', true);
    // A chat-only key is not an agent credential: nothing is re-queued.
    expect(mockRequeue).not.toHaveBeenCalled();
  });
});

// A team Anthropic or OpenAI key is read by agent runs as well as chat, so
// this route holds it to the same rule as /api/providers: both
// manage_team_model_keys and manage_team_credentials, the legacy alias's
// prefix, and auth-failed tasks re-queued once it is stored.
describe('a team key agent runs read', () => {
  for (const provider of ['anthropic', 'openai']) {
    it(`${provider}: manage_inference_providers without manage_team_credentials is refused, and nothing is written`, async () => {
      roles = { ['t-1']: 'member' };
      overrides = { manage_inference_providers: ['owner', 'admin', 'member'], manage_team_model_keys: ['owner', 'admin', 'member'] };
      const body = { teamId: 't-1', provider, value: KEY[provider], scope: 'team' };
      expect((await PUT(req('PUT', '/api/inference-keys', body))).status).toBe(403);
      expect((await DELETE(req('DELETE', `/api/inference-keys?teamId=t-1&provider=${provider}&scope=team`))).status).toBe(403);
      expect(mockSet).not.toHaveBeenCalled();
      expect(mockDelete).not.toHaveBeenCalled();
      expect(mockRequeue).not.toHaveBeenCalled();
    });

    it(`${provider}: manage_team_credentials without manage_team_model_keys is refused too`, async () => {
      roles = { ['t-1']: 'member' };
      overrides = { manage_inference_providers: ['owner', 'admin', 'member'], manage_team_credentials: ['owner', 'admin', 'member'] };
      const body = { teamId: 't-1', provider, value: KEY[provider], scope: 'team' };
      expect((await PUT(req('PUT', '/api/inference-keys', body))).status).toBe(403);
      expect(mockSet).not.toHaveBeenCalled();
    });

    it(`${provider}: both permissions write it and re-queue auth-failed tasks, without manage_inference_providers`, async () => {
      roles = { ['t-1']: 'member' };
      overrides = { manage_inference_providers: ['owner'], manage_team_model_keys: ['owner', 'admin', 'member'], manage_team_credentials: ['owner', 'admin', 'member'] };
      const body = { teamId: 't-1', provider, value: KEY[provider], scope: 'team' };
      const res = await PUT(req('PUT', '/api/inference-keys', body));
      expect(res.status).toBe(200);
      expect(mockSet).toHaveBeenCalledWith({ ...body, userId: 'u-1' });
      expect(mockRequeue).toHaveBeenCalledWith('t-1');
      expect((await res.json()).requeued).toBe(1);
      expect((await DELETE(req('DELETE', `/api/inference-keys?teamId=t-1&provider=${provider}&scope=team`))).status).toBe(200);
      expect(mockDelete).toHaveBeenCalledWith({ teamId: 't-1', userId: 'u-1', provider, scope: 'team' });
    });
  }

  it('a pasted subscription token is refused as the team Anthropic key, and nothing is written', async () => {
    roles = { ['t-1']: 'admin' };
    const res = await PUT(req('PUT', '/api/inference-keys', { teamId: 't-1', provider: 'anthropic', value: 'sk-ant-oat01-not-an-api-key', scope: 'team' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('sk-ant-api');
    expect(mockSet).not.toHaveBeenCalled();
    expect(mockRequeue).not.toHaveBeenCalled();
  });

  it('the prefix rule is for the team key only: a personal key is checked by the key lib as before', async () => {
    const res = await PUT(req('PUT', '/api/inference-keys', { teamId: 't-1', provider: 'openai', value: 'example-personal-key', scope: 'user' }));
    expect(res.status).toBe(200);
    expect(mockRequeue).not.toHaveBeenCalled();
  });
});

describe('gateways', () => {

  it('excludes team gateways from the standalone personal key API', async () => {
    expect((await PUT(req('PUT', '/api/inference-keys', { provider: 'litellm', scope: 'user', value: 'example-key' }))).status).toBe(400);
    expect(mockSet).not.toHaveBeenCalled();
    expect((await DELETE(req('DELETE', '/api/inference-keys?provider=litellm&scope=user'))).status).toBe(400);
    expect(mockDelete).not.toHaveBeenCalled();
  });
});
