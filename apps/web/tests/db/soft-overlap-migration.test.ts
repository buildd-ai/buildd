/**
 * Migration 0265 against real Postgres: a pending task's legacy inferred
 * path-overlap edges leave depends_on (so the dependency gate stops blocking on
 * them) and become soft evidence the claim route decides on. Caller-supplied
 * edges, non-pending rows and already-converted rows are untouched, and a
 * re-run changes nothing. CI migrates the DB before this runs, so the test
 * seeds legacy-shaped rows and replays the migration's SQL over them.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { sql } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { tasks } from '@buildd/core/db/schema';
import { depsGate } from '@/app/api/workers/claim/deps-gate';
import { assertDbConfigured, q, seedTask, seedWorkspace } from './harness';

const MIGRATION = readFileSync(
  join(import.meta.dir, '../../../../packages/core/drizzle/0265_soft_overlap_legacy_edges.sql'),
  'utf8',
);
const runMigration = () => db.execute(sql.raw(MIGRATION));

let workspaceId: string;
beforeAll(async () => {
  assertDbConfigured();
  ({ workspaceId } = await seedWorkspace());
});

async function seedLegacy(opts: { status?: string; dependsOn: string[]; inferred: string[]; policy?: 'v2' }): Promise<string> {
  const id = await seedTask(workspaceId, { status: opts.status ?? 'pending', pathManifest: ['scripts/'], dependsOn: opts.dependsOn });
  const decl = { declared: ['scripts/'], source: 'creation', snapshotAt: '2026-01-01T00:00:00.000Z', inferredDependsOn: opts.inferred, ...(opts.policy ? { overlapPolicy: opts.policy } : {}) };
  await q(sql`UPDATE tasks SET path_declaration = ${JSON.stringify(decl)}::jsonb WHERE id = ${id}::uuid`);
  return id;
}

const row = async (id: string) =>
  (await q<{ depends_on: string[]; path_declaration: Record<string, any> }>(sql`SELECT depends_on, path_declaration FROM tasks WHERE id = ${id}::uuid`))[0];

const passesDepsGate = async (id: string) =>
  (await db.select({ id: tasks.id }).from(tasks).where(sql`${tasks.id} = ${id}::uuid AND ${depsGate()}`)).length === 1;

describe('migration 0265: legacy inferred edges become soft', () => {
  test('a pending task keeps its declared edge, loses the inferred ones, and records them as soft evidence', async () => {
    const declared = await seedTask(workspaceId, { status: 'in_progress' });
    const inferredA = await seedTask(workspaceId, { status: 'in_progress', pathManifest: ['scripts/a.ts'] });
    const inferredB = await seedTask(workspaceId, { status: 'pending', pathManifest: ['scripts/b.ts'] });
    const id = await seedLegacy({ dependsOn: [declared, inferredA, inferredB], inferred: [inferredA, inferredB] });

    await runMigration();

    const r = await row(id);
    expect(r.depends_on).toEqual([declared]);
    expect(r.path_declaration.inferredDependsOn).toBeUndefined();
    expect(r.path_declaration.overlapPolicy).toBe('v2');
    expect(r.path_declaration.softOverlaps).toEqual([
      { taskId: inferredA, paths: [], kind: 'legacy_inferred' },
      { taskId: inferredB, paths: [], kind: 'legacy_inferred' },
    ]);
    expect(r.path_declaration.declared).toEqual(['scripts/']);
  });

  test('a task blocked only by inferred edges passes the dependency gate afterwards', async () => {
    const holder = await seedTask(workspaceId, { status: 'in_progress', pathManifest: ['scripts/x.ts'] });
    const id = await seedLegacy({ dependsOn: [holder], inferred: [holder] });
    expect(await passesDepsGate(id)).toBe(false);

    await runMigration();

    expect(await passesDepsGate(id)).toBe(true);
    expect((await row(id)).depends_on).toEqual([]);
  });

  test('non-pending and already-converted rows are untouched, and a re-run is a no-op', async () => {
    const holder = await seedTask(workspaceId, { status: 'in_progress' });
    const running = await seedLegacy({ status: 'in_progress', dependsOn: [holder], inferred: [holder] });
    const converted = await seedLegacy({ dependsOn: [holder], inferred: [holder], policy: 'v2' });
    const pending = await seedLegacy({ dependsOn: [holder], inferred: [holder] });

    await runMigration();
    const once = await row(pending);
    await runMigration();

    expect((await row(running)).depends_on).toEqual([holder]);
    expect((await row(running)).path_declaration.inferredDependsOn).toEqual([holder]);
    expect((await row(converted)).depends_on).toEqual([holder]);
    expect(await row(pending)).toEqual(once);
  });
});
