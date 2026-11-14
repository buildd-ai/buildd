import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const TEAM = '11111111-1111-4111-8111-111111111111';
const mockRequireSessionUser = mock(async () => ({ user: { id: 'u-1' } }) as any);
const mockGetUserTeamIds = mock(async () => [TEAM] as string[]);
let canManage = true;
let stored: unknown = null;
const writes: unknown[] = [];
let available: Record<string, string | null> = {};

mock.module('@buildd/core/db', () => ({
  db: {
    update: () => ({ set: (v: any) => { writes.push(v.subscriptionWallFallback); return { where: async () => {} }; } }),
  },
}));
mock.module('@/lib/auth-helpers', () => ({ requireSessionUser: mockRequireSessionUser }));
mock.module('@/lib/team-access', () => ({ getUserTeamIds: mockGetUserTeamIds }));
mock.module('@/lib/permissions', () => ({ can: async () => canManage }));
mock.module('@/lib/subscription-fallback', () => ({
  WALL_FALLBACK_LABELS: { anthropic: "the team's Anthropic API key", openrouter: "the team's OpenRouter key", litellm: "the team's LiteLLM gateway", endpoint: "the team's agent model endpoint" },
  loadWallFallbackSetting: async () => {
    const s = stored as any;
    return s && s.fallback ? { fallback: s.fallback, maxCostPerDayUsd: s.maxCostPerDayUsd ?? null } : { fallback: 'wait', maxCostPerDayUsd: null };
  },
  wallFallbackSpentToday: async () => 2.5,
  resolveWallFallbackCredential: async ({ served }: { served: string }) => (served in available
    ? { served, label: 'x', last4: available[served] } : null),
}));

const { GET, PUT } = await import('./route');
const ctx = (id = TEAM) => ({ params: Promise.resolve({ id }) });
const url = `http://localhost:3000/api/teams/${TEAM}/wall-fallback`;
const put = (body: unknown) => new NextRequest(url, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

beforeEach(() => {
  canManage = true;
  stored = null;
  writes.length = 0;
  available = { anthropic: 'wxyz' };
  mockGetUserTeamIds.mockResolvedValue([TEAM]);
});

describe('GET /api/teams/[id]/wall-fallback', () => {
  it('defaults to wait, and names what each fallback would use (last four only)', async () => {
    const res = await GET(new NextRequest(url), ctx());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.setting).toEqual({ fallback: 'wait', maxCostPerDayUsd: null });
    expect(body.spentTodayUsd).toBe(2.5);
    expect(body.canManage).toBe(true);
    expect(body.options).toEqual([
      { id: 'anthropic', label: "the team's Anthropic API key", available: true, last4: 'wxyz' },
      { id: 'openrouter', label: "the team's OpenRouter key", available: false, last4: null },
      { id: 'litellm', label: "the team's LiteLLM gateway", available: false, last4: null },
      { id: 'endpoint', label: "the team's agent model endpoint", available: false, last4: null },
    ]);
    expect(JSON.stringify(body)).not.toContain('sk-');
  });

  it('is 404 for a team the caller is not in', async () => {
    mockGetUserTeamIds.mockResolvedValue([]);
    expect((await GET(new NextRequest(url), ctx())).status).toBe(404);
  });
});

describe('PUT /api/teams/[id]/wall-fallback', () => {
  it('saves a fallback with a usable credential and a cap', async () => {
    const res = await PUT(put({ fallback: 'anthropic', maxCostPerDayUsd: 15 }), ctx());
    expect(res.status).toBe(200);
    expect(writes).toEqual([{ fallback: 'anthropic', maxCostPerDayUsd: 15 }]);
  });

  it('refuses a fallback with no usable credential', async () => {
    const res = await PUT(put({ fallback: 'openrouter' }), ctx());
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("the team's OpenRouter key");
    expect(writes).toEqual([]);
  });

  it('stores wait as null, the default', async () => {
    const res = await PUT(put({ fallback: 'wait' }), ctx());
    expect(res.status).toBe(200);
    expect(writes).toEqual([null]);
  });

  it('refuses a bad cap and an unknown choice', async () => {
    expect((await PUT(put({ fallback: 'anthropic', maxCostPerDayUsd: -3 }), ctx())).status).toBe(400);
    expect((await PUT(put({ fallback: 'gemini' }), ctx())).status).toBe(400);
    expect(writes).toEqual([]);
  });

  it('is 403 without manage_team_settings', async () => {
    canManage = false;
    expect((await PUT(put({ fallback: 'anthropic' }), ctx())).status).toBe(403);
    expect(writes).toEqual([]);
  });
});
