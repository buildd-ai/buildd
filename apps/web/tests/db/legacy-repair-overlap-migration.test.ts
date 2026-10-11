import { beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { sql } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { tasks } from '@buildd/core/db/schema';
import { depsGate } from '@/app/api/workers/claim/deps-gate';
import { evaluateSoftOverlaps } from '@/app/api/workers/claim/soft-overlap-gate';
import { assertDbConfigured, q, seedTask, seedWorkspace } from './harness';

// Read the shipped SQL, rather than mirroring the conversion in TypeScript.
const migration = readFileSync(join(import.meta.dir, '../../../../packages/core/drizzle/0282_legacy_repair_overlap_edges.sql'), 'utf8');
const run = () => db.execute(sql.raw(migration));
let workspaceId: string;
beforeAll(async () => {
  assertDbConfigured();
  ({ workspaceId } = await seedWorkspace());
});
const row = async (id: string) => (await q<{ depends_on: string[]; path_declaration: any }>(sql`SELECT depends_on, path_declaration FROM tasks WHERE id = ${id}::uuid`))[0];
async function legacy(holder: string, opts: { status?: string; taskClass?: string; marker?: number | null; declaration?: unknown } = {}) {
  const id = await seedTask(workspaceId, { status: opts.status ?? 'pending', pathManifest: ['packages/core/drizzle'], dependsOn: [holder] });
  await q(sql`UPDATE tasks SET task_class = ${opts.taskClass ?? 'attempt'}, conflict_retry_pr_number = ${opts.marker === undefined ? 42 : opts.marker}, path_declaration = ${opts.declaration ? JSON.stringify(opts.declaration) : null}::jsonb WHERE id = ${id}::uuid`);
  return id;
}
describe('legacy conflict and migration-collision overlap repair', () => {
  test('untagged inferred edges leave the dependency gate and do not recreate the subject PR cycle at claim', async () => {
    const holder = await seedTask(workspaceId, { pathManifest: ['packages/core/drizzle/0400_x.sql'] });
    const id = await legacy(holder);
    const claimable = async () => (await db.select({ id: tasks.id }).from(tasks).where(sql`${tasks.id} = ${id}::uuid AND ${depsGate()}`)).length === 1;
    expect(await claimable()).toBe(false);
    await run();
    expect(await claimable()).toBe(true);
    const r = await row(id);
    expect(r.depends_on).toEqual([]);
    expect(r.path_declaration).toMatchObject({ overlapPolicy: 'v2', softOverlaps: [{ taskId: holder, paths: [], kind: 'legacy_inferred' }] });
    expect(evaluateSoftOverlaps({ id, pathManifest: ['packages/core/drizzle'], pathDeclaration: r.path_declaration }, new Map([[holder, { id: holder, status: 'pending', pathManifest: ['packages/core/drizzle/0400_x.sql'], workerStatus: null, title: null }]]), { isHardSurface: () => false, repairSubjectPrs: [{ prNumber: 42, pathManifest: ['packages/core/drizzle'] }] })).toEqual([]);
    const once = await row(id);
    await run();
    expect(await row(id)).toEqual(once);
  });
  test('normal tasks, other attempts, running rows and v2 rows retain their dependencies', async () => {
    const holder = await seedTask(workspaceId);
    const ids = await Promise.all([
      legacy(holder, { taskClass: 'work' }),
      legacy(holder, { marker: null }),
      legacy(holder, { status: 'in_progress' }),
      legacy(holder, { declaration: { overlapPolicy: 'v2', inferredDependsOn: [holder] } }),
    ]);
    const before = await Promise.all(ids.map(row));
    await run();
    expect(await Promise.all(ids.map(row))).toEqual(before);
  });
  test('preserves declaration metadata and prior soft evidence', async () => {
    const holder = await seedTask(workspaceId);
    const declaration = { declared: ['packages/core/drizzle'], source: 'creation', inferredDependsOn: [holder], softOverlaps: [{ taskId: 'generic-holder', paths: [], kind: 'prefix' }] };
    const id = await legacy(holder, { declaration });
    await run();
    expect((await row(id)).path_declaration).toEqual({ declared: declaration.declared, source: declaration.source, overlapPolicy: 'v2', softOverlaps: [...declaration.softOverlaps, { taskId: holder, paths: [], kind: 'legacy_inferred' }] });
  });
});
