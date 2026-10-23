/**
 * Acceptance checks for Living Spec 75217f55 "Overlap scheduling: serial lanes
 * and file locks", revision 1. Written before the build: each test fails on the
 * starting commit and passes once the spec is built. A check named here is
 * listed in the spec's metadata `verified_by`, keyed by its id.
 *
 * The tests read seams that exist today (the overlap partition, the pure claim
 * coordination gates, the shared check_path_claim implementation) and, for what
 * the spec removes, the source of the claim route, so they do not dictate the
 * names the build gives new things. Checks that need a database or a new
 * interface to observe are not here; the task that wrote this lists them.
 */
import { describe, expect, it, mock } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as pathOverlap from '@buildd/core/path-overlap';

const SRC = join(import.meta.dir, '..', '..', 'src');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');
/** Source with comments removed, so a retired name in a doc comment is not a use. */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/** A short failure message: a whole source file must never end up in the test output. */
function absent(text: string, pattern: RegExp, where: string): void {
  if (pattern.test(text)) throw new Error(`${where} still matches ${String(pattern)}`);
}
function present(text: string, pattern: RegExp, where: string): void {
  if (!pattern.test(text)) throw new Error(`${where} does not match ${String(pattern)}`);
}

const CLAIM_ROUTE = 'app/api/workers/claim/route.ts';
const LANE_FILE = 'packages/core/db/schema.ts';
const LANE_MIGRATION = 'packages/core/drizzle/20261023000000_x/migration.sql';

/** What partitionOverlapEdges returns for a new task, or nothing if the build removed it. */
function edgesFor(manifest: string[], others: Array<{ id: string; pathManifest: string[] }>) {
  const fn = (pathOverlap as Record<string, unknown>).partitionOverlapEdges as
    | undefined
    | ((m: string[], o: typeof others, opts?: object) => { hard: string[]; soft: unknown[] });
  return fn ? fn(manifest, others, { isSerialized: () => true }) : { hard: [], soft: [] };
}

describe('no guessed overlap at creation', () => {
  it('R-1: a creation-time overlap adds no dependsOn id and no softOverlaps entry', () => {
    const others = [
      { id: 'lane-peer', pathManifest: [LANE_FILE] },
      { id: 'file-peer', pathManifest: ['apps/web/src/lib/a.ts'] },
      { id: 'dir-peer', pathManifest: ['apps/web/src/lib/'] },
    ];
    expect(edgesFor([LANE_FILE, 'apps/web/src/lib/a.ts', 'apps/web/src/lib/b.ts'], others)).toEqual({ hard: [], soft: [] });
  });

  it('R-1: the task route and the conflict retry no longer derive edges from overlap', () => {
    for (const rel of ['app/api/tasks/route.ts', 'lib/conflict-retry.ts']) {
      absent(code(read(rel)), /\bpartitionOverlapEdges\s*\(/, rel);
    }
  });

  it('AC-6: a new task whose manifest overlaps a running task\'s non-lane files has empty edges', () => {
    const running = [{ id: 'running', pathManifest: ['apps/web/src/lib/explain.ts', 'apps/web/src/lib/other.ts'] }];
    const { hard, soft } = edgesFor(['apps/web/src/lib/explain.ts'], running);
    expect(hard).toEqual([]);
    expect(soft).toEqual([]);
  });
});

describe('no claim-time hold on non-lane paths', () => {
  it('R-2: the claim route has no soft-overlap gate, open-PR backstop or undeclared-scope mutex', () => {
    const route = code(read(CLAIM_ROUTE));
    absent(route, /\bevaluateSoftOverlaps\b/, CLAIM_ROUTE);
    absent(route, /\bfindBlockingPr\b/, CLAIM_ROUTE);
    absent(route, /advisory_manifest/, CLAIM_ROUTE);
  });

  it('R-2: the shared coordination gates do not hold a task on an open PR or lease over non-lane files', async () => {
    const { evaluateCoordinationGates } = await import('../../src/app/api/workers/claim/coordination-gates');
    const manifest = ['apps/web/src/lib/explain.ts'];
    const reasons = evaluateCoordinationGates(
      { id: 'cand', missionId: null, pathManifest: manifest, workspace: { gitConfig: null } },
      {
        openPrTasks: [{ taskId: 'peer', pathManifest: manifest, prNumber: 7, prUrl: 'https://example.test/pull/7', workerStatus: 'running', prLifecycle: 'open', branch: 'buildd/peer', prBaseRef: 'dev' }],
        activeClaims: new Map([['peer', manifest]]),
        mission: null, missionActiveCount: 0, orderedBehind: null, liveTaskIds: new Set(['peer']), now: new Date(),
      },
    );
    expect(reasons).toEqual([]);
  });

  it('AC-1: two tasks sharing a non-lane file get no edge and no coordination hold', async () => {
    const { evaluateCoordinationGates } = await import('../../src/app/api/workers/claim/coordination-gates');
    const shared = ['apps/web/src/lib/explain.ts'];
    expect(edgesFor(shared, [{ id: 'b', pathManifest: shared }])).toEqual({ hard: [], soft: [] });
    const snapshot = { openPrTasks: [], activeClaims: null, mission: null, missionActiveCount: 0, orderedBehind: null, liveTaskIds: new Set<string>(), now: new Date() };
    for (const task of [{ id: 'a', pathManifest: shared }, { id: 'b', pathManifest: shared }]) {
      expect(evaluateCoordinationGates({ ...task, missionId: null, workspace: { gitConfig: null } }, snapshot)).toEqual([]);
    }
  });

  it('R-3: the claim route does not turn the model\'s overlap HOLD/START into a claim decision', () => {
    const route = code(read(CLAIM_ROUTE));
    for (const name of ['acquireGatedStartPaths', 'releaseGatedStartPaths', 'openPrStartVerdict', 'softOverlapStartVerdict', 'scheduleClaimHoldShadow']) {
      absent(route, new RegExp(`\\b${name}\\b`), CLAIM_ROUTE);
    }
  });
});

describe('serial lane for migration and schema paths', () => {
  const laneTask = (id: string) => ({ id, missionId: null, pathManifest: [LANE_MIGRATION], workspace: { gitConfig: null } });
  const snapshot = (holder: boolean) => ({
    openPrTasks: holder
      ? [{ taskId: 'task-a', pathManifest: [LANE_MIGRATION], prNumber: 7, prUrl: 'https://example.test/pull/7', workerStatus: 'running', prLifecycle: 'open', branch: 'buildd/task-a', prBaseRef: 'dev' }]
      : [],
    activeClaims: holder ? new Map([['task-a', [LANE_MIGRATION]]]) : null,
    mission: null, missionActiveCount: 0, orderedBehind: null, liveTaskIds: new Set(holder ? ['task-a'] : []), now: new Date(),
  });

  it('AC-2: a lane task is refused naming the holding task, and released when the holder is gone', async () => {
    const { evaluateCoordinationGates } = await import('../../src/app/api/workers/claim/coordination-gates');
    const refused = evaluateCoordinationGates(laneTask('task-b'), snapshot(true));
    expect(refused.length).toBeGreaterThan(0);
    // The lane reason names the holding task and says where the refused task stands in the lane.
    expect(JSON.stringify(refused)).toMatch(/task-a/);
    expect(JSON.stringify(refused)).toMatch(/position/i);
    expect(evaluateCoordinationGates(laneTask('task-b'), snapshot(false))).toEqual([]);
  });

  it('AC-4: check_path_claim on a lane file held by another task returns 409 data naming the holder and a position', async () => {
    const tasksFindFirst = mock(async () => ({ id: 'task-b', workspaceId: 'ws', missionId: null, status: 'in_progress', pathManifest: null, title: 'Holder' }));
    mock.module('@buildd/core/db', () => ({ db: { query: { tasks: { findFirst: tasksFindFirst } }, insert: () => ({ values: async () => [] }) } }));
    mock.module('@buildd/core/path-claim', () => ({
      acquirePathClaims: async () => ({ kind: 'conflict', conflict: { blockingTaskId: 'task-a', blockingPath: LANE_FILE }, blocked: [] }),
      narrowPathClaims: async () => ({ kind: 'not_found' }),
      registerWaiter: async () => ({ registered: true }),
    }));
    mock.module('@/lib/path-claim-release', () => ({ deliverPathReleased: async () => {} }));
    const { GATE_SLUGS } = await import('@buildd/core/gate-slugs');
    mock.module('@/lib/gate-ledger', () => ({ GATE_SLUGS, fireGateEvent: () => 'sig', gateCallerOrigin: () => 'worker' }));
    const { checkPathClaim } = await import('../../src/lib/path-claim-check');
    const r = await checkPathClaim({ taskId: 'task-b', paths: [LANE_FILE], surface: 'test', callerOrigin: 'worker' });
    expect(r.kind).toBe('conflict');
    const body = JSON.stringify((r as { body: unknown }).body);
    expect(body).toContain('task-a');
    expect(body).toMatch(/position/i);
  });
});

describe('one-time repair of guessed edges', () => {
  it('R-4: the maintenance cron strips inferred dependsOn ids and clears softOverlaps, compare-and-set', () => {
    const dir = 'app/api/cron/maintenance';
    const files = ['route.ts', 'path-claims.ts', 'overlap-repair.ts', 'guessed-edges.ts'].map(f => join(dir, f)).filter(f => existsSync(join(SRC, f)));
    const text = code(files.map(read).join('\n'));
    present(text, /inferredDependsOn/, 'the maintenance cron');
    present(text, /softOverlaps/, 'the maintenance cron');
  });
});
