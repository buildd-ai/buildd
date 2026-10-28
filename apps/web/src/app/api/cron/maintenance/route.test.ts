import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';

// The two sweeps are unit-tested beside their files (stale-workers.test.ts,
// path-claims.test.ts). This file is about the trigger: auth, that both sweeps
// run on every tick, and that the run row carries what they did.

const mockPrune = mock(async () => 2);
mock.module('@/lib/oauth/prune-clients', () => ({ pruneUnusedClients: mockPrune }));

let cronRunRows: any[] = [];
mock.module('@buildd/core/db', () => ({
  db: {
    insert: () => ({
      values: (v: any) => {
        cronRunRows.push(v);
        return { returning: async () => [{ id: 'run-1' }] };
      },
    }),
    update: () => ({ set: () => ({ where: async () => {} }) }),
    delete: () => ({ where: async () => {} }),
    query: { cronRuns: { findMany: async () => [] } },
  },
}));
mock.module('drizzle-orm', () => ({
  // Operators withCronRun imports. mock.module is process-global, so a
  // partial stub removes them for every other importer too.
  and: (...c: any[]) => ({ c }),
  desc: (a: any) => ({ a }),
  eq: (a: any, b: any) => ({ a, b }),
  gt: (a: any, b: any) => ({ a, b }),
  lt: (a: any, b: any) => ({ a, b }),
}));
mock.module('@buildd/core/db/schema', () => ({
  cronRuns: { id: 'id', job: 'job', startedAt: 'startedAt', alertedAt: 'alertedAt' },
}));

const calls: string[] = [];
const mockStaleWorkers = mock(async (_now: Date) => { calls.push('stale-workers'); return 0; });
const mockPathClaims = mock(async () => { calls.push('path-claims'); return 0; });
mock.module('./stale-workers', () => ({ runStaleWorkerCleanup: mockStaleWorkers }));
mock.module('./path-claims', () => ({ sweepAbandonedPathClaims: mockPathClaims }));
const mockGuessedEdges = mock(async () => { calls.push('guessed-edges'); return 0; });
mock.module('./guessed-edges', () => ({ sweepGuessedEdges: mockGuessedEdges }));
const mockLanes = mock(async (_now: Date) => { calls.push('lanes'); return 0; });
mock.module('./lanes', () => ({ sweepSerialLanes: mockLanes }));
const mockDetach = mock(async (_opts: unknown) => { calls.push('interactive-detach'); return 0; });
mock.module('@/lib/interactive-detach', () => ({ detachInteractiveWorkersOfEndedTasks: mockDetach }));
const mockUploads = mock(async () => ({ finalized: 2, removed: 1, waiting: 0 }));
mock.module('@/lib/artifact-upload', () => ({ sweepStaleUploads: mockUploads }));
mock.module('@/lib/storage', () => ({ isStorageConfigured: () => true }));
const mockChatAttachments = mock(async (_opts: unknown) => ({ removed: 4, objectsRemoved: 2 }));
mock.module('@/lib/artifact-attachment-cleanup', () => ({ removeOrphanChatAttachments: mockChatAttachments }));
const mockTeamFiles = mock(async (_opts: unknown) => ({ removed: 5, objectsRemoved: 5 }));
mock.module('@/lib/artifact-team-files', () => ({ removeDetachedTeamFiles: mockTeamFiles }));
const mockSpecSweep = mock(async (_opts?: unknown) => ({ checked: 3, approved: 1, failed: 0 }));
mock.module('@/lib/specs/auto-approve', () => ({ sweepNoCriteriaChange: mockSpecSweep }));

const { GET } = await import('./route');

const CRON_SECRET = 'test-cron-secret';
function makeRequest(token: string | null = CRON_SECRET): NextRequest {
  return new NextRequest('http://localhost/api/cron/maintenance', {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

beforeEach(() => {
  process.env.CRON_SECRET = CRON_SECRET;
  process.env.BUILDD_CRON_RUN_RECORD_IN_TESTS = '1';
  cronRunRows = [];
  calls.length = 0;
  mockStaleWorkers.mockClear();
  mockPathClaims.mockClear();
  mockDetach.mockClear();
});

describe('maintenance cron — auth', () => {
  it('rejects a request without the cron secret and runs nothing', async () => {
    const res = await GET(makeRequest(null));
    expect(res.status).toBe(401);
    expect(calls).toEqual([]);
  });

  it('rejects the wrong cron secret', async () => {
    expect((await GET(makeRequest('nope'))).status).toBe(401);
    expect(calls).toEqual([]);
  });
});

describe('maintenance cron — the core sweeps', () => {
  it('runs stale-worker cleanup, abandoned path-claim release, the ended-task interactive detach, then the guessed-edge strip', async () => {
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    expect(calls).toEqual(['stale-workers', 'path-claims', 'interactive-detach', 'guessed-edges', 'lanes']);
    expect(mockStaleWorkers.mock.calls[0]![0]).toBeInstanceOf(Date);
  });

  it('returns and records what each sweep did; changed counts real repairs', async () => {
    mockStaleWorkers.mockResolvedValueOnce(2);
    mockPathClaims.mockResolvedValueOnce(3);
    mockDetach.mockResolvedValueOnce(1);
    mockGuessedEdges.mockResolvedValueOnce(4);
    mockLanes.mockResolvedValueOnce(6);
    const res = await GET(makeRequest());
    const uploads = { finalized: 2, removed: 1, waiting: 0 };
    const chatAttachments = { removed: 4, objectsRemoved: 2 };
    const teamFiles = { removed: 5, objectsRemoved: 5 };
    expect(await res.json()).toEqual({ heartbeatOrphans: 2, abandonedClaimsReleased: 3, interactiveDetached: 1, guessedEdgesStripped: 4, laneTasksSynced: 6, uploads, chatAttachments, teamFiles, oauthClientsPruned: 2, specsAutoApproved: { checked: 3, approved: 1, failed: 0 } });
    const row = cronRunRows.find(r => r.job === 'maintenance');
    expect(row).toMatchObject({ ok: true, changed: 25, errors: 0, result: { heartbeatOrphans: 2, abandonedClaimsReleased: 3, interactiveDetached: 1, guessedEdgesStripped: 4, laneTasksSynced: 6, uploads, chatAttachments, teamFiles, oauthClientsPruned: 2, specsAutoApproved: { checked: 3, approved: 1, failed: 0 } } });
  });

  it('a failing chat attachment sweep is logged and reads as nothing removed', async () => {
    mockChatAttachments.mockRejectedValueOnce(new Error('boom'));
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    expect((await res.json()).chatAttachments).toEqual({ removed: 0, objectsRemoved: 0 });
  });

  it('a failing no-criteria-change spec sweep is logged and reads as nothing approved', async () => {
    mockSpecSweep.mockRejectedValueOnce(new Error('boom'));
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    expect((await res.json()).specsAutoApproved).toEqual({ checked: 0, approved: 0, failed: 0 });
  });

  it('a failing deleted-team file sweep is logged and reads as nothing removed', async () => {
    mockTeamFiles.mockRejectedValueOnce(new Error('boom'));
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    expect((await res.json()).teamFiles).toEqual({ removed: 0, objectsRemoved: 0 });
  });
});

describe('the split from the schedules tick', () => {
  const schedulesSrc = readFileSync(join(import.meta.dir, '..', 'schedules', 'route.ts'), 'utf8');

  it('schedules no longer runs the core sweeps, so they run exactly once an hour', () => {
    expect(schedulesSrc).not.toContain('runStaleWorkerCleanup');
    expect(schedulesSrc).not.toContain('sweepAbandonedPathClaims');
  });
});
