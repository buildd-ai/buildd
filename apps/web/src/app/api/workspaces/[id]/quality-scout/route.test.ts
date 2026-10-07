import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';

let apiAccount: { teamId: string } | null = null;
let user: { id: string } | null = null;
let access = true;
let ownerTeam = 'team-1';
const triggerCalls: unknown[] = [];

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: async () => user }));
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: async () => apiAccount }));
mock.module('@/lib/team-access', () => ({ verifyWorkspaceAccess: async () => access }));
mock.module('@buildd/core/db', () => ({
  db: { query: { workspaces: { findFirst: async () => ({ teamId: ownerTeam }) } } },
}));
mock.module('@/lib/quality-scout-readout', () => ({
  loadScoutReadout: async (id: string, opts: { mode: string }) => ({ workspaceId: id, mode: opts.mode, refs: [] }),
}));
mock.module('@/lib/quality-scout-trigger', () => ({
  loadScoutWorkspace: async (id: string) => ({ id, teamId: 'team-1', gitConfig: { qualityScout: { mode: 'shadow' } }, githubRepo: null }),
  resolveScoutTriggerConfig: (raw: { mode?: string } | undefined) => ({ mode: raw?.mode ?? 'off' }),
  serverHeadSha: async () => null,
  triggerQualityScout: async (input: unknown) => {
    triggerCalls.push(input);
    return { status: 'skipped', reason: 'duplicate', runId: 'r' };
  },
}));

const { GET, POST } = await import('./route');
const params = { params: Promise.resolve({ id: 'ws-1' }) };
const req = (method: string, body?: unknown) =>
  new NextRequest('http://localhost/api/workspaces/ws-1/quality-scout', {
    method,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

beforeEach(() => {
  apiAccount = null;
  user = { id: 'u-1' };
  access = true;
  ownerTeam = 'team-1';
  triggerCalls.length = 0;
});

describe('/api/workspaces/[id]/quality-scout', () => {
  it('401 without auth', async () => {
    user = null;
    expect((await GET(req('GET'), params)).status).toBe(401);
    expect((await POST(req('POST'), params)).status).toBe(401);
  });

  it('404 for a workspace the caller cannot reach', async () => {
    access = false;
    expect((await GET(req('GET'), params)).status).toBe(404);
    user = null;
    apiAccount = { teamId: 'other-team' };
    expect((await POST(req('POST'), params)).status).toBe(404);
    expect(triggerCalls).toHaveLength(0);
  });

  it('GET returns the readout with the workspace mode', async () => {
    const res = await GET(req('GET'), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ workspaceId: 'ws-1', mode: 'shadow' });
  });

  it('POST starts a manual run on the requested ref/SHA', async () => {
    const sha = 'A'.repeat(40);
    const res = await POST(req('POST', { ref: 'release/1', sha }), params);
    expect(res.status).toBe(200);
    expect(triggerCalls[0]).toEqual({ workspaceId: 'ws-1', trigger: 'manual', ref: 'release/1', sha: sha.toLowerCase() });
  });

  it('POST with no body runs the default branch head', async () => {
    await POST(req('POST'), params);
    expect(triggerCalls[0]).toEqual({ workspaceId: 'ws-1', trigger: 'manual', ref: null, sha: null });
  });

  it('POST refuses a short SHA', async () => {
    expect((await POST(req('POST', { sha: 'abc123' }), params)).status).toBe(400);
    expect(triggerCalls).toHaveLength(0);
  });
});
