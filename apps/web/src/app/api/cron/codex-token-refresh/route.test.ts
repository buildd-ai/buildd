import { describe, it, expect, beforeEach, afterEach, afterAll, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// ── DB mocks ────────────────────────────────────────────────────────────────

const mockSecretsFindMany = mock(() => [] as any[]);
const mockTasksFindFirst = mock(() => null as any);
const mockWorkspacesFindFirst = mock(() => ({ id: 'ws-1' }) as any);

let tasksInsertValues: any[] = [];
let tasksInsertError: Error | null = null;

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      secrets: { findMany: mockSecretsFindMany },
      tasks: { findFirst: mockTasksFindFirst },
      workspaces: { findFirst: mockWorkspacesFindFirst },
    },
    insert: mock((_table: any) => ({
      values: mock((vals: any) => {
        tasksInsertValues.push(vals);
        if (tasksInsertError) throw tasksInsertError;
        return { returning: mock(() => [{ id: 'task-1', ...vals }]) };
      }),
    })),
  },
}));

mock.module('drizzle-orm', () => ({
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
  secrets: 'secrets',
  tasks: 'tasks',
  workspaces: 'workspaces',
}));

// ── Lib mocks ────────────────────────────────────────────────────────────────

const mockRefreshCodex = mock((_id: string) => Promise.resolve('refreshed'));
const mockRefreshClaude = mock((_id: string) => Promise.resolve('refreshed'));
const mockVerifyClaude = mock((_id: string) => Promise.resolve({ verified: true, error: null }));
const mockRefreshMcp = mock((_id: string) => Promise.resolve('refreshed'));
const mockRecordSuccess = mock((_id: string) => Promise.resolve());
const mockNotifyTeam = mock((_teamId: string, _event: string, _opts: any) => Promise.resolve());

mock.module('@/lib/codex-credential', () => ({ refreshCodexCredential: mockRefreshCodex }));
mock.module('@/lib/claude-credential', () => ({
  refreshClaudeCredential: mockRefreshClaude,
  verifyClaudeCredential: mockVerifyClaude,
}));
mock.module('@/lib/mcp-connector-refresh', () => ({ refreshMcpConnectorCredential: mockRefreshMcp }));
mock.module('@/lib/credential-health', () => ({ recordCredentialAuthSuccess: mockRecordSuccess }));
mock.module('@/lib/notify', () => ({ notifyTeam: mockNotifyTeam }));

import { GET } from './route';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeRequest(token?: string, vercelCron = false) {
  const headers: Record<string, string> = {};
  if (token) headers['authorization'] = `Bearer ${token}`;
  if (vercelCron) headers['x-vercel-cron'] = '1';
  return new NextRequest('http://localhost/api/cron/codex-token-refresh', { headers });
}

function authedRequest() { return makeRequest('test-secret'); }

const originalEnv = { ...process.env };

// ── Tests ────────────────────────────────────────────────────────────────────

describe('GET /api/cron/codex-token-refresh', () => {
  beforeEach(() => {
    // Reset mocks
    mockSecretsFindMany.mockReset();
    mockTasksFindFirst.mockReset();
    mockWorkspacesFindFirst.mockReset();
    mockRefreshCodex.mockReset();
    mockRefreshClaude.mockReset();
    mockVerifyClaude.mockReset();
    mockRefreshMcp.mockReset();
    mockRecordSuccess.mockReset();
    mockNotifyTeam.mockReset();
    tasksInsertValues = [];
    tasksInsertError = null;

    // Defaults
    process.env.CRON_SECRET = 'test-secret';
    delete process.env.BUILDD_ALLOW_CONTROL_PLANE_REFRESH;

    // Default: no secrets, no tasks, workspace exists
    mockSecretsFindMany.mockReturnValue([]);
    mockTasksFindFirst.mockReturnValue(null);
    mockWorkspacesFindFirst.mockReturnValue({ id: 'ws-1' });
    mockVerifyClaude.mockReturnValue(Promise.resolve({ verified: true, error: null }));
    mockRefreshMcp.mockReturnValue(Promise.resolve('refreshed'));
  });

  afterAll(() => {
    Object.assign(process.env, originalEnv);
    // Clean up keys not in originalEnv
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
  });

  // ── Auth ──────────────────────────────────────────────────────────────────

  it('returns 401 when no authorization header', async () => {
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
  });

  it('returns 401 when wrong token', async () => {
    const res = await GET(makeRequest('wrong-token'));
    expect(res.status).toBe(401);
  });

  it('returns 500 when CRON_SECRET not configured', async () => {
    delete process.env.CRON_SECRET;
    const res = await GET(makeRequest('anything'));
    expect(res.status).toBe(500);
  });

  it('accepts Vercel cron header without CRON_SECRET check', async () => {
    const res = await GET(makeRequest(undefined, true));
    expect(res.status).toBe(200);
  });

  // ── Nudge mode (default) ──────────────────────────────────────────────────

  it('nudgeMode=true when BUILDD_ALLOW_CONTROL_PLANE_REFRESH is unset', async () => {
    const res = await GET(authedRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.nudgeMode).toBe(true);
    expect(body.nudgedCredentials).toBe(0);
  });

  it('creates nudge task for expiring codex credential', async () => {
    mockSecretsFindMany.mockReturnValueOnce([
      { id: 'sec-1', teamId: 'team-1', workspaceId: 'ws-1' },
    ]).mockReturnValue([]);

    const res = await GET(authedRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.nudgeMode).toBe(true);
    expect(body.nudgedCredentials).toBe(1);
    expect(body.codex.nudged).toBe(1);
    expect(body.codex.deduped).toBe(0);
    expect(tasksInsertValues).toHaveLength(1);
    expect(tasksInsertValues[0].title).toBe('[sys] refresh credential sec-1');
    expect(tasksInsertValues[0].priority).toBe(50);
    expect(tasksInsertValues[0].tier).toBe('budget');
    expect(tasksInsertValues[0].outputRequirement).toBe('none');
  });

  it('creates nudge task for expiring claude credential', async () => {
    // First findMany call (codex) returns empty, second (claude) returns one
    mockSecretsFindMany
      .mockReturnValueOnce([])  // codex expiring
      .mockReturnValueOnce([{ id: 'sec-2', teamId: 'team-1', workspaceId: 'ws-1' }])  // claude expiring
      .mockReturnValue([]);  // zombie and verify queries

    const res = await GET(authedRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.nudgedCredentials).toBe(1);
    expect(body.claudeRefresh.nudged).toBe(1);
    expect(tasksInsertValues[0].title).toBe('[sys] refresh credential sec-2');
    expect(tasksInsertValues[0].description).toContain('claude_credential');
  });

  it('deduplicates: skips task creation if pending task already exists', async () => {
    mockSecretsFindMany.mockReturnValueOnce([
      { id: 'sec-1', teamId: 'team-1', workspaceId: 'ws-1' },
    ]).mockReturnValue([]);
    mockTasksFindFirst.mockReturnValue({ id: 'existing-task' });

    const res = await GET(authedRequest());
    const body = await res.json();
    expect(body.codex.nudged).toBe(0);
    expect(body.codex.deduped).toBe(1);
    expect(tasksInsertValues).toHaveLength(0);
  });

  it('resolves workspace from team when credential workspaceId is null', async () => {
    mockSecretsFindMany.mockReturnValueOnce([
      { id: 'sec-1', teamId: 'team-1', workspaceId: null },
    ]).mockReturnValue([]);
    mockWorkspacesFindFirst.mockReturnValue({ id: 'resolved-ws' });

    const res = await GET(authedRequest());
    const body = await res.json();
    expect(body.codex.nudged).toBe(1);
    expect(tasksInsertValues[0].workspaceId).toBe('resolved-ws');
  });

  it('records no_workspace result when no workspace found for team', async () => {
    mockSecretsFindMany.mockReturnValueOnce([
      { id: 'sec-1', teamId: 'team-1', workspaceId: null },
    ]).mockReturnValue([]);
    mockWorkspacesFindFirst.mockReturnValue(null);

    const res = await GET(authedRequest());
    const body = await res.json();
    expect(body.codex.nudged).toBe(0);
    expect(body.codex.secrets['sec-1']).toBe('no_workspace');
    expect(tasksInsertValues).toHaveLength(0);
  });

  it('does not call refreshCodexCredential or refreshClaudeCredential in nudge mode', async () => {
    mockSecretsFindMany.mockReturnValueOnce([
      { id: 'sec-1', teamId: 'team-1', workspaceId: 'ws-1' },
    ]).mockReturnValue([]);

    await GET(authedRequest());
    expect(mockRefreshCodex).not.toHaveBeenCalled();
    expect(mockRefreshClaude).not.toHaveBeenCalled();
  });

  // ── Direct mode (BUILDD_ALLOW_CONTROL_PLANE_REFRESH=true) ─────────────────

  it('nudgeMode=false when BUILDD_ALLOW_CONTROL_PLANE_REFRESH=true', async () => {
    process.env.BUILDD_ALLOW_CONTROL_PLANE_REFRESH = 'true';
    const res = await GET(authedRequest());
    const body = await res.json();
    expect(body.nudgeMode).toBe(false);
    expect(body.nudgedCredentials).toBe(0);
  });

  it('calls refreshCodexCredential in direct mode', async () => {
    process.env.BUILDD_ALLOW_CONTROL_PLANE_REFRESH = 'true';
    mockSecretsFindMany.mockReturnValueOnce([
      { id: 'sec-1', teamId: 'team-1', workspaceId: 'ws-1' },
    ]).mockReturnValue([]);
    mockRefreshCodex.mockReturnValue(Promise.resolve('refreshed'));

    const res = await GET(authedRequest());
    const body = await res.json();
    expect(body.codex.refreshed).toBe(1);
    expect(mockRefreshCodex).toHaveBeenCalledWith('sec-1');
    expect(tasksInsertValues).toHaveLength(0);
  });

  it('calls refreshClaudeCredential in direct mode', async () => {
    process.env.BUILDD_ALLOW_CONTROL_PLANE_REFRESH = 'true';
    mockSecretsFindMany
      .mockReturnValueOnce([])  // codex expiring
      .mockReturnValueOnce([{ id: 'sec-2', teamId: 'team-1', workspaceId: 'ws-1' }])  // claude expiring
      .mockReturnValue([]);
    mockRefreshClaude.mockReturnValue(Promise.resolve('refreshed'));

    const res = await GET(authedRequest());
    const body = await res.json();
    expect(body.claudeRefresh.refreshed).toBe(1);
    expect(mockRefreshClaude).toHaveBeenCalledWith('sec-2');
  });

  // ── Response shape ────────────────────────────────────────────────────────

  it('always runs MCP refresh regardless of mode', async () => {
    // nudge mode — MCP is not affected
    mockSecretsFindMany.mockReturnValue([]).mockReturnValueOnce([]).mockReturnValueOnce([])
      .mockReturnValueOnce([]).mockReturnValueOnce([{ id: 'mcp-1' }]).mockReturnValue([]);
    mockRefreshMcp.mockReturnValue(Promise.resolve('refreshed'));

    const res = await GET(authedRequest());
    const body = await res.json();
    expect(body.mcp).toBeDefined();
  });

  it('sweeps a window that covers its own cron cadence, not 10 minutes', async () => {
    // Regression: a 10-minute lookahead on a 4-hourly cron meant a credential
    // expiring in (10min, 4h] was only ever seen after it had already died.
    mockSecretsFindMany.mockReturnValue([]);

    await GET(authedRequest());

    const wheres = mockSecretsFindMany.mock.calls.map(c => JSON.stringify(c[0]?.where ?? null));
    const sweep = wheres.find(w => w.includes("1 minute"));
    expect(sweep, 'no query derives its window from the cron cadence').toBeDefined();
    expect(sweep).toContain('300');
  });

  it('includes null-expiry credentials in the sweep instead of stranding them', async () => {
    // A NULL tokenExpiresAt is where the refresher parks a credential it marked
    // dead, and where an AS that omits expires_in leaves one. isNotNull() meant
    // neither was ever retried — a manual reconnect was the only way out.
    mockSecretsFindMany.mockReturnValue([]);

    await GET(authedRequest());

    const wheres = mockSecretsFindMany.mock.calls.map(c => JSON.stringify(c[0]?.where ?? null));
    const sweep = wheres.find(w => w.includes("1 minute"));
    expect(sweep).toContain('isNull');
  });

  it('always runs zombie detection regardless of mode', async () => {
    const res = await GET(authedRequest());
    const body = await res.json();
    expect(body.claudeRefresh.zombies).toBe(0);
  });

  it('always runs claude verify regardless of mode', async () => {
    const res = await GET(authedRequest());
    const body = await res.json();
    expect(body.claudeVerify).toBeDefined();
    expect(typeof body.claudeVerify.checked).toBe('number');
  });
});

// Regression (2026-08-28): the nudge dedupe only looked for a *pending* task
// with the same title, so every cron pass filed a fresh nudge while the previous
// one was still assigned/in_progress. Each doomed copy burned worker slots
// (4 silent-start workers in 4 hours for one credential).
describe('nudge dedupe covers in-flight tasks, not just pending', () => {
  it('matches an existing nudge task in pending, assigned or in_progress', async () => {
    process.env.CRON_SECRET = 'test-secret';
    delete process.env.BUILDD_ALLOW_CONTROL_PLANE_REFRESH;
    tasksInsertValues = [];
    mockSecretsFindMany.mockReset();
    mockTasksFindFirst.mockReset();
    mockSecretsFindMany.mockReturnValueOnce([
      { id: 'sec-inflight', teamId: 'team-1', workspaceId: 'ws-1' },
    ]).mockReturnValue([]);
    mockTasksFindFirst.mockReturnValue(null);

    await GET(makeRequest('test-secret'));

    const dedupeCall = mockTasksFindFirst.mock.calls[0]?.[0] as any;
    expect(dedupeCall).toBeDefined();
    const statusFilter = JSON.stringify(dedupeCall.where);
    expect(statusFilter).toContain('pending');
    expect(statusFilter).toContain('assigned');
    expect(statusFilter).toContain('in_progress');
  });
});
