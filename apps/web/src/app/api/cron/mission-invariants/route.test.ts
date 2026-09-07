import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// The pure invariant module is NOT mocked — the route test runs the real
// predicates against a canned snapshot, so the filing path is exercised by a
// genuinely-evaluated breach rather than by a hand-written violation object.
import {
  emptySnapshot,
  remoteRefKey,
  type InvariantSnapshot,
  type ScanCoverage,
} from '@/lib/mission-invariants';

// ── Scan mock: the DB + GitHub half is stubbed, the evaluation is real ──────

let scanSnapshot: InvariantSnapshot = emptySnapshot();
let scanCoverage: ScanCoverage = { missions: 0, tasks: 0, workers: 0, releases: 0, notes: 0, remoteRefs: 0 };
const mockLoad = mock(async () => ({ snapshot: scanSnapshot, coverage: scanCoverage }));
mock.module('@/lib/mission-invariant-scan', () => ({ loadInvariantSnapshot: mockLoad }));

// ── DB mocks ────────────────────────────────────────────────────────────────

let existingFrictionTask: { id: string } | null = null;
const findFirstCalls: any[] = [];
const inserted: any[] = [];
const updated: any[] = [];

const mockFindFirst = mock(async (args: any) => {
  findFirstCalls.push(args);
  return existingFrictionTask;
});

mock.module('@buildd/core/db', () => ({
  db: {
    query: { tasks: { findFirst: mockFindFirst } },
    insert: mock(() => ({
      values: mock((values: any) => ({
        returning: mock(async () => {
          inserted.push(values);
          return [{ id: `task-${inserted.length}` }];
        }),
      })),
    })),
    update: mock(() => ({
      set: mock((values: any) => ({
        where: mock(async () => {
          updated.push(values);
        }),
      })),
    })),
  },
}));

mock.module('drizzle-orm', () => ({
  sql: (strings: any, ...values: any[]) => ({ strings, values, type: 'sql' }),
  eq: (f: any, v: any) => ({ f, v, type: 'eq' }),
  and: (...c: any[]) => ({ c, type: 'and' }),
  like: (f: any, v: any) => ({ f, v, type: 'like' }),
  notInArray: (f: any, v: any) => ({ f, v, type: 'notInArray' }),
}));

mock.module('@buildd/core/db/schema', () => ({
  tasks: { id: 'id', title: 'title', status: 'status', context: 'context', description: 'description', workspaceId: 'workspaceId' },
}));

const mockNotify = mock((_opts: any) => undefined);
mock.module('@/lib/pushover', () => ({ notify: mockNotify }));

const { POST, invariantFrictionSignature } = await import('./route');

// ── Helpers ─────────────────────────────────────────────────────────────────

const CRON_SECRET = 'test-cron-secret';

function makeRequest(token: string | null = CRON_SECRET): NextRequest {
  return new NextRequest('http://localhost/api/cron/mission-invariants', {
    method: 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

const HOUR = 3_600_000;

function workerRow(over: Record<string, any> = {}) {
  return {
    id: 'w-1',
    taskId: 't-1',
    workspaceId: 'ws-1',
    status: 'completed',
    branch: 'buildd/t-1',
    prNumber: null,
    prUrl: null,
    prBaseRef: null,
    prLifecycleStatus: null,
    mergedAt: null,
    commitCount: 0,
    createdAt: new Date(Date.now() - 6 * HOUR),
    startedAt: new Date(Date.now() - 6 * HOUR),
    completedAt: new Date(Date.now() - 6 * HOUR),
    ...over,
  };
}

/** A real `orphaned_integration_base` breach: open PR, mission base, ref gone. */
function orphanedBaseSnapshot(): InvariantSnapshot {
  const s = emptySnapshot();
  s.workers = [
    workerRow({
      id: 'w-orphan',
      prNumber: 4242,
      prUrl: 'https://github.com/o/r/pull/4242',
      prBaseRef: 'mission/example-1234',
      prLifecycleStatus: 'ci_green',
    }),
  ] as any;
  s.remoteBranchExists = new Map([[remoteRefKey('ws-1', 'mission/example-1234'), false]]);
  return s;
}

/** A real `stranded_commits` breach — report-only, must never file. */
function reportOnlySnapshot(): InvariantSnapshot {
  const s = emptySnapshot();
  s.workers = [workerRow({ id: 'w-stranded', status: 'completed', commitCount: 4, prNumber: null })] as any;
  return s;
}

beforeEach(() => {
  process.env.CRON_SECRET = CRON_SECRET;
  scanSnapshot = emptySnapshot();
  scanCoverage = { missions: 0, tasks: 0, workers: 0, releases: 0, notes: 0, remoteRefs: 0 };
  existingFrictionTask = null;
  findFirstCalls.length = 0;
  inserted.length = 0;
  updated.length = 0;
  mockNotify.mockClear();
});

// ── Auth ────────────────────────────────────────────────────────────────────

describe('auth', () => {
  it('rejects a request with no bearer', async () => {
    const res = await POST(makeRequest(null));
    expect(res.status).toBe(401);
  });

  it('rejects a mismatched bearer', async () => {
    const res = await POST(makeRequest('nope'));
    expect(res.status).toBe(401);
  });
});

// ── The load-bearing constraint: a healthy fleet spawns nothing ─────────────

describe('healthy fleet', () => {
  it('spawns nothing: no task, no notification', async () => {
    scanCoverage = { missions: 12, tasks: 80, workers: 40, releases: 5, notes: 2, remoteRefs: 1 };
    const res = await POST(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.violations).toBe(0);
    expect(body.filed).toBe(0);
    expect(inserted).toEqual([]);
    expect(updated).toEqual([]);
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('still names every invariant, so a clean run is not a dead query', async () => {
    scanCoverage = { missions: 12, tasks: 80, workers: 40, releases: 5, notes: 2, remoteRefs: 1 };
    const body = await (await POST(makeRequest())).json();
    expect(body.invariants).toHaveLength(11);
    expect(body.report).toContain('orphaned_integration_base');
    expect(body.report).toContain('mission_unverifiable');
    expect(body.report).not.toContain('EMPTY SCAN');
  });

  it('says EMPTY SCAN when the queries themselves matched no rows', async () => {
    const body = await (await POST(makeRequest())).json();
    expect(body.report).toContain('EMPTY SCAN');
  });
});

// ── Staging: exactly one invariant files ────────────────────────────────────

describe('staging', () => {
  it('reports a report-only breach without filing anything', async () => {
    scanSnapshot = reportOnlySnapshot();
    scanCoverage = { missions: 0, tasks: 0, workers: 1, releases: 0, notes: 0, remoteRefs: 0 };

    const body = await (await POST(makeRequest())).json();
    const stranded = body.invariants.find((i: any) => i.key === 'stranded_commits');

    expect(stranded.count).toBe(1);
    expect(stranded.files).toBe(false);
    expect(body.filed).toBe(0);
    expect(inserted).toEqual([]);
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('files a task for the one invariant staged to file', async () => {
    scanSnapshot = orphanedBaseSnapshot();
    scanCoverage = { missions: 0, tasks: 0, workers: 1, releases: 0, notes: 0, remoteRefs: 1 };

    const body = await (await POST(makeRequest())).json();

    expect(body.filed).toBe(1);
    expect(inserted).toHaveLength(1);
    expect(inserted[0].title).toStartWith('[friction] orphaned_integration_base');
    expect(inserted[0].workspaceId).toBe('ws-1');
    expect(inserted[0].context.frictionSignature).toBe(
      invariantFrictionSignature('orphaned_integration_base', '4242'),
    );
    expect(inserted[0].description).toContain('mission/example-1234');
    expect(mockNotify).toHaveBeenCalled();
  });
});

// ── Dedupe: a persistent breach accumulates on ONE task ─────────────────────

describe('dedupe', () => {
  it('appends to the open friction task instead of filing an hourly duplicate', async () => {
    scanSnapshot = orphanedBaseSnapshot();
    scanCoverage = { missions: 0, tasks: 0, workers: 1, releases: 0, notes: 0, remoteRefs: 1 };
    existingFrictionTask = { id: 'existing-task' };

    const body = await (await POST(makeRequest())).json();

    expect(inserted).toEqual([]);
    expect(updated).toHaveLength(1);
    expect(body.filed).toBe(0);
    expect(body.appended).toBe(1);
    // An already-queued breach must not page again.
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('looks the existing task up by the invariant signature', async () => {
    scanSnapshot = orphanedBaseSnapshot();
    await POST(makeRequest());
    const clause = JSON.stringify(findFirstCalls[0]?.where);
    expect(clause).toContain(invariantFrictionSignature('orphaned_integration_base', '4242'));
  });
});
