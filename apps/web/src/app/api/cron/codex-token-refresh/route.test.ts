import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// ── DB mocks ────────────────────────────────────────────────────────────────

const mockSecretsFindMany = mock(() => [] as any[]);

/**
 * Every non-cron_runs insert the route attempts, captured. The route is
 * expected never to add to this — the assertion is on emptiness — so an
 * accidental write shows up as a test failure rather than as silence.
 */
let tasksInsertValues: any[] = [];

/**
 * The cron_runs table stub, shared between the schema mock and the db mock so
 * inserts can be attributed. withCronRun writes a run row through the same
 * `db.insert`, and an untargeted capture counts it as the route's own write.
 */
const CRON_RUNS_TABLE = { id: 'id', job: 'job', startedAt: 'startedAt', alertedAt: 'alertedAt' };

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      secrets: { findMany: mockSecretsFindMany },
    },
    insert: mock((table: any) => ({
      values: mock((vals: any) => {
        if (table === CRON_RUNS_TABLE) return { returning: mock(() => [{ id: 'run-1' }]) };
        tasksInsertValues.push(vals);
        return { returning: mock(() => [{ id: 'task-1', ...vals }]) };
      }),
    })),
    update: mock(() => ({ set: mock(() => ({ where: mock(() => Promise.resolve()) })) })),
    delete: mock(() => ({ where: mock(() => Promise.resolve()) })),
  },
}));

mock.module('drizzle-orm', () => ({
  // Operators withCronRun imports. mock.module is process-global, so a
  // partial stub removes them for every other importer too.
  desc: (a: any) => ({ a, op: 'desc' }),
  gt: (a: any, b: any) => ({ a, b, op: 'gt' }),
  and: (...args: any[]) => args,
  eq: (f: any, v: any) => ({ f, v, type: 'eq' }),
  ne: (f: any, v: any) => ({ f, v, type: 'ne' }),
  or: (...args: any[]) => args,
  lt: (f: any, v: any) => ({ f, v, type: 'lt' }),
  isNotNull: (f: any) => ({ f, type: 'isNotNull' }),
  isNull: (f: any) => ({ f, type: 'isNull' }),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: any[]) => ({ raw: strings.join(''), values }),
    { raw: (s: string) => s },
  ),
  inArray: (f: any, v: any) => ({ f, v, type: 'inArray' }),
}));

mock.module('@buildd/core/db/schema', () => ({
  // withCronRun imports this; mock.module replaces the whole module, so a
  // partial stub deletes the export for every other importer in the process.
  cronRuns: CRON_RUNS_TABLE,
  secrets: 'secrets',
  tasks: 'tasks',
  workspaces: 'workspaces',
}));

// ── Lib mocks ────────────────────────────────────────────────────────────────

const mockVerifyKey = mock((_id: string) => Promise.resolve({ verified: true, error: null }));
const mockRefreshMcp = mock((_id: string) => Promise.resolve('refreshed'));

mock.module('@/lib/anthropic-auth', () => ({ verifyAnthropicApiKey: mockVerifyKey }));
mock.module('@/lib/mcp-connector-refresh', () => ({ refreshMcpConnectorCredential: mockRefreshMcp }));

import { GET } from './route';

function makeRequest(token?: string, vercelCron = false) {
  const headers: Record<string, string> = {};
  if (token) headers['authorization'] = `Bearer ${token}`;
  if (vercelCron) headers['x-vercel-cron'] = '1';
  return new NextRequest('http://localhost/api/cron/codex-token-refresh', { headers });
}

function authedRequest() { return makeRequest('test-secret'); }

const originalEnv = { ...process.env };

describe('GET /api/cron/codex-token-refresh', () => {
  beforeEach(() => {
    mockSecretsFindMany.mockReset();
    mockVerifyKey.mockReset();
    mockRefreshMcp.mockReset();
    process.env.CRON_SECRET = 'test-secret';
    mockSecretsFindMany.mockReturnValue([]);
    mockVerifyKey.mockReturnValue(Promise.resolve({ verified: true, error: null }));
    mockRefreshMcp.mockReturnValue(Promise.resolve('refreshed'));
  });

  afterAll(() => {
    Object.assign(process.env, originalEnv);
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
  });

  it('returns 401 when no authorization header', async () => {
    expect((await GET(makeRequest())).status).toBe(401);
  });

  it('returns 401 when wrong token', async () => {
    expect((await GET(makeRequest('wrong-token'))).status).toBe(401);
  });

  it('returns 500 when CRON_SECRET not configured', async () => {
    delete process.env.CRON_SECRET;
    expect((await GET(makeRequest('anything'))).status).toBe(500);
  });

  it('rejects a platform cron header used in place of the secret', async () => {
    // Platform-native cron does not fire in this project; CRON_SECRET is the single accepted credential.
    expect((await GET(makeRequest(undefined, true))).status).toBe(401);
  });

  it('never selects a stored subscription login', async () => {
    await GET(authedRequest());
    const wheres = mockSecretsFindMany.mock.calls.map(c => JSON.stringify(c[0]?.where ?? null));
    for (const w of wheres) {
      expect(w).not.toContain('claude_credential');
      expect(w).not.toContain('codex_credential');
      expect(w).not.toContain('oauth_token');
    }
  });

  it('refreshes due MCP connector credentials', async () => {
    mockSecretsFindMany.mockReturnValueOnce([{ id: 'mcp-1' }, { id: 'mcp-2' }] as any).mockReturnValue([]);
    mockRefreshMcp.mockImplementation((id: string) => Promise.resolve(id === 'mcp-1' ? 'refreshed' : 'error'));

    const body = await (await GET(authedRequest())).json();

    expect(mockRefreshMcp.mock.calls.map((c) => c[0])).toEqual(['mcp-1', 'mcp-2']);
    expect(body.mcp).toMatchObject({ checked: 2, refreshed: 1, errors: 1 });
  });

  it('sweeps a window that covers its own cron cadence, not 10 minutes', async () => {
    // Regression: a 10-minute lookahead on a 4-hourly cron meant a credential
    // expiring in (10min, 4h] was only ever seen after it had already died.
    await GET(authedRequest());

    const wheres = mockSecretsFindMany.mock.calls.map(c => JSON.stringify(c[0]?.where ?? null));
    const sweep = wheres.find(w => w.includes('1 minute'));
    expect(sweep, 'no query derives its window from the cron cadence').toBeDefined();
    expect(sweep).toContain('300');
  });

  it('includes null-expiry connector credentials in the sweep instead of stranding them', async () => {
    await GET(authedRequest());

    const wheres = mockSecretsFindMany.mock.calls.map(c => JSON.stringify(c[0]?.where ?? null));
    const sweep = wheres.find(w => w.includes('1 minute'));
    expect(sweep).toContain('isNull');
    expect(wheres.some(w => w.includes('isNotNull'))).toBe(false);
  });

  // Agent runs read a team's Anthropic key from canonical storage too, so the
  // liveness ping checks it there; another provider's key, a personal key and a
  // stored subscription login are never pinged.
  it('verifies a team Anthropic API key in either storage, and only those', async () => {
    mockSecretsFindMany.mockImplementation((args: any) => {
      const where = JSON.stringify(args?.where ?? null);
      if (!where.includes('anthropic_api_key')) return [] as any;
      expect(where).toContain('inference_key');
      expect(where).not.toContain('oauth_token');
      return [
        { id: 'seat', purpose: 'oauth_token', label: null, userId: null },
        { id: 'legacy', purpose: 'anthropic_api_key', label: null, userId: null },
        { id: 'canon', purpose: 'inference_key', label: 'anthropic', userId: null },
        { id: 'router', purpose: 'inference_key', label: 'openrouter', userId: null },
        { id: 'mine', purpose: 'inference_key', label: 'anthropic', userId: 'u-1' },
      ] as any;
    });
    const body = await (await GET(authedRequest())).json();
    expect(mockVerifyKey.mock.calls.map((c) => c[0]).sort()).toEqual(['canon', 'legacy']);
    expect(body.apiKeyVerify.checked).toBe(2);
  });
});
