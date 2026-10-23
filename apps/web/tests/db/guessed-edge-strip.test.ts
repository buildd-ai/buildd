/**
 * The maintenance cron's guessed-edge strip (spec 75217f55 R-4, AC-7), against
 * real Postgres: the read selects the rows carrying guesses, the compare-and-set
 * write lands, a concurrent edit wins, and the stripped task is woken through
 * the outbox. The pure rule is unit-tested beside the code
 * (apps/web/src/app/api/cron/maintenance/guessed-edges.test.ts).
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { tasks } from '@buildd/core/db/schema';
import { depsGate } from '@/app/api/workers/claim/deps-gate';
import { stripGuessedEdgesFrom, sweepGuessedEdges, type GuessedEdgeRow } from '@/app/api/cron/maintenance/guessed-edges';
import { assertDbConfigured, outboxFor, q, seedTask, seedWorkspace } from './harness';

let workspaceId: string;
beforeAll(async () => {
  assertDbConfigured();
  ({ workspaceId } = await seedWorkspace());
});

const row = async (id: string) => (await q<{ depends_on: string[]; path_declaration: any }>(sql`SELECT depends_on, path_declaration FROM tasks WHERE id = ${id}::uuid`))[0];
const depWakes = async (id: string) => (await outboxFor(id)).filter(r => r.causes.includes('dependency.satisfied'));
const claimable = async (id: string) => (await db.select({ id: tasks.id }).from(tasks).where(sql`${tasks.id} = ${id}::uuid AND ${depsGate()}`)).length === 1;
const setDecl = (id: string, decl: unknown, extra = sql``) =>
  q(sql`UPDATE tasks SET path_declaration = ${JSON.stringify(decl)}::jsonb ${extra} WHERE id = ${id}::uuid`);
const readRow = async (id: string): Promise<GuessedEdgeRow> => {
  const [r] = await db.select({
    id: tasks.id, status: tasks.status, taskClass: tasks.taskClass, conflictRetryPrNumber: tasks.conflictRetryPrNumber,
    dependsOn: tasks.dependsOn, pathDeclaration: tasks.pathDeclaration,
  }).from(tasks).where(sql`${tasks.id} = ${id}::uuid`);
  return r as GuessedEdgeRow;
};

describe('guessed-edge strip on real Postgres', () => {
  test('AC-7: one declared and two guessed edges: only the declared remains, the task is woken, a second run writes nothing', async () => {
    const declared = await seedTask(workspaceId, { status: 'in_progress' });
    const g1 = await seedTask(workspaceId);
    const g2 = await seedTask(workspaceId, { status: 'in_progress' });
    const t = await seedTask(workspaceId, { dependsOn: [declared, g1, g2] });
    await setDecl(t, { declared: ['apps/web/src/x.ts'], overlapPolicy: 'v2', inferredDependsOn: [g1, g2], softOverlaps: [{ taskId: g1, paths: ['apps'], kind: 'prefix' }] });

    await sweepGuessedEdges();
    const after = await row(t);
    expect(after.depends_on).toEqual([declared]);
    expect(after.path_declaration).toEqual({ declared: ['apps/web/src/x.ts'], overlapPolicy: 'v2', inferredDependsOn: [] });
    expect(await depWakes(t)).toHaveLength(1);
    // Still held by the declared edge: the strip never touches it.
    expect(await claimable(t)).toBe(false);

    // Compare which outbox rows exist, not their delivery state: delivery runs
    // asynchronously after the wake and may advance between the two reads.
    const outboxRows = async () => (await outboxFor(t)).map(r => ({ id: r.id, causes: r.causes }));
    const outboxBefore = await outboxRows();
    await sweepGuessedEdges();
    expect(await row(t)).toEqual(after);
    expect(await outboxRows()).toEqual(outboxBefore);
  });

  test('a task held only by guesses becomes claimable', async () => {
    const holder = await seedTask(workspaceId, { status: 'in_progress' });
    const t = await seedTask(workspaceId, { dependsOn: [holder] });
    await setDecl(t, { inferredDependsOn: [holder] });
    expect(await claimable(t)).toBe(false);
    await sweepGuessedEdges();
    expect(await claimable(t)).toBe(true);
  });

  test('legacy conflict attempts with untagged guesses are stripped and marked v2, as 0276 does', async () => {
    const holder = await seedTask(workspaceId);
    const t = await seedTask(workspaceId, { dependsOn: [holder] });
    await q(sql`UPDATE tasks SET task_class = 'attempt', conflict_retry_pr_number = 42 WHERE id = ${t}::uuid`);
    await sweepGuessedEdges();
    expect(await row(t)).toEqual({ depends_on: [], path_declaration: { overlapPolicy: 'v2', inferredDependsOn: [] } });
    expect(await depWakes(t)).toHaveLength(1);
  });

  test('declared-only, non-pending and malformed rows are left alone', async () => {
    const holder = await seedTask(workspaceId, { status: 'in_progress' });
    const declaredOnly = await seedTask(workspaceId, { dependsOn: [holder] });
    await setDecl(declaredOnly, { overlapPolicy: 'v2', inferredDependsOn: [] });
    const running = await seedTask(workspaceId, { status: 'in_progress', dependsOn: [holder] });
    await setDecl(running, { inferredDependsOn: [holder] });
    const malformed = await seedTask(workspaceId, { dependsOn: [holder] });
    await setDecl(malformed, { inferredDependsOn: 'nope', softOverlaps: {} });
    const ids = [declaredOnly, running, malformed];
    const before = await Promise.all(ids.map(row));
    try {
      await sweepGuessedEdges();
      expect(await Promise.all(ids.map(row))).toEqual(before);
    } finally {
      // Other files in this database run migrations over every pending task
      // (0267, 0276) and expect well-formed declarations: leave none behind.
      await q(sql`DELETE FROM tasks WHERE id = ${malformed}::uuid`);
    }
  });

  test('a concurrent edit between read and write wins; the next run strips the row as it now stands', async () => {
    const declared = await seedTask(workspaceId, { status: 'in_progress' });
    const guess = await seedTask(workspaceId, { status: 'in_progress' });
    const late = await seedTask(workspaceId, { status: 'in_progress' });
    const t = await seedTask(workspaceId, { dependsOn: [declared, guess] });
    await setDecl(t, { inferredDependsOn: [guess] });
    const stale = await readRow(t);

    // Someone declares another edge after the sweep read the row.
    await q(sql`UPDATE tasks SET depends_on = ${JSON.stringify([declared, guess, late])}::jsonb WHERE id = ${t}::uuid`);
    expect(await stripGuessedEdgesFrom([stale])).toEqual([]);
    expect((await row(t)).depends_on).toEqual([declared, guess, late]);

    expect(await stripGuessedEdgesFrom([await readRow(t)])).toEqual([t]);
    expect((await row(t)).depends_on).toEqual([declared, late]);
  });
});
