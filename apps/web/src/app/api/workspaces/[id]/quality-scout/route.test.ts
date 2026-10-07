import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';

let apiAccount: { teamId: string } | null = null;
let user: { id: string } | null = null;
let access = true;
let ownerTeam = 'team-1';
const triggerCalls: unknown[] = [];
let rate: { allowed: boolean; retryAfterSec?: number } = { allowed: true };
const dismissCalls: unknown[] = [];
let dismissResult: Record<string, unknown> = { status: 'dismissed', followUp: null, taskId: null };

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
  checkManualScoutRateLimit: async () => rate,
  triggerQualityScout: async (input: unknown) => {
    triggerCalls.push(input);
    return { status: 'skipped', reason: 'duplicate', runId: 'r' };
  },
}));

mock.module('@/lib/quality-scout-actions', () => ({
  dismissQualityScoutFinding: async (input: unknown) => {
    dismissCalls.push(input);
    return dismissResult;
  },
}));

const { GET, PATCH, POST } = await import('./route');
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
  rate = { allowed: true };
  dismissCalls.length = 0;
  dismissResult = { status: 'dismissed', followUp: null, taskId: null };
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

  it('POST is rate limited per workspace beyond the double-tap bucket: 429 with Retry-After, no run', async () => {
    rate = { allowed: false, retryAfterSec: 600 };
    const res = await POST(req('POST'), params);
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('600');
    expect(triggerCalls).toHaveLength(0);
  });

  it('POST refuses a short SHA', async () => {
    expect((await POST(req('POST', { sha: 'abc123' }), params)).status).toBe(400);
    expect(triggerCalls).toHaveLength(0);
  });

  describe('PATCH — dismiss a finding', () => {
    const body = { signature: 'sig-1', reason: 'expected in staging' };

    it('401 without auth, 404 for a workspace the caller cannot reach; nothing is dismissed', async () => {
      user = null;
      expect((await PATCH(req('PATCH', body), params)).status).toBe(401);
      user = { id: 'u-1' };
      access = false;
      expect((await PATCH(req('PATCH', body), params)).status).toBe(404);
      user = null;
      apiAccount = { teamId: 'other-team' };
      expect((await PATCH(req('PATCH', body), params)).status).toBe(404);
      expect(dismissCalls).toHaveLength(0);
    });

    it('dismisses, scoped to the workspace, recording the signed-in person', async () => {
      const res = await PATCH(req('PATCH', body), params);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ status: 'dismissed' });
      expect(dismissCalls).toEqual([{ workspaceId: 'ws-1', signature: 'sig-1', reason: 'expected in staging', by: 'user:u-1' }]);
    });

    it('an API key is recorded as its account', async () => {
      user = null;
      apiAccount = { teamId: 'team-1', id: 'acct-1' } as { teamId: string };
      await PATCH(req('PATCH', body), params);
      expect(dismissCalls[0]).toMatchObject({ by: 'account:acct-1' });
    });

    it('400 without a signature or a reason', async () => {
      expect((await PATCH(req('PATCH', { reason: 'x' }), params)).status).toBe(400);
      dismissResult = { status: 'invalid', error: 'reason_required' };
      expect((await PATCH(req('PATCH', { signature: 'sig-1' }), params)).status).toBe(400);
    });

    it('404 for an unknown finding; an already-dismissed one is answered as-is', async () => {
      dismissResult = { status: 'not_found' };
      expect((await PATCH(req('PATCH', body), params)).status).toBe(404);
      dismissResult = { status: 'already_dismissed' };
      const res = await PATCH(req('PATCH', body), params);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: 'already_dismissed' });
    });
  });
});
