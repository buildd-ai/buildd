/**
 * The closed-PR supersession sweep's queue (lib/pr-supersession-detect.ts), on real Postgres.
 *
 * Review of #4822: a row the sweep's budget cut off is left unstamped, and `workers.updatedAt`
 * does not move on a JSON write, so ordering by "never scanned first, then updatedAt" put the same
 * slow row first every hour and the rows behind it never ran. Every unfinished attempt now records
 * `supersessionScan.lastAttemptAt`, and the queue orders by the later of that and the last finished
 * scan: never-tried rows first, then whichever was looked at longest ago.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { assertDbConfigured, q, seedMission, seedTask, seedWorkspace } from './harness';
import { closedPrSweepQueue } from '../../src/lib/pr-supersession-detect';

let workspaceId = '';
// Unique per run, so a rerun against the same database reads only its own rows.
const base = 100_000 + Math.floor(Math.random() * 800_000);
let taskId = '';
const now = new Date('2026-10-15T08:10:00Z');
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);

async function seedClosedPr(offset: number, opts: { scannedAt?: Date | null; lastAttemptAt?: Date | null; updatedAt: Date }) {
  const n = base + offset;
  const scan = opts.lastAttemptAt
    ? JSON.stringify({ scannedAt: '', candidatesChecked: 0, suggestion: null, lastAttemptAt: opts.lastAttemptAt.toISOString() })
    : null;
  await q(sql`
    INSERT INTO workers (workspace_id, task_id, name, runner, branch, pr_url, pr_number, pr_lifecycle_status, supersession_scan, supersession_scanned_at, updated_at)
    VALUES (${workspaceId}::uuid, ${taskId}::uuid, 'w', 'test', ${`b-${n}`}, ${`https://github.com/o/r/pull/${n}`}, ${n}, 'closed',
      ${scan}::jsonb, ${opts.scannedAt?.toISOString() ?? null}::timestamptz, ${opts.updatedAt.toISOString()}::timestamptz)`);
}

beforeAll(async () => {
  assertDbConfigured();
  const ws = await seedWorkspace();
  workspaceId = ws.workspaceId;
  const missionId = await seedMission(ws.teamId, workspaceId);
  taskId = await seedTask(workspaceId, { status: 'completed', missionId });
  // #1: oldest updatedAt, but the sweep already tried it an hour ago and ran out of time.
  await seedClosedPr(1, { lastAttemptAt: hoursAgo(1), updatedAt: hoursAgo(100) });
  // #2: never tried.
  await seedClosedPr(2, { updatedAt: hoursAgo(50) });
  // #3: scanned four days ago: due for a rescan, and looked at longer ago than #1.
  await seedClosedPr(3, { scannedAt: hoursAgo(96), updatedAt: hoursAgo(10) });
  // #4: scanned an hour ago: inside the rescan window, not due.
  await seedClosedPr(4, { scannedAt: hoursAgo(1), updatedAt: hoursAgo(200) });
});

describe('closedPrSweepQueue', () => {
  test('never-tried rows first, then by when each was last looked at; a cut-off attempt rotates to the back', async () => {
    const ours = new Set([1, 2, 3, 4].map(o => `https://github.com/o/r/pull/${base + o}`));
    const rows = (await closedPrSweepQueue(now, 10_000)).filter(r => r.prUrl && ours.has(r.prUrl));
    expect(rows.map(r => Number(r.prUrl!.split('/').pop()) - base)).toEqual([2, 3, 1]);
  });

  test('a malformed lastAttemptAt in supersessionScan does not crash the query', async () => {
    // Insert a row with a malformed lastAttemptAt that would fail if cast to timestamptz.
    const n = base + 100;
    await q(sql`
      INSERT INTO workers (workspace_id, task_id, name, runner, branch, pr_url, pr_number, pr_lifecycle_status, supersession_scan, updated_at)
      VALUES (${workspaceId}::uuid, ${taskId}::uuid, 'w', 'test', ${`b-${n}`}, ${`https://github.com/o/r/pull/${n}`}, ${n}, 'closed',
        ${{ scannedAt: '', candidatesChecked: 0, suggestion: null, lastAttemptAt: '2026-13-40T00:00:00Z' }}::jsonb, ${now.toISOString()}::timestamptz)`);

    // The query should complete without error, treating the malformed value as NULL.
    const rows = await closedPrSweepQueue(now, 10_000);
    expect(rows).toBeDefined();
  });
});
