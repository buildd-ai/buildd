import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// ── DB mocks ────────────────────────────────────────────────────────────────

const mockLeaseFindMany = mock(() => [] as any[]);
let leaseDeleteWhereCalls: any[] = [];

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      credentialLeases: { findMany: mockLeaseFindMany },
    },
    delete: mock((_table: any) => ({
      where: mock((cond: any) => {
        leaseDeleteWhereCalls.push(cond);
        return Promise.resolve();
      }),
    })),
  },
}));

mock.module('drizzle-orm', () => ({
  lt: (f: any, v: any) => ({ f, v, type: 'lt' }),
  eq: (f: any, v: any) => ({ f, v, type: 'eq' }),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: any[]) => ({ raw: strings.join(''), values }),
    { raw: (s: string) => s },
  ),
}));

mock.module('@buildd/core/db/schema', () => ({
  credentialLeases: {
    id: 'id',
    expiresAt: 'expires_at',
    heldByRunnerId: 'held_by_runner_id',
    credentialId: 'credential_id',
  },
}));

// ── Lib mocks ────────────────────────────────────────────────────────────────

const mockRefreshClaude = mock((_id: string) => Promise.resolve('refreshed' as string));
const mockRefreshCodex = mock((_id: string) => Promise.resolve('refreshed' as string));
const mockNotifyTeam = mock((_teamId: string, _event: string, _opts: any) => Promise.resolve());

mock.module('@/lib/claude-credential', () => ({ refreshClaudeCredential: mockRefreshClaude }));
mock.module('@/lib/codex-credential', () => ({ refreshCodexCredential: mockRefreshCodex }));
mock.module('@/lib/notify', () => ({ notifyTeam: mockNotifyTeam }));

import { GET } from './route';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeRequest(token?: string, vercelCron = false): NextRequest {
  const headers: Record<string, string> = {};
  if (token) headers['authorization'] = `Bearer ${token}`;
  if (vercelCron) headers['x-vercel-cron'] = '1';
  return new NextRequest('http://localhost/api/cron/lease-expiry-guard', { headers });
}

const TEAM_ID = 'team-uuid-0001';
const CRED_CLAUDE = { id: 'cred-claude-1', teamId: TEAM_ID, purpose: 'claude_credential' };
const CRED_CODEX  = { id: 'cred-codex-1',  teamId: TEAM_ID, purpose: 'codex_credential' };

function makeExpiredLease(id: string, credential: typeof CRED_CLAUDE, runnerId = 'runner-1') {
  return { id, credentialId: credential.id, heldByRunnerId: runnerId, credential };
}

const originalEnv = { ...process.env };

beforeEach(() => {
  mockLeaseFindMany.mockReset();
  leaseDeleteWhereCalls = [];
  mockRefreshClaude.mockReset();
  mockRefreshCodex.mockReset();
  mockNotifyTeam.mockReset();
  mockNotifyTeam.mockImplementation(() => Promise.resolve());

  // Default: return refreshed
  mockRefreshClaude.mockImplementation(() => Promise.resolve('refreshed'));
  mockRefreshCodex.mockImplementation(() => Promise.resolve('refreshed'));

  process.env.CRON_SECRET = 'test-secret';
  process.env.NEXT_PUBLIC_APP_URL = 'https://buildd.dev';
  delete process.env.BUILDD_ALLOW_CONTROL_PLANE_REFRESH;
});

afterEach(() => {
  process.env = { ...originalEnv };
});

// ── Auth ─────────────────────────────────────────────────────────────────────

describe('GET /api/cron/lease-expiry-guard — auth', () => {
  it('returns 500 when CRON_SECRET is not configured', async () => {
    delete process.env.CRON_SECRET;
    const res = await GET(makeRequest());
    expect(res.status).toBe(500);
  });

  it('returns 401 for wrong CRON_SECRET', async () => {
    const res = await GET(makeRequest('wrong-secret'));
    expect(res.status).toBe(401);
  });

  it('accepts x-vercel-cron: 1 without Bearer token', async () => {
    mockLeaseFindMany.mockImplementation(() => []);
    const res = await GET(makeRequest(undefined, true));
    expect(res.status).toBe(200);
  });

  it('accepts valid CRON_SECRET', async () => {
    mockLeaseFindMany.mockImplementation(() => []);
    const res = await GET(makeRequest('test-secret'));
    expect(res.status).toBe(200);
  });
});

// ── No expired leases ─────────────────────────────────────────────────────────

describe('GET /api/cron/lease-expiry-guard — no expired leases', () => {
  it('returns summary with 0 alerted when no leases have expired', async () => {
    mockLeaseFindMany.mockImplementation(() => []);
    const res = await GET(makeRequest('test-secret'));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.checked).toBe(0);
    expect(body.alerted).toBe(0);
    expect(mockNotifyTeam.mock.calls.length).toBe(0);
    expect(leaseDeleteWhereCalls.length).toBe(0);
  });
});

// ── Expired claude_credential ────────────────────────────────────────────────

describe('GET /api/cron/lease-expiry-guard — expired claude_credential', () => {
  it('alerts the team and deletes the expired lease', async () => {
    const lease = makeExpiredLease('lease-1', CRED_CLAUDE);
    mockLeaseFindMany.mockImplementation(() => [lease]);

    const res = await GET(makeRequest('test-secret'));
    expect(res.status).toBe(200);

    const body = await res.json() as any;
    expect(body.checked).toBe(1);
    expect(body.alerted).toBe(1);

    // Should have notified the team
    expect(mockNotifyTeam.mock.calls.length).toBe(1);
    const [teamId, event] = mockNotifyTeam.mock.calls[0];
    expect(teamId).toBe(TEAM_ID);
    expect(event).toBe('credentialExpired');

    // Should have deleted the lease
    expect(leaseDeleteWhereCalls.length).toBe(1);
  });

  it('does NOT call refreshClaudeCredential when ALLOW_CONTROL_PLANE_REFRESH is off', async () => {
    const lease = makeExpiredLease('lease-1', CRED_CLAUDE);
    mockLeaseFindMany.mockImplementation(() => [lease]);

    await GET(makeRequest('test-secret'));
    expect(mockRefreshClaude.mock.calls.length).toBe(0);
  });

  it('response does not include refreshed/refreshErrors when flag is off', async () => {
    mockLeaseFindMany.mockImplementation(() => [makeExpiredLease('lease-1', CRED_CLAUDE)]);
    const res = await GET(makeRequest('test-secret'));
    const body = await res.json() as any;
    expect(body.refreshed).toBeUndefined();
    expect(body.refreshErrors).toBeUndefined();
  });
});

// ── Expired codex_credential ─────────────────────────────────────────────────

describe('GET /api/cron/lease-expiry-guard — expired codex_credential', () => {
  it('alerts the team and deletes the lease', async () => {
    const lease = makeExpiredLease('lease-2', CRED_CODEX);
    mockLeaseFindMany.mockImplementation(() => [lease]);

    const res = await GET(makeRequest('test-secret'));
    expect(res.status).toBe(200);

    const body = await res.json() as any;
    expect(body.checked).toBe(1);
    expect(body.alerted).toBe(1);
    expect(mockNotifyTeam.mock.calls.length).toBe(1);
    expect(leaseDeleteWhereCalls.length).toBe(1);
  });
});

// ── Multiple expired leases ──────────────────────────────────────────────────

describe('GET /api/cron/lease-expiry-guard — multiple expired leases', () => {
  it('alerts once per credential and deletes all expired leases', async () => {
    mockLeaseFindMany.mockImplementation(() => [
      makeExpiredLease('lease-1', CRED_CLAUDE),
      makeExpiredLease('lease-2', CRED_CODEX),
    ]);

    const res = await GET(makeRequest('test-secret'));
    const body = await res.json() as any;
    expect(body.checked).toBe(2);
    expect(body.alerted).toBe(2);
    expect(mockNotifyTeam.mock.calls.length).toBe(2);
    expect(leaseDeleteWhereCalls.length).toBe(2);
  });
});

// ── Fallback refresh (opt-in) ────────────────────────────────────────────────

describe('GET /api/cron/lease-expiry-guard — BUILDD_ALLOW_CONTROL_PLANE_REFRESH=true', () => {
  beforeEach(() => {
    process.env.BUILDD_ALLOW_CONTROL_PLANE_REFRESH = 'true';
  });

  it('calls refreshClaudeCredential for claude_credential lease', async () => {
    mockLeaseFindMany.mockImplementation(() => [makeExpiredLease('lease-1', CRED_CLAUDE)]);
    const res = await GET(makeRequest('test-secret'));
    expect(res.status).toBe(200);
    expect(mockRefreshClaude.mock.calls.length).toBe(1);
    expect(mockRefreshClaude.mock.calls[0][0]).toBe(CRED_CLAUDE.id);
  });

  it('calls refreshCodexCredential for codex_credential lease', async () => {
    mockLeaseFindMany.mockImplementation(() => [makeExpiredLease('lease-2', CRED_CODEX)]);
    const res = await GET(makeRequest('test-secret'));
    expect(mockRefreshCodex.mock.calls.length).toBe(1);
    expect(mockRefreshCodex.mock.calls[0][0]).toBe(CRED_CODEX.id);
  });

  it('includes refreshed count in response when flag is on', async () => {
    mockLeaseFindMany.mockImplementation(() => [makeExpiredLease('lease-1', CRED_CLAUDE)]);
    mockRefreshClaude.mockImplementation(() => Promise.resolve('refreshed'));
    const res = await GET(makeRequest('test-secret'));
    const body = await res.json() as any;
    expect(body.refreshed).toBe(1);
    expect(body.refreshErrors).toBe(0);
  });

  it('counts non-refreshed outcome as refreshError', async () => {
    mockLeaseFindMany.mockImplementation(() => [makeExpiredLease('lease-1', CRED_CLAUDE)]);
    mockRefreshClaude.mockImplementation(() => Promise.resolve('error'));
    const res = await GET(makeRequest('test-secret'));
    const body = await res.json() as any;
    expect(body.refreshed).toBe(0);
    expect(body.refreshErrors).toBe(1);
  });

  it('still alerts the team even when fallback refresh succeeds', async () => {
    mockLeaseFindMany.mockImplementation(() => [makeExpiredLease('lease-1', CRED_CLAUDE)]);
    mockRefreshClaude.mockImplementation(() => Promise.resolve('refreshed'));
    await GET(makeRequest('test-secret'));
    expect(mockNotifyTeam.mock.calls.length).toBe(1);
  });

  it('still deletes the expired lease after fallback refresh', async () => {
    mockLeaseFindMany.mockImplementation(() => [makeExpiredLease('lease-1', CRED_CLAUDE)]);
    await GET(makeRequest('test-secret'));
    expect(leaseDeleteWhereCalls.length).toBe(1);
  });
});

// ── Details in response ───────────────────────────────────────────────────────

describe('GET /api/cron/lease-expiry-guard — response details', () => {
  it('includes credentialId key in details with runnerId and purpose', async () => {
    const lease = makeExpiredLease('lease-1', CRED_CLAUDE, 'crashed-runner');
    mockLeaseFindMany.mockImplementation(() => [lease]);
    const res = await GET(makeRequest('test-secret'));
    const body = await res.json() as any;
    expect(body.details[CRED_CLAUDE.id]).toBeDefined();
    expect(body.details[CRED_CLAUDE.id].runnerId).toBe('crashed-runner');
    expect(body.details[CRED_CLAUDE.id].purpose).toBe('claude_credential');
  });
});
