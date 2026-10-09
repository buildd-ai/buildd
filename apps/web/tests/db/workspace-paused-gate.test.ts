/**
 * The workspace "pause new starts" gate, against real Postgres: a workspace whose
 * new_starts_paused_until is still ahead keeps its tasks out of a runner claim;
 * a past or empty one does not (so the pause ends on its own).
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { and, inArray, sql } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { tasks } from '@buildd/core/db/schema';
import { workspaceNotPausedGate } from '@/app/api/workers/claim/workspace-paused-gate';
import { assertDbConfigured, q, seedTask, seedWorkspace } from './harness';

const NOW = new Date();
const HOUR = 3_600_000;

async function seed(pausedUntil: Date | null): Promise<string> {
  const { workspaceId } = await seedWorkspace({});
  if (pausedUntil) {
    await q(sql`UPDATE workspaces SET new_starts_paused_until = ${pausedUntil.toISOString()}::timestamptz WHERE id = ${workspaceId}::uuid`);
  }
  return seedTask(workspaceId);
}

let t: Record<string, string>;
beforeAll(async () => {
  assertDbConfigured();
  const cases: Record<string, Date | null> = {
    notPaused: null,
    pausedAhead: new Date(NOW.getTime() + HOUR),
    pauseEnded: new Date(NOW.getTime() - HOUR),
  };
  const ids = await Promise.all(Object.values(cases).map(seed));
  t = Object.fromEntries(Object.keys(cases).map((k, i) => [k, ids[i]]));
}, 30_000);

describe('workspaceNotPausedGate', () => {
  test('only the workspace with a pause still ahead is skipped', async () => {
    const rows = await db.query.tasks.findMany({
      where: and(inArray(tasks.id, Object.values(t)), workspaceNotPausedGate(NOW)),
      columns: { id: true },
    });
    const byId = new Map(Object.entries(t).map(([k, v]) => [v, k]));
    expect(rows.map(r => byId.get(r.id)!).sort()).toEqual(['notPaused', 'pauseEnded']);
  });
});
