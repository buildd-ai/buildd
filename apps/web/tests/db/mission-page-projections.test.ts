/**
 * The mission page reads a worker's milestones projected in SQL
 * (BOARD_MILESTONES_SQL), not the whole progress log (spec 3ef37387 R-11).
 * The board's reader must not tell the two apart: `selectMilestones` over the
 * projection equals `selectMilestones` over the raw column, on real Postgres.
 */
import { describe, it, expect, beforeAll } from 'bun:test';
import { sql, eq } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { workers } from '@buildd/core/db/schema';
import { assertDbConfigured, q, seedWorkspace } from './harness';
import { tasks } from '@buildd/core/db/schema';
import {
  MISSION_WORKER_EXTRAS, TASK_DIGEST_SELECTION, digestTaskContext, digestTaskResult,
} from '../../src/app/app/(protected)/missions/[id]/mission-page-query';
import { selectMilestones } from '../../src/lib/mission-board';
import { sqlWhere } from '@buildd/core/db/relational-sql';

assertDbConfigured();

const long = 'x'.repeat(400);
const cases: Record<string, unknown> = {
  none: null,
  notArray: { label: 'not a list' },
  empty: [],
  // More than the board draws, mixed kinds and shapes, out of time order, with ties.
  busy: [
    ...Array.from({ length: 40 }, (_, i) => ({ type: 'status', label: `Step ${i}`, ts: 1_000 + (i % 7) * 10 + i })),
    { type: 'tool', label: 'Read a file', ts: 5_000 },
    { label: 'untyped', ts: 4_000 },
    { type: 'status', label: '', ts: 4_100 },
    { type: 'status', label: 'string time', ts: '4200' },
    { type: 'status', label: 'legacy time', timestamp: 4_300 },
    { type: 'status', label: long, ts: 4_400 },
    { type: 'status', label: 'tie a', ts: 4_500 },
    { type: 'status', label: 'tie b', ts: 4_500 },
    'not an object',
    null,
  ],
  exactLimit: [{ type: 'status', label: 'y'.repeat(160), ts: 1 }, { type: 'status', label: 'z'.repeat(161), ts: 2 }],
};

const ids = new Map<string, string>();
const digestCases: Array<{ context: unknown; result: unknown }> = [
  { context: null, result: null },
  { context: {}, result: {} },
  {
    context: {
      reviewerFor: 'task-x', budgetExhausted: true, infraRetryCount: 2, refreshTrunk: 'dev', requireMergeCommit: true,
      surfaceFix: { route: '/x', big: 'y'.repeat(500) }, finalVerification: 'not an object', specRepair: { a: 1 },
      failureContext: { errorType: 'boom', summary: 'Worktree setup failed', log: 'z'.repeat(2000) },
      prompt: 'p'.repeat(5000), iteration: 3,
    },
    result: { summary: 'Did it', errorType: 'infra_stalled', error: 'stalled', structuredOutput: { verdict: 'pass', huge: 'q'.repeat(3000) }, transcript: 't'.repeat(4000) },
  },
  { context: { failureContext: { log: 'only a log' } }, result: { structuredOutput: { other: 1 } } },
];
const digestIds: string[] = [];

beforeAll(async () => {
  const { workspaceId } = await seedWorkspace();
  for (const c of digestCases) {
    const [t] = await q<{ id: string }>(sql`
      INSERT INTO tasks (workspace_id, title, status, context, result)
      VALUES (${workspaceId}::uuid, 'digest', 'completed', ${c.context == null ? null : JSON.stringify(c.context)}::jsonb, ${c.result == null ? null : JSON.stringify(c.result)}::jsonb)
      RETURNING id`);
    digestIds.push(t.id);
  }
  const [task] = await q<{ id: string }>(sql`INSERT INTO tasks (workspace_id, title, status) VALUES (${workspaceId}::uuid, 'milestones', 'in_progress') RETURNING id`);
  for (const [name, milestones] of Object.entries(cases)) {
    const [w] = await q<{ id: string }>(sql`
      INSERT INTO workers (task_id, workspace_id, name, runner, branch, status, milestones)
      VALUES (${task.id}::uuid, ${workspaceId}::uuid, ${name}, 'runner', ${`b-${name}`}, 'running', ${milestones == null ? null : JSON.stringify(milestones)}::jsonb)
      RETURNING id`);
    ids.set(name, w.id);
  }
});

describe('the page\'s milestone projection (R-11)', () => {
  for (const name of Object.keys(cases)) {
    it(`reads the same milestones as the raw column: ${name}`, async () => {
      const row = await db.query.workers.findFirst({
        where: sqlWhere(eq(workers.id, ids.get(name)!)),
        columns: { milestones: true },
        extras: { projected: MISSION_WORKER_EXTRAS.milestones },
      }) as { milestones: unknown; projected: unknown };
      expect(selectMilestones(row.projected)).toEqual(selectMilestones(row.milestones));
      expect(Array.isArray(row.projected)).toBe(true);
    });
  }

  it('sends a bounded tail, not the log', async () => {
    const row = await db.query.workers.findFirst({
      where: sqlWhere(eq(workers.id, ids.get('busy')!)),
      columns: { milestones: true },
      extras: { projected: MISSION_WORKER_EXTRAS.milestones },
    }) as { milestones: unknown[]; projected: unknown[] };
    expect(row.projected.length).toBe(24);
    expect(JSON.stringify(row.projected).length).toBeLessThan(JSON.stringify(row.milestones).length);
  });
});

describe('the page\'s task digest equals its JS twin on real Postgres (R-11)', () => {
  it('context and result, markers and nested keys included', async () => {
    for (const [i, id] of digestIds.entries()) {
      const [row] = await db.select(TASK_DIGEST_SELECTION).from(tasks).where(eq(tasks.id, id));
      expect(row.context ?? null).toEqual(digestTaskContext(digestCases[i].context));
      expect(row.result ?? null).toEqual(digestTaskResult(digestCases[i].result));
    }
  });
});
