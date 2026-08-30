import { describe, it, expect, mock, beforeEach } from 'bun:test';
import {
  handleBuilddAction,
  triggerActions,
  workerActions,
  adminActions,
  allActions,
  buildParamsDescription,
  type ApiFn,
  type ActionContext,
} from '../mcp-tools';

const MOCK_WORKSPACE_ID = '00000000-0000-0000-0000-000000000001';
const OTHER_WORKSPACE_ID = '00000000-0000-0000-0000-0000000000ff';
const MOCK_WORKER_ID = '00000000-0000-0000-0000-000000000002';

const ACTION = 'get_failure_analytics';

function ctx(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    workspaceId: MOCK_WORKSPACE_ID,
    workerId: MOCK_WORKER_ID,
    authType: 'oauth',
    getWorkspaceId: async () => MOCK_WORKSPACE_ID,
    getLevel: async () => 'worker',
    ...overrides,
  };
}

const STALE_SIGNATURE = 'Stale worker expired (no update for <n>+ minutes)';

function signature(overrides: Record<string, unknown> = {}) {
  return {
    signature: STALE_SIGNATURE,
    count: 12,
    firstSeen: '2026-08-22T00:00:00.000Z',
    lastSeen: '2026-08-27T00:00:00.000Z',
    exampleWorkerIds: ['w1', 'w2', 'w3'],
    exampleError: 'Stale worker expired (no update for 15+ minutes)',
    exampleTaskId: 't1',
    diedEarlyCount: 9,
    exitCauses: ['infra_failure'],
    ...overrides,
  };
}

function analytics(overrides: Record<string, unknown> = {}) {
  return {
    window: '7d',
    generatedAt: '2026-08-28T12:00:00.000Z',
    windowStart: '2026-08-21T12:00:00.000Z',
    totals: { started: 100, completed: 70, failed: 30, failureRatePct: 30, diedEarly: 18, diedEarlySharePct: 60 },
    byExitCause: [
      { exitCause: 'infra_failure', count: 20, sharePct: 67 },
      { exitCause: 'unclassified', count: 10, sharePct: 33 },
    ],
    signatures: [signature()],
    diedEarlySignatures: [],
    byRole: [],
    byWorkspace: [],
    repeatFailureTasks: [],
    ...overrides,
  };
}

function lookup(overrides: Record<string, unknown> = {}) {
  return {
    query: 'Stale worker expired (no update for 15+ minutes)',
    signature: STALE_SIGNATURE,
    frictionSignature: 'worker-failure:stale_worker_expired_no_update_for_n_a1b2c3',
    known: true,
    count: 12,
    firstSeen: '2026-08-22T00:00:00.000Z',
    lastSeen: '2026-08-27T00:00:00.000Z',
    diedEarlyCount: 9,
    exitCauses: ['infra_failure'],
    exampleTaskId: 't1',
    exhaustive: true,
    ...overrides,
  };
}

// ── Registration & privilege gate ────────────────────────────────────────────

describe('get_failure_analytics registration', () => {
  it('is available at worker level', () => {
    expect((workerActions as readonly string[])).toContain(ACTION);
  });

  it('is NOT available at trigger level — trigger tokens never execute work', () => {
    expect((triggerActions as readonly string[])).not.toContain(ACTION);
  });

  it('is not an admin-only action — admins inherit it from the worker set', () => {
    expect((adminActions as readonly string[])).not.toContain(ACTION);
    expect((allActions as readonly string[])).toContain(ACTION);
  });

  it('documents its arg shape in the params description', () => {
    const desc = buildParamsDescription([ACTION]);
    expect(desc).toContain(ACTION);
    expect(desc).toMatch(/window\?/);
    expect(desc).toMatch(/error\?/);
    expect(desc).toMatch(/limit\?/);
    expect(desc).toMatch(/frictionSignature/);
  });
});

describe('get_failure_analytics privilege gate', () => {
  let mockApi: ReturnType<typeof mock>;
  beforeEach(() => { mockApi = mock(); });

  it('refuses a trigger-level token and names the required level', async () => {
    const res = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      ACTION,
      {},
      ctx({ getLevel: async () => 'trigger' }),
    );
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/worker or admin token/);
    expect(mockApi).toHaveBeenCalledTimes(0);
  });

  it('allows a worker-level token — a worker must be able to check its own failure', async () => {
    mockApi.mockResolvedValueOnce({ analytics: analytics() });
    const res = await handleBuilddAction(mockApi as unknown as ApiFn, ACTION, {}, ctx());
    expect(res.isError).toBeFalsy();
  });

  it('allows an admin-level token', async () => {
    mockApi.mockResolvedValueOnce({ analytics: analytics() });
    const res = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      ACTION,
      {},
      ctx({ getLevel: async () => 'admin' }),
    );
    expect(res.isError).toBeFalsy();
  });
});

// ── Scoping ──────────────────────────────────────────────────────────────────

describe('get_failure_analytics scoping', () => {
  let mockApi: ReturnType<typeof mock>;
  beforeEach(() => { mockApi = mock(); });

  it('reads through the team-scoped health endpoint and sends no team/account param', async () => {
    mockApi.mockResolvedValueOnce({ analytics: analytics() });
    await handleBuilddAction(mockApi as unknown as ApiFn, ACTION, {}, ctx());
    const endpoint = mockApi.mock.calls[0][0] as string;
    expect(endpoint.startsWith('/api/health/failures?')).toBe(true);
    expect(endpoint).not.toMatch(/teamId|accountId/);
  });

  it('is read-only: issues a GET with no request body', async () => {
    mockApi.mockResolvedValueOnce({ analytics: analytics() });
    await handleBuilddAction(mockApi as unknown as ApiFn, ACTION, {}, ctx());
    const options = mockApi.mock.calls[0][1];
    expect(options === undefined || options.method === undefined || options.method === 'GET').toBe(true);
    expect(options?.body).toBeUndefined();
  });

  it('resolves a workspace name to a UUID before scoping', async () => {
    // resolveWorkspaceId → GET /api/workspaces, then the failures fetch.
    mockApi.mockResolvedValueOnce({ workspaces: [{ id: MOCK_WORKSPACE_ID, name: 'buildd', repo: 'buildd-ai/buildd' }] });
    mockApi.mockResolvedValueOnce({ analytics: analytics() });

    await handleBuilddAction(mockApi as unknown as ApiFn, ACTION, { workspaceId: 'buildd' }, ctx());

    expect(mockApi.mock.calls[1][0]).toContain(`workspaceId=${MOCK_WORKSPACE_ID}`);
  });

  it('passes an explicit workspace UUID straight through', async () => {
    mockApi.mockResolvedValueOnce({ analytics: analytics() });
    await handleBuilddAction(mockApi as unknown as ApiFn, ACTION, { workspaceId: OTHER_WORKSPACE_ID }, ctx());
    // Cross-team enforcement lives in the route (404) — the tool must not
    // silently rewrite the request to the caller's own workspace.
    expect(mockApi.mock.calls[0][0]).toContain(`workspaceId=${OTHER_WORKSPACE_ID}`);
  });

  it('errors without fetching when a named workspace cannot be resolved', async () => {
    mockApi.mockResolvedValueOnce({ workspaces: [] });
    const res = await handleBuilddAction(mockApi as unknown as ApiFn, ACTION, { workspaceId: 'not-a-workspace' }, ctx());
    expect(res.isError).toBe(true);
    expect(mockApi).toHaveBeenCalledTimes(1);
  });

  it('omits workspaceId entirely when none is given, for a team-wide report', async () => {
    mockApi.mockResolvedValueOnce({ analytics: analytics() });
    await handleBuilddAction(mockApi as unknown as ApiFn, ACTION, {}, ctx());
    expect(mockApi.mock.calls[0][0]).not.toContain('workspaceId=');
  });
});

// ── Overview mode ────────────────────────────────────────────────────────────

describe('get_failure_analytics overview mode', () => {
  let mockApi: ReturnType<typeof mock>;
  beforeEach(() => { mockApi = mock(); });

  it('defaults to the 7d window', async () => {
    mockApi.mockResolvedValueOnce({ analytics: analytics() });
    await handleBuilddAction(mockApi as unknown as ApiFn, ACTION, {}, ctx());
    expect(mockApi.mock.calls[0][0]).toContain('window=7d');
  });

  it('passes each supported window through', async () => {
    for (const w of ['24h', '7d', '30d']) {
      mockApi = mock();
      mockApi.mockResolvedValueOnce({ analytics: analytics({ window: w }) });
      await handleBuilddAction(mockApi as unknown as ApiFn, ACTION, { window: w }, ctx());
      expect(mockApi.mock.calls[0][0]).toContain(`window=${w}`);
    }
  });

  it('rejects an unsupported window instead of silently querying 7d', async () => {
    const res = await handleBuilddAction(mockApi as unknown as ApiFn, ACTION, { window: 'all-time' }, ctx());
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/24h/);
    expect(mockApi).toHaveBeenCalledTimes(0);
  });

  it('reports totals, failure rate, died-early count and top signatures', async () => {
    mockApi.mockResolvedValueOnce({ analytics: analytics() });
    const res = await handleBuilddAction(mockApi as unknown as ApiFn, ACTION, {}, ctx());
    const out = res.content[0].text;
    expect(out).toMatch(/30 of 100 workers failed \(30%\)/);
    expect(out).toMatch(/died early: 18/);
    expect(out).toMatch(/infra_failure 20/);
    expect(out).toContain(STALE_SIGNATURE);
    expect(out).toMatch(/12×/);
  });

  it('says so plainly when the window has no failures', async () => {
    mockApi.mockResolvedValueOnce({
      analytics: analytics({
        totals: { started: 40, completed: 40, failed: 0, failureRatePct: 0, diedEarly: 0, diedEarlySharePct: 0 },
        byExitCause: [],
        signatures: [],
      }),
    });
    const res = await handleBuilddAction(mockApi as unknown as ApiFn, ACTION, {}, ctx());
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toMatch(/No worker failures/);
  });

  it('caps signatures at a small default and says how many were omitted', async () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      signature({ signature: `failure variant ${i}`, count: 20 - i }));
    mockApi.mockResolvedValueOnce({ analytics: analytics({ signatures: many }) });

    const res = await handleBuilddAction(mockApi as unknown as ApiFn, ACTION, {}, ctx());
    const out = res.content[0].text;
    expect(out).toContain('failure variant 0');
    expect(out).toContain('failure variant 4');
    expect(out).not.toContain('failure variant 5');
    expect(out).toMatch(/15 more/);
  });

  it('honours an explicit limit', async () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      signature({ signature: `failure variant ${i}`, count: 20 - i }));
    mockApi.mockResolvedValueOnce({ analytics: analytics({ signatures: many }) });

    const res = await handleBuilddAction(mockApi as unknown as ApiFn, ACTION, { limit: 2 }, ctx());
    const out = res.content[0].text;
    expect(out).toContain('failure variant 1');
    expect(out).not.toContain('failure variant 2');
  });

  it('clamps an oversized limit so a caller cannot flood its own context', async () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      signature({ signature: `failure variant ${i}`, count: 60 - i }));
    mockApi.mockResolvedValueOnce({ analytics: analytics({ signatures: many }) });

    const res = await handleBuilddAction(mockApi as unknown as ApiFn, ACTION, { limit: 500 }, ctx());
    const out = res.content[0].text;
    expect(out).toContain('failure variant 14');
    expect(out).not.toContain('failure variant 15');
  });

  it('truncates a long signature line', async () => {
    const long = `Boom ${'x'.repeat(400)}`;
    mockApi.mockResolvedValueOnce({ analytics: analytics({ signatures: [signature({ signature: long })] }) });
    const res = await handleBuilddAction(mockApi as unknown as ApiFn, ACTION, {}, ctx());
    const out = res.content[0].text;
    expect(out).not.toContain(long);
    expect(out).toContain('Boom ');
    expect(out).toContain('…');
    expect(out.length).toBeLessThan(1200);
  });

  it('returns no raw per-worker rows', async () => {
    mockApi.mockResolvedValueOnce({ analytics: analytics() });
    const res = await handleBuilddAction(mockApi as unknown as ApiFn, ACTION, {}, ctx());
    const out = res.content[0].text;
    expect(out).not.toContain('w1');
    expect(out).not.toContain('exampleWorkerIds');
  });

  it('handles a health endpoint that returns no analytics at all', async () => {
    mockApi.mockResolvedValueOnce({});
    const res = await handleBuilddAction(mockApi as unknown as ApiFn, ACTION, {}, ctx());
    expect(res.content[0].text).toMatch(/No failure analytics/);
  });
});

// ── Lookup mode ──────────────────────────────────────────────────────────────

describe('get_failure_analytics lookup mode', () => {
  let mockApi: ReturnType<typeof mock>;
  beforeEach(() => { mockApi = mock(); });

  it('sends the raw error upstream so the shared normalizer resolves it', async () => {
    mockApi.mockResolvedValueOnce({ analytics: analytics(), lookup: lookup() });
    const raw = 'Stale worker expired (no update for 15+ minutes)';
    await handleBuilddAction(mockApi as unknown as ApiFn, ACTION, { error: raw }, ctx());
    expect(mockApi.mock.calls[0][0]).toContain(`error=${encodeURIComponent(raw)}`);
  });

  it('reports a known pattern with its count and first/last seen', async () => {
    mockApi.mockResolvedValueOnce({ analytics: analytics(), lookup: lookup() });
    const res = await handleBuilddAction(
      mockApi as unknown as ApiFn, ACTION,
      { error: 'Stale worker expired (no update for 15+ minutes)' }, ctx(),
    );
    const out = res.content[0].text;
    expect(res.isError).toBeFalsy();
    expect(out).toMatch(/^Known failure pattern/);
    expect(out).toMatch(/12 occurrence/);
    expect(out).toContain('2026-08-22T00:00:00.000Z');
    expect(out).toContain('2026-08-27T00:00:00.000Z');
    expect(out).toContain(STALE_SIGNATURE);
    expect(out).toMatch(/died early 9\/12/);
  });

  it('hands back a dedupe key an agent can pass to create_task', async () => {
    mockApi.mockResolvedValueOnce({ analytics: analytics(), lookup: lookup() });
    const res = await handleBuilddAction(
      mockApi as unknown as ApiFn, ACTION,
      { error: 'Stale worker expired (no update for 15+ minutes)' }, ctx(),
    );
    const out = res.content[0].text;
    expect(out).toContain('worker-failure:stale_worker_expired_no_update_for_n_a1b2c3');
    expect(out).toMatch(/frictionSignature/);
    expect(out).toMatch(/frictionExcerpt/);
  });

  it('returns a clean not-known answer for an unseen error, not an error result', async () => {
    mockApi.mockResolvedValueOnce({
      analytics: analytics(),
      lookup: lookup({
        known: false, count: 0, firstSeen: null, lastSeen: null,
        diedEarlyCount: 0, exitCauses: [], exampleTaskId: null,
        signature: 'ENOSPC: no space left on device',
        frictionSignature: 'worker-failure:enospc_no_space_left_on_device_9f8e7d',
        query: 'ENOSPC: no space left on device',
      }),
    });
    const res = await handleBuilddAction(
      mockApi as unknown as ApiFn, ACTION,
      { error: 'ENOSPC: no space left on device' }, ctx(),
    );
    expect(res.isError).toBeFalsy();
    const out = res.content[0].text;
    expect(out).toMatch(/^New failure/);
    expect(out).toContain('ENOSPC: no space left on device');
    expect(out).toContain('worker-failure:enospc_no_space_left_on_device_9f8e7d');
  });

  it('says the answer is definitive when the ranking covered every failure', async () => {
    mockApi.mockResolvedValueOnce({
      analytics: analytics(),
      lookup: lookup({ known: false, count: 0, firstSeen: null, lastSeen: null, exhaustive: true }),
    });
    const res = await handleBuilddAction(mockApi as unknown as ApiFn, ACTION, { error: 'boom' }, ctx());
    expect(res.content[0].text).not.toMatch(/capped/);
  });

  it('warns that a rare match may have been missed when the ranking was capped', async () => {
    mockApi.mockResolvedValueOnce({
      analytics: analytics(),
      lookup: lookup({ known: false, count: 0, firstSeen: null, lastSeen: null, exhaustive: false }),
    });
    const res = await handleBuilddAction(mockApi as unknown as ApiFn, ACTION, { error: 'boom' }, ctx());
    expect(res.content[0].text).toMatch(/capped/);
  });

  it('truncates a huge error before putting it on the wire', async () => {
    mockApi.mockResolvedValueOnce({ analytics: analytics(), lookup: lookup() });
    const huge = `Boom: ${'x'.repeat(9000)}`;
    await handleBuilddAction(mockApi as unknown as ApiFn, ACTION, { error: huge }, ctx());
    const endpoint = mockApi.mock.calls[0][0] as string;
    expect(endpoint.length).toBeLessThan(2500);
    expect(endpoint).toContain('Boom');
  });

  it('treats a blank error as no lookup and returns the overview', async () => {
    mockApi.mockResolvedValueOnce({ analytics: analytics() });
    const res = await handleBuilddAction(mockApi as unknown as ApiFn, ACTION, { error: '   ' }, ctx());
    expect(mockApi.mock.calls[0][0]).not.toContain('error=');
    expect(res.content[0].text).toMatch(/Worker failures/);
  });

  it('falls back to the overview when the route returns no lookup block', async () => {
    mockApi.mockResolvedValueOnce({ analytics: analytics() });
    const res = await handleBuilddAction(mockApi as unknown as ApiFn, ACTION, { error: 'boom' }, ctx());
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toMatch(/Worker failures/);
  });

  it('keeps lookup output short — one screen, no dashboard payload', async () => {
    mockApi.mockResolvedValueOnce({ analytics: analytics(), lookup: lookup() });
    const res = await handleBuilddAction(
      mockApi as unknown as ApiFn, ACTION,
      { error: 'Stale worker expired (no update for 15+ minutes)' }, ctx(),
    );
    expect(res.content[0].text.length).toBeLessThan(900);
  });
});
