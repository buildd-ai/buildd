import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// ── DB mocks ────────────────────────────────────────────────────────────────

const mockSecretsFindMany = mock(() => [] as any[]);
const mockTasksFindFirst = mock(() => null as any);
const mockWorkspacesFindFirst = mock(() => ({ id: 'ws-1' }) as any);

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
      tasks: { findFirst: mockTasksFindFirst },
      workspaces: { findFirst: mockWorkspacesFindFirst },
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

  it('rejects a platform cron header used in place of the secret', async () => {
    // Platform-native cron does not fire in this project (cron-manifest.json is
    // explicit; vercel.json declares no crons), so this header can only come
    // from a caller that is not the scheduler. This route refreshes
    // credentials, which is precisely what must not be reachable without the
    // secret. CRON_SECRET is the single accepted credential.
    const res = await GET(makeRequest(undefined, true));
    expect(res.status).toBe(401);
  });

  // ── Observe-only mode (default) ───────────────────────────────────────────
  //
  // This sweep used to file one task per expiring credential, titled
  // `[sys] refresh credential <id>`. Nothing on the runner side matched that
  // title, so the row went down the ordinary claim path and a general-purpose
  // agent picked it up — with no control-plane key in its sandbox, so it 401'd
  // and the task failed, every sweep, indefinitely. Worse, one such agent did
  // take the refresh lock, called the provider, and lost the rotated refresh
  // token to output redaction; rotation-on-use makes that unrecoverable. The
  // title also published the credential's identifier everywhere a task title is
  // rendered. The runner-side broker owns refresh now; with the opt-in flag off
  // this route observes and reports, and takes no action.

  it('creates no task for an expiring codex credential', async () => {
    mockSecretsFindMany.mockReturnValueOnce([
      { id: 'sec-1', teamId: 'team-1', workspaceId: 'ws-1' },
    ]).mockReturnValue([]);

    const res = await GET(authedRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(tasksInsertValues).toHaveLength(0);
    expect(body.codex.checked).toBe(1);
  });

  it('creates no task for an expiring claude credential', async () => {
    mockSecretsFindMany
      .mockReturnValueOnce([])  // codex expiring
      .mockReturnValueOnce([{ id: 'sec-2', teamId: 'team-1', workspaceId: 'ws-1' }])  // claude expiring
      .mockReturnValue([]);  // zombie and verify queries

    const res = await GET(authedRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(tasksInsertValues).toHaveLength(0);
    expect(body.claudeRefresh.checked).toBe(1);
  });

  it('never writes a credential identifier into a task row', async () => {
    mockSecretsFindMany
      .mockReturnValueOnce([{ id: 'sec-1', teamId: 'team-1', workspaceId: 'ws-1' }])
      .mockReturnValueOnce([{ id: 'sec-2', teamId: 'team-1', workspaceId: null }])
      .mockReturnValue([]);

    await GET(authedRequest());

    expect(tasksInsertValues).toHaveLength(0);
    const written = JSON.stringify(tasksInsertValues);
    expect(written).not.toContain('sec-1');
    expect(written).not.toContain('sec-2');
  });

  it('does not look for a task to dedupe against, nor a workspace to file one in', async () => {
    // Both queries existed only to serve the task-filing path. Reaching either
    // means some remnant of it survived.
    mockSecretsFindMany.mockReturnValueOnce([
      { id: 'sec-1', teamId: 'team-1', workspaceId: null },
    ]).mockReturnValue([]);

    await GET(authedRequest());

    expect(mockTasksFindFirst).not.toHaveBeenCalled();
    expect(mockWorkspacesFindFirst).not.toHaveBeenCalled();
  });

  it('reports what it observed, in no nudge vocabulary', async () => {
    mockSecretsFindMany.mockReturnValueOnce([
      { id: 'sec-1', teamId: 'team-1', workspaceId: 'ws-1' },
    ]).mockReturnValue([]);

    const res = await GET(authedRequest());
    const body = await res.json();
    expect(body.controlPlaneRefresh).toBe(false);
    expect(body.codex.checked).toBe(1);
    expect(body).not.toHaveProperty('nudgeMode');
    expect(body).not.toHaveProperty('nudgedCredentials');
    expect(body.codex).not.toHaveProperty('nudged');
    expect(body.codex).not.toHaveProperty('deduped');
    expect(body.claudeRefresh).not.toHaveProperty('nudged');
    expect(body.claudeRefresh).not.toHaveProperty('deduped');
  });

  it('does not call refreshCodexCredential or refreshClaudeCredential when the flag is off', async () => {
    mockSecretsFindMany.mockReturnValueOnce([
      { id: 'sec-1', teamId: 'team-1', workspaceId: 'ws-1' },
    ]).mockReturnValue([]);

    await GET(authedRequest());
    expect(mockRefreshCodex).not.toHaveBeenCalled();
    expect(mockRefreshClaude).not.toHaveBeenCalled();
  });

  // ── Direct mode (BUILDD_ALLOW_CONTROL_PLANE_REFRESH=true) ─────────────────

  it('reports controlPlaneRefresh=true when BUILDD_ALLOW_CONTROL_PLANE_REFRESH=true', async () => {
    // The break-glass fallback — refresh straight from the control plane, at
    // the cost of a rotating egress IP. Deliberately kept, deliberately opt-in.
    process.env.BUILDD_ALLOW_CONTROL_PLANE_REFRESH = 'true';
    const res = await GET(authedRequest());
    const body = await res.json();
    expect(body.controlPlaneRefresh).toBe(true);
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
    // flag off — MCP is not affected
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

  it('includes null-expiry connector credentials in the sweep instead of stranding them', async () => {
    // A NULL tokenExpiresAt is where the refresher parks a credential it marked
    // dead, and where an AS that omits expires_in leaves one. isNotNull() meant
    // neither was ever retried — a manual reconnect was the only way out.
    mockSecretsFindMany.mockReturnValue([]);

    await GET(authedRequest());

    const wheres = mockSecretsFindMany.mock.calls.map(c => JSON.stringify(c[0]?.where ?? null));
    const sweep = wheres.find(w => w.includes("1 minute"));
    expect(sweep).toContain('isNull');
  });

  it('includes null-expiry codex credentials in the sweep instead of stranding them', async () => {
    // Same trap, one branch over: a token response without expires_in stores
    // NULL, and isNotNull() then excluded that row from every later sweep — so
    // the credential most in need of a refresh was the one guaranteed never to
    // be offered another.
    mockSecretsFindMany.mockReturnValue([]);

    await GET(authedRequest());

    const wheres = mockSecretsFindMany.mock.calls.map(c => JSON.stringify(c[0]?.where ?? null));
    const sweep = wheres.find(w => w.includes('codex_credential'));
    expect(sweep, 'no query selects codex credentials').toBeDefined();
    expect(sweep).toContain('isNull');
  });

  it('includes null-expiry claude credentials in the expiry sweep', async () => {
    mockSecretsFindMany.mockReturnValue([]);

    await GET(authedRequest());

    const wheres = mockSecretsFindMany.mock.calls.map(c => JSON.stringify(c[0]?.where ?? null));
    // Zombie detection also selects claude_credential rows by a null expiry;
    // the expiry sweep is the one carrying an upper bound.
    const sweep = wheres.find(w => w.includes('claude_credential') && w.includes('"type":"lt"'));
    expect(sweep, 'no claude expiry sweep found').toBeDefined();
    expect(sweep).toContain('isNull');
  });

  it('no expiry sweep filters a null expiry out', async () => {
    // One assertion covering every credential family: isNotNull on
    // tokenExpiresAt is a one-way trap, so it should appear nowhere.
    mockSecretsFindMany.mockReturnValue([]);

    await GET(authedRequest());

    const wheres = mockSecretsFindMany.mock.calls.map(c => JSON.stringify(c[0]?.where ?? null));
    expect(wheres.some(w => w.includes('isNotNull'))).toBe(false);
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
