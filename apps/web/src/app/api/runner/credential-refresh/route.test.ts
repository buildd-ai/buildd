import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// ── mock setup (before any imports that trigger module loading) ───────────────

const mockAuthenticateApiKey = mock(() => Promise.resolve(null as any));

// Innermost returning mock so tests can control what the UPDATE...RETURNING yields.
const mockDbUpdateReturning = mock(() => Promise.resolve([]));

// db.query.secrets.findFirst mock (used for commit + revoke + bootstrap)
const mockDbFindFirst = mock(() => Promise.resolve(null as any));

// db.query.credentialLeases.findFirst mock (used for bootstrap lease check)
const mockDbLeaseFindFirst = mock(() => Promise.resolve(null as any));

mock.module('@/lib/api-auth', () => ({
  authenticateApiKey: mockAuthenticateApiKey,
}));

mock.module('@buildd/core/db', () => ({
  db: {
    update: () => ({
      set: () => ({
        where: () => ({ returning: mockDbUpdateReturning }),
      }),
    }),
    query: {
      secrets: {
        findFirst: mockDbFindFirst,
      },
      credentialLeases: {
        findFirst: mockDbLeaseFindFirst,
      },
    },
  },
}));

const mockEncrypt = mock((val: string) => `enc:${val}`);
const mockDecrypt = mock((val: string) => val.replace(/^enc:/, ''));

mock.module('@buildd/core/secrets', () => ({
  encrypt: mockEncrypt,
  decrypt: mockDecrypt,
}));

mock.module('@buildd/core/db/schema', () => ({
  secrets: {
    id: 'id',
    purpose: 'purpose',
    lastRefreshedAt: 'last_refreshed_at',
    healthStatus: 'health_status',
    teamId: 'team_id',
  },
  credentialLeases: {
    credentialId: 'credential_id',
    heldByRunnerId: 'held_by_runner_id',
    expiresAt: 'expires_at',
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (f: any, v: any) => ({ __eq: { f, v } }),
  and: (...c: any[]) => ({ __and: c }),
  or: (...c: any[]) => ({ __or: c }),
  isNull: (f: any) => ({ __isNull: f }),
  lt: (f: any, v: any) => ({ __lt: { f, v } }),
  gt: (f: any, v: any) => ({ __gt: { f, v } }),
  // sql is a tagged template literal: sql`NOW()` → sql(['NOW()'])
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: any[]) => ({ __sql: strings.raw.join('') }),
    { raw: (s: string) => ({ __raw: s }) },
  ),
}));

const mockRecordCredentialAuthSuccess = mock(() => Promise.resolve());
const mockRecordCredentialAuthFailure = mock(() =>
  Promise.resolve({ newStatus: 'revoked', becameRevoked: true, secretId: 'secret-1' }),
);

mock.module('@/lib/credential-health', () => ({
  recordCredentialAuthSuccess: mockRecordCredentialAuthSuccess,
  recordCredentialAuthFailure: mockRecordCredentialAuthFailure,
}));

const mockNotifyTeam = mock(() => Promise.resolve());

mock.module('@/lib/notify', () => ({
  notifyTeam: mockNotifyTeam,
}));

// ── imports (after mocks) ─────────────────────────────────────────────────────

import { POST } from './route';

// ── helpers ───────────────────────────────────────────────────────────────────

function makeReq(body: Record<string, unknown>, withAuth = true): NextRequest {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (withAuth) headers['Authorization'] = 'Bearer bld_test_key';
  return new NextRequest('http://localhost:3000/api/runner/credential-refresh', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

const BASE = { secretId: 'secret-1', purpose: 'claude_credential' };

// ── tests ─────────────────────────────────────────────────────────────────────

describe('POST /api/runner/credential-refresh', () => {
  beforeEach(() => {
    mockAuthenticateApiKey.mockReset();
    mockDbUpdateReturning.mockReset();
    mockDbFindFirst.mockReset();
    mockDbLeaseFindFirst.mockReset();
    mockEncrypt.mockReset();
    mockDecrypt.mockReset();
    mockRecordCredentialAuthSuccess.mockReset();
    mockRecordCredentialAuthFailure.mockReset();
    mockNotifyTeam.mockReset();

    // Default: authenticated runner
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acct-1', teamId: 'team-1', level: 'worker' });
    mockEncrypt.mockImplementation((val: string) => `enc:${val}`);
    mockDecrypt.mockImplementation((val: string) => val.replace(/^enc:/, ''));
    mockRecordCredentialAuthFailure.mockResolvedValue({
      newStatus: 'revoked',
      becameRevoked: true,
      secretId: 'secret-1',
    });
    mockDbUpdateReturning.mockResolvedValue([]);
  });

  // ── auth ───────────────────────────────────────────────────────────────────

  it('returns 401 when no API key provided', async () => {
    mockAuthenticateApiKey.mockResolvedValue(null);
    const res = await POST(makeReq({ ...BASE, action: 'lock' }, false));
    expect(res.status).toBe(401);
  });

  it('returns 401 when API key is invalid', async () => {
    mockAuthenticateApiKey.mockResolvedValue(null);
    const res = await POST(makeReq({ ...BASE, action: 'lock' }));
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error).toBeDefined();
  });

  // ── purpose validation ─────────────────────────────────────────────────────

  it('returns 400 for a disallowed purpose', async () => {
    const res = await POST(makeReq({ ...BASE, action: 'lock', purpose: 'mcp_connector_credential' }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('purpose');
  });

  it('accepts claude_credential purpose', async () => {
    mockDbUpdateReturning.mockResolvedValue([{
      encryptedValue: 'enc:{"access_token":"at","refresh_token":"rt"}',
      tokenExpiresAt: null,
    }]);
    const res = await POST(makeReq({ secretId: 'secret-1', action: 'lock', purpose: 'claude_credential' }));
    expect(res.status).toBe(200);
  });

  it('accepts codex_credential purpose', async () => {
    mockDbUpdateReturning.mockResolvedValue([{
      encryptedValue: 'enc:{"access_token":"at","refresh_token":"rt","account_id":"acc1"}',
      tokenExpiresAt: null,
    }]);
    const res = await POST(makeReq({ secretId: 'secret-1', action: 'lock', purpose: 'codex_credential' }));
    expect(res.status).toBe(200);
  });

  // ── lock ───────────────────────────────────────────────────────────────────

  describe('action=lock', () => {
    it('returns locked:true with refreshToken when lock is acquired', async () => {
      const blob = { access_token: 'old-at', refresh_token: 'old-rt' };
      mockDbUpdateReturning.mockResolvedValue([{
        encryptedValue: `enc:${JSON.stringify(blob)}`,
        tokenExpiresAt: new Date('2026-09-01T00:00:00.000Z'),
      }]);

      const res = await POST(makeReq({ ...BASE, action: 'lock' }));
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.locked).toBe(true);
      expect(data.refreshToken).toBe('old-rt');
      expect(data.expiresAt).toBe('2026-09-01T00:00:00.000Z');
    });

    it('never exposes accessToken in lock response', async () => {
      const blob = { access_token: 'secret-at', refresh_token: 'rt' };
      mockDbUpdateReturning.mockResolvedValue([{
        encryptedValue: `enc:${JSON.stringify(blob)}`,
        tokenExpiresAt: null,
      }]);

      const res = await POST(makeReq({ ...BASE, action: 'lock' }));
      const data = await res.json();
      expect(data.locked).toBe(true);
      expect(data.accessToken).toBeUndefined();
    });

    it('returns locked:false when lock is already held (double-lock)', async () => {
      mockDbUpdateReturning.mockResolvedValue([]); // no row → lock held by another caller

      const res = await POST(makeReq({ ...BASE, action: 'lock' }));
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.locked).toBe(false);
    });

    it('returns expiresAt:null when tokenExpiresAt is null', async () => {
      mockDbUpdateReturning.mockResolvedValue([{
        encryptedValue: 'enc:{"access_token":"at","refresh_token":"rt"}',
        tokenExpiresAt: null,
      }]);

      const res = await POST(makeReq({ ...BASE, action: 'lock' }));
      const data = await res.json();
      expect(data.expiresAt).toBeNull();
    });
  });

  // ── commit ─────────────────────────────────────────────────────────────────

  describe('action=commit', () => {
    it('returns ok:true and calls recordCredentialAuthSuccess on success', async () => {
      const existingBlob = { access_token: 'old-at', refresh_token: 'old-rt' };
      mockDbFindFirst.mockResolvedValue({
        encryptedValue: `enc:${JSON.stringify(existingBlob)}`,
      });

      const res = await POST(makeReq({
        ...BASE,
        action: 'commit',
        accessToken: 'new-at',
        refreshToken: 'new-rt',
        expiresAt: '2026-10-01T00:00:00.000Z',
      }));
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(mockRecordCredentialAuthSuccess).toHaveBeenCalledWith('secret-1');
    });

    it('returns 404 when secret not found on commit', async () => {
      mockDbFindFirst.mockResolvedValue(null);
      const res = await POST(makeReq({
        ...BASE,
        action: 'commit',
        accessToken: 'new-at',
        refreshToken: 'new-rt',
      }));
      expect(res.status).toBe(404);
      expect(mockRecordCredentialAuthSuccess).not.toHaveBeenCalled();
    });

    it('merges new tokens into existing blob (preserves extra fields for codex)', async () => {
      const existingBlob = { access_token: 'old-at', refresh_token: 'old-rt', account_id: 'acc1', id_token: 'idt' };
      mockDbFindFirst.mockResolvedValue({
        encryptedValue: `enc:${JSON.stringify(existingBlob)}`,
      });

      await POST(makeReq({
        secretId: 'secret-1',
        purpose: 'codex_credential',
        action: 'commit',
        accessToken: 'new-at',
        refreshToken: 'new-rt',
      }));

      expect(mockEncrypt).toHaveBeenCalled();
      const encryptedArg = mockEncrypt.mock.calls[0][0];
      const merged = JSON.parse(encryptedArg);
      expect(merged.access_token).toBe('new-at');
      expect(merged.refresh_token).toBe('new-rt');
      expect(merged.account_id).toBe('acc1');
      expect(merged.id_token).toBe('idt');
    });
  });

  // ── revoke ─────────────────────────────────────────────────────────────────

  describe('action=revoke', () => {
    it('returns ok:true on success', async () => {
      mockDbFindFirst.mockResolvedValue({ healthStatus: 'degraded', teamId: 'team-1' });
      const res = await POST(makeReq({ ...BASE, action: 'revoke' }));
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
    });

    it('calls recordCredentialAuthFailure with secretId and reason', async () => {
      mockDbFindFirst.mockResolvedValue({ healthStatus: 'healthy', teamId: 'team-1' });
      await POST(makeReq({ ...BASE, action: 'revoke', reason: 'HTTP 401' }));
      expect(mockRecordCredentialAuthFailure).toHaveBeenCalledWith('secret-1', 'HTTP 401');
    });

    it('fires notifyTeam on first revocation (was not already revoked)', async () => {
      mockDbFindFirst.mockResolvedValue({ healthStatus: 'healthy', teamId: 'team-1' });
      await POST(makeReq({ ...BASE, action: 'revoke' }));
      expect(mockNotifyTeam).toHaveBeenCalledTimes(1);
      expect(mockNotifyTeam.mock.calls[0][0]).toBe('team-1');
      expect(mockNotifyTeam.mock.calls[0][1]).toBe('credentialExpired');
    });

    it('does NOT fire notifyTeam when already revoked', async () => {
      mockDbFindFirst.mockResolvedValue({ healthStatus: 'revoked', teamId: 'team-1' });
      await POST(makeReq({ ...BASE, action: 'revoke' }));
      expect(mockNotifyTeam).not.toHaveBeenCalled();
    });

    it('returns 404 when secret not found on revoke', async () => {
      mockDbFindFirst.mockResolvedValue(null);
      const res = await POST(makeReq({ ...BASE, action: 'revoke' }));
      expect(res.status).toBe(404);
      expect(mockRecordCredentialAuthFailure).not.toHaveBeenCalled();
    });
  });

  // ── bootstrap ──────────────────────────────────────────────────────────────

  describe('action=bootstrap', () => {
    const RUNNER_ID = 'runner-host-1';

    it('returns accessToken, refreshToken, and expiresAt when runner holds active lease', async () => {
      mockDbLeaseFindFirst.mockResolvedValue({ id: 'lease-uuid-1' });
      const blob = { access_token: 'at-live', refresh_token: 'rt-live' };
      mockDbFindFirst.mockResolvedValue({
        encryptedValue: `enc:${JSON.stringify(blob)}`,
        tokenExpiresAt: new Date('2026-10-01T00:00:00.000Z'),
      });

      const res = await POST(makeReq({ ...BASE, action: 'bootstrap', runnerId: RUNNER_ID }));
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.accessToken).toBe('at-live');
      expect(data.refreshToken).toBe('rt-live');
      expect(data.expiresAt).toBe('2026-10-01T00:00:00.000Z');
    });

    it('returns expiresAt:null when tokenExpiresAt is null', async () => {
      mockDbLeaseFindFirst.mockResolvedValue({ id: 'lease-uuid-1' });
      mockDbFindFirst.mockResolvedValue({
        encryptedValue: 'enc:{"access_token":"at","refresh_token":"rt"}',
        tokenExpiresAt: null,
      });

      const res = await POST(makeReq({ ...BASE, action: 'bootstrap', runnerId: RUNNER_ID }));
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.expiresAt).toBeNull();
    });

    it('returns null accessToken/refreshToken when blob fields are missing', async () => {
      mockDbLeaseFindFirst.mockResolvedValue({ id: 'lease-uuid-1' });
      mockDbFindFirst.mockResolvedValue({
        encryptedValue: 'enc:{}',
        tokenExpiresAt: null,
      });

      const res = await POST(makeReq({ ...BASE, action: 'bootstrap', runnerId: RUNNER_ID }));
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.accessToken).toBeNull();
      expect(data.refreshToken).toBeNull();
    });

    it('returns 403 when runner does not hold the active lease', async () => {
      mockDbLeaseFindFirst.mockResolvedValue(null); // no matching lease row

      const res = await POST(makeReq({ ...BASE, action: 'bootstrap', runnerId: RUNNER_ID }));
      expect(res.status).toBe(403);
      const data = await res.json();
      expect(data.error).toContain('lease');
    });

    it('returns 404 when credential not found after lease check', async () => {
      mockDbLeaseFindFirst.mockResolvedValue({ id: 'lease-uuid-1' });
      mockDbFindFirst.mockResolvedValue(null); // secret missing

      const res = await POST(makeReq({ ...BASE, action: 'bootstrap', runnerId: RUNNER_ID }));
      expect(res.status).toBe(404);
    });

    it('returns 400 when runnerId is missing', async () => {
      const res = await POST(makeReq({ ...BASE, action: 'bootstrap' }));
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain('runnerId');
    });
  });

  // ── unknown action ─────────────────────────────────────────────────────────

  it('returns 400 for an unknown action', async () => {
    const res = await POST(makeReq({ ...BASE, action: 'unknown' }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('action');
  });
});
