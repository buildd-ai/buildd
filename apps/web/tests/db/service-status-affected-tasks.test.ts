/**
 * The service-status read's second round on a real database: the tasks an
 * active root cause names, each with whether it has a live run, in one round
 * trip (Fast at any size R-6: Health Overview and Home pay it on every load
 * while a cause is active).
 */
import { describe, expect, test, beforeAll } from 'bun:test';
import { sql } from 'drizzle-orm';
import { db, recordNeonQueries } from '@buildd/core/db';
import { assertDbConfigured, q, seedTask, seedWorkspace } from './harness';
import { serviceStatusReads } from '../../src/lib/service-status-loader';

assertDbConfigured();

let teamId: string;
let liveTask: string;
let idleTask: string;

beforeAll(async () => {
  const ws = await seedWorkspace();
  teamId = ws.teamId;
  liveTask = await seedTask(ws.workspaceId, { status: 'in_progress' });
  idleTask = await seedTask(ws.workspaceId, { status: 'pending' });
  await q(sql`INSERT INTO workers (task_id, workspace_id, name, runner, branch, status)
    VALUES (${liveTask}::uuid, ${ws.workspaceId}::uuid, 'live', 'r', 'b', 'running'),
           (${idleTask}::uuid, ${ws.workspaceId}::uuid, 'done', 'r', 'b', 'failed')`);
  await q(sql`
    INSERT INTO root_causes (team_id, key, capability_kind, component, workspace_id, classification, affected_task_ids, first_seen_at, last_seen_at)
    VALUES (${teamId}::uuid, 'test:affected', 'platform', 'infrastructure_failure', ${ws.workspaceId}::uuid, 'unknown',
      ARRAY[${liveTask}::uuid, ${idleTask}::uuid], now(), now())`);
});

describe('service status: affected tasks', () => {
  test('each named task carries whether it has a live run, read in one round trip', async () => {
    const plan = await serviceStatusReads(teamId);
    const first = await db.batch(plan.queries as never) as unknown[];
    const rec = await recordNeonQueries(() => plan.facts(first));
    expect(rec.count).toBe(1);
    const byId = new Map(rec.result.tasks.map(t => [t.id, t.hasLiveRun]));
    expect(byId.get(liveTask)).toBe(true);
    expect(byId.get(idleTask)).toBe(false);
  });
});
