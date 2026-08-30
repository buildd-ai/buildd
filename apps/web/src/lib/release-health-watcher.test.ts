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
  healthyAt: Date | null;
}> = {}) {
  return {
    id: 'rel-aaaa',
    workspaceId: 'ws-1111',
    verificationStrategy: 'http',
    deployUrl: null,
    healthyAt: new Date(),
    ...overrides,
  };
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

  it('returns ok and does not degrade when probe returns 2xx', async () => {
    const db = makeMockDb({ existingTasks: [{ id: 'existing' }] });
    globalThis.fetch = mock(() => Promise.resolve({ ok: true, status: 200 } as Response)) as any;

    const result = await probeAndDegrade(makeRelease(), 'https://example.com/health', db);
    expect(result).toBe('ok');
    expect(db._updateCalls).toHaveLength(0);
  });

  it('calls degradeRelease when probe returns non-2xx', async () => {
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
});
