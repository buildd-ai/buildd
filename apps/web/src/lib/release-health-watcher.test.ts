import { describe, it, expect, beforeEach, mock } from 'bun:test';

// ── Module mocks (must be before import) ────────────────────────────────────
const mockTriggerEvent = mock(() => Promise.resolve());
const mockDispatchNewTask = mock(() => Promise.resolve());

mock.module('@/lib/pusher', () => ({
  triggerEvent: mockTriggerEvent,
  channels: { workspace: (id: string) => `workspace-${id}` },
  events: { RELEASE_UPDATED: 'release:updated' },
}));

mock.module('@/lib/task-dispatch', () => ({
  dispatchNewTask: mockDispatchNewTask,
}));

mock.module('@buildd/core/db', () => ({ db: {} }));

const schemaMock = {
  releases: 'releases_table',
  tasks: 'tasks_table',
  workspaces: 'workspaces_table',
};
mock.module('@buildd/core/db/schema', () => schemaMock);

mock.module('drizzle-orm', () => ({
  eq: (a: any, b: any) => ({ type: 'eq', a, b }),
  and: (...args: any[]) => ({ type: 'and', args }),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...vals: any[]) => ({
      type: 'sql',
      strings: [...strings],
      vals,
    }),
    { raw: (s: string) => ({ type: 'sql_raw', s }) },
  ),
}));

// Import AFTER mocks
import { degradeRelease, autoFileDegradationTask, probeAndDegrade } from './release-health-watcher';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeRelease(overrides: Partial<{
  id: string;
  workspaceId: string;
  deployUrl: string | null;
  headSha: string | null;
  healthyAt: Date | null;
}> = {}) {
  return {
    id: 'rel-aaaa',
    workspaceId: 'ws-1111',
    verificationStrategy: 'http',
    deployUrl: null,
    headSha: 'sha-current',
    healthyAt: new Date(),
    ...overrides,
  };
}

// Queues one Response-shaped value per call to globalThis.fetch, in order.
function mockFetchSequence(responses: Array<{ ok: boolean; status?: number; json?: () => Promise<any> } | Error>) {
  let call = 0;
  globalThis.fetch = mock(() => {
    const next = responses[call++];
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next as Response);
  }) as any;
}

interface UpdateCall { setValues: any }
interface InsertCall { values: any }
interface SelectResult { rows: any[] }

function makeMockDb(opts: {
  existingTasks?: any[];
  workspace?: any;
  insertedTask?: any;
} = {}) {
  let selectCount = 0;
  const selectBehaviors: any[][] = [
    opts.existingTasks ?? [],       // first select: dedup check
    opts.workspace != null ? [opts.workspace] : [],  // second select: workspace lookup
  ];

  const updateCalls: UpdateCall[] = [];
  const insertCalls: InsertCall[] = [];

  const db: any = {
    _updateCalls: updateCalls,
    _insertCalls: insertCalls,
    update: (_table: any) => ({
      set: (values: any) => {
        updateCalls.push({ setValues: values });
        return { where: () => Promise.resolve() };
      },
    }),
    select: (_cols?: any) => ({
      from: (_table: any) => ({
        where: (_cond: any) => ({
          limit: (_n: any) => Promise.resolve(selectBehaviors[selectCount++] ?? []),
        }),
        innerJoin: (_t: any, _on: any) => ({
          where: (_cond: any) => Promise.resolve(selectBehaviors[selectCount++] ?? []),
        }),
      }),
    }),
    insert: (_table: any) => ({
      values: (vals: any) => {
        insertCalls.push({ values: vals });
        const rows = opts.insertedTask ? [opts.insertedTask] : [];
        return { returning: () => Promise.resolve(rows) };
      },
    }),
  };

  return db;
}

function resetAll() {
  mockTriggerEvent.mockClear();
  mockDispatchNewTask.mockClear();
  globalThis.fetch = undefined as any;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('degradeRelease', () => {
  beforeEach(resetAll);

  it('updates release to degraded and emits Pusher event', async () => {
    const db = makeMockDb({ existingTasks: [{ id: 'existing-task' }] });
    const release = makeRelease();
    await degradeRelease(release, db, 'HTTP 500');

    expect(db._updateCalls).toHaveLength(1);
    expect(db._updateCalls[0].setValues.state).toBe('degraded');
    expect(db._updateCalls[0].setValues.failureReason).toBe('HTTP 500');

    const pusherCall = mockTriggerEvent.mock.calls[0];
    expect(pusherCall[0]).toBe('workspace-ws-1111');
    expect(pusherCall[1]).toBe('release:updated');
    expect(pusherCall[2]).toEqual({ releaseId: 'rel-aaaa', state: 'degraded' });
  });
});

describe('autoFileDegradationTask', () => {
  beforeEach(resetAll);

  it('creates a task when no existing degradation task is open', async () => {
    const insertedTask = { id: 'new-task-id', title: 'x', description: 'y', workspaceId: 'ws-1111' };
    const db = makeMockDb({
      existingTasks: [],
      workspace: { id: 'ws-1111', repo: 'org/repo', name: 'Test Workspace' },
      insertedTask,
    });
    const release = makeRelease();
    await autoFileDegradationTask(release, db, 'HTTP 503');

    expect(db._insertCalls).toHaveLength(1);
    const inserted = db._insertCalls[0].values;
    expect(inserted.context.releaseId).toBe('rel-aaaa');
    expect(inserted.context.type).toBe('degradation');
    expect(inserted.title).toContain('[degraded]');
    expect(inserted.title).toContain('rel-aaaa'.slice(0, 8));
    expect(inserted.category).toBe('bug');

    expect(mockDispatchNewTask).toHaveBeenCalledTimes(1);
  });

  it('skips task creation when an open degradation task already exists (dedup)', async () => {
    const db = makeMockDb({ existingTasks: [{ id: 'existing-task' }] });
    const release = makeRelease();
    await autoFileDegradationTask(release, db, 'HTTP 503');

    expect(db._insertCalls).toHaveLength(0);
    expect(mockDispatchNewTask).not.toHaveBeenCalled();
  });
});

describe('probeAndDegrade', () => {
  beforeEach(resetAll);

  it('returns ok when probe returns 2xx and the deployed sha matches the release head sha', async () => {
    const db = makeMockDb({ existingTasks: [{ id: 'existing' }] });
    mockFetchSequence([
      { ok: true, status: 200 },
      { ok: true, status: 200, json: () => Promise.resolve({ sha: 'sha-current' }) },
    ]);

    const result = await probeAndDegrade(makeRelease({ headSha: 'sha-current' }), 'https://example.com/health', db);
    expect(result).toBe('ok');
    expect(db._updateCalls).toHaveLength(0);
  });

  it('calls degradeRelease when probe returns non-2xx (sha never checked)', async () => {
    const db = makeMockDb({ existingTasks: [{ id: 'existing' }] });
    globalThis.fetch = mock(() => Promise.resolve({ ok: false, status: 500 } as Response)) as any;

    const result = await probeAndDegrade(makeRelease(), 'https://example.com/health', db);
    expect(result).toBe('degraded');
    expect(db._updateCalls).toHaveLength(1);
    expect(db._updateCalls[0].setValues.state).toBe('degraded');
    expect(db._updateCalls[0].setValues.failureReason).toContain('500');
  });

  it('calls degradeRelease when probe throws (network error)', async () => {
    const db = makeMockDb({ existingTasks: [{ id: 'existing' }] });
    globalThis.fetch = mock(() => Promise.reject(new Error('ECONNREFUSED'))) as any;

    const result = await probeAndDegrade(makeRelease(), 'https://example.com/health', db);
    expect(result).toBe('degraded');
    expect(db._updateCalls).toHaveLength(1);
    expect(db._updateCalls[0].setValues.failureReason).toContain('ECONNREFUSED');
  });

  it('degrades with both shas in the reason when the deployed sha does not match, past the grace window', async () => {
    const db = makeMockDb({ existingTasks: [{ id: 'existing' }] });
    mockFetchSequence([
      { ok: true, status: 200 },
      { ok: true, status: 200, json: () => Promise.resolve({ sha: 'sha-old' }) },
    ]);
    const release = makeRelease({ headSha: 'sha-new', healthyAt: new Date(Date.now() - 10 * 60_000) });

    const result = await probeAndDegrade(release, 'https://example.com/health', db);
    expect(result).toBe('degraded');
    expect(db._updateCalls).toHaveLength(1);
    expect(db._updateCalls[0].setValues.state).toBe('degraded');
    expect(db._updateCalls[0].setValues.failureReason).toContain('sha-old');
    expect(db._updateCalls[0].setValues.failureReason).toContain('sha-new');
  });

  it('does not fail a mismatch that falls inside the post-deploy grace window', async () => {
    const db = makeMockDb({ existingTasks: [{ id: 'existing' }] });
    mockFetchSequence([
      { ok: true, status: 200 },
      { ok: true, status: 200, json: () => Promise.resolve({ sha: 'sha-old' }) },
    ]);
    // healthyAt just now: deployment may still be propagating globally.
    const release = makeRelease({ headSha: 'sha-new', healthyAt: new Date() });

    const result = await probeAndDegrade(release, 'https://example.com/health', db);
    expect(result).toBe('unverified');
    expect(db._updateCalls).toHaveLength(0);
  });

  it('returns unverified without failing when the release has no recorded head sha (older row)', async () => {
    const db = makeMockDb({ existingTasks: [{ id: 'existing' }] });
    globalThis.fetch = mock(() => Promise.resolve({ ok: true, status: 200 } as Response)) as any;

    const result = await probeAndDegrade(makeRelease({ headSha: null }), 'https://example.com/health', db);
    expect(result).toBe('unverified');
    expect(db._updateCalls).toHaveLength(0);
  });

  it('fetches the deploy identity endpoint at the verification URL origin', async () => {
    const db = makeMockDb({ existingTasks: [{ id: 'existing' }] });
    let secondUrl: string | undefined;
    let call = 0;
    globalThis.fetch = mock((url: string) => {
      call++;
      if (call === 2) secondUrl = String(url);
      if (call === 1) return Promise.resolve({ ok: true, status: 200 } as Response);
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ sha: 'sha-current' }) } as any);
    }) as any;

    await probeAndDegrade(makeRelease({ headSha: 'sha-current' }), 'https://example.com/api/version', db);
    expect(secondUrl).toBe('https://example.com/api/deploy-identity');
  });
});
