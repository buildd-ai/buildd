/**
 * A deleted team's stored files go with it (apps/web/src/lib/artifact-team-files.ts),
 * against real Postgres with an in-memory object store: the team delete runs
 * in one batch with the detach, then the same request removes each detached
 * row and its object. Another team's files stay; an object another row still
 * holds stays; what a crash leaves behind the sweep takes.
 */
import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import { assertDbConfigured, q, seedTask, seedWorkspace } from './harness';

const { db } = await import('@buildd/core/db');
const { artifacts, teams } = await import('@buildd/core/db/schema');
const { detachTeamStoredFiles, removeTeamStoredFiles, removeDetachedTeamFiles } = await import('../../src/lib/artifact-team-files');

const objects = new Set<string>();
const storage = {
  head: async () => null,
  sha256: async () => ({ sha256: '', sizeBytes: 0 }),
  remove: async (k: string) => { objects.delete(k); },
};
const rand = () => Math.random().toString(36).slice(2, 10);

/** A finalized upload with its object in the store. */
async function upload(cols: { workspaceId?: string; workerId?: string; visibility?: 'public' }) {
  const key = `artifacts/${cols.workspaceId ?? 'w'}/${rand()}/report.pdf`;
  const [a] = await db.insert(artifacts).values({
    workspaceId: cols.workspaceId ?? null,
    workerId: cols.workerId ?? null,
    type: 'file',
    title: 'report.pdf',
    storageKey: key,
    uploadState: 'ready',
    visibility: cols.visibility ?? 'private',
    shareToken: cols.visibility ? `tok-${rand()}` : null,
  }).returning({ id: artifacts.id });
  objects.add(key);
  objects.add(`${key}.upload`); // a staging copy a late PUT to the old upload URL left
  return { id: a!.id, key };
}

async function worker(workspaceId: string) {
  const taskId = await seedTask(workspaceId);
  const [w] = await q<{ id: string }>(sql`
    INSERT INTO workers (workspace_id, task_id, name, runner, branch)
    VALUES (${workspaceId}::uuid, ${taskId}::uuid, ${`w-${rand()}`}, 'test', ${`b-${rand()}`})
    RETURNING id`);
  return w!.id;
}

/** The team delete as the route runs it. */
async function deleteTeam(teamId: string) {
  await db.batch([detachTeamStoredFiles(teamId), db.delete(teams).where(eq(teams.id, teamId))]);
}

async function rowExists(id: string) {
  return (await db.select({ id: artifacts.id }).from(artifacts).where(eq(artifacts.id, id))).length > 0;
}

beforeAll(() => { assertDbConfigured(); });
beforeEach(() => { objects.clear(); });

describe('a deleted team’s stored files', () => {
  test('the cascade alone leaves the objects behind (the defect)', async () => {
    const a = await seedWorkspace();
    const f = await upload({ workspaceId: a.workspaceId });
    await db.delete(teams).where(eq(teams.id, a.teamId));
    expect(await rowExists(f.id)).toBe(false);
    expect(objects.has(f.key)).toBe(true);
  });

  test('two finalized uploads go with the team; another team’s stay', async () => {
    const a = await seedWorkspace();
    const b = await seedWorkspace();
    const wsFile = await upload({ workspaceId: a.workspaceId });
    const workerFile = await upload({ workerId: await worker(a.workspaceId) });
    const other = await upload({ workspaceId: b.workspaceId });

    await deleteTeam(a.teamId);
    const r = await removeTeamStoredFiles(a.teamId, { storage });

    expect(r).toEqual({ removed: 2, objectsRemoved: 2 });
    expect(objects.has(wsFile.key)).toBe(false);
    expect(objects.has(`${wsFile.key}.upload`)).toBe(false);
    expect(objects.has(workerFile.key)).toBe(false);
    expect(await rowExists(wsFile.id)).toBe(false);
    expect(await rowExists(workerFile.id)).toBe(false);
    expect(objects.has(other.key)).toBe(true);
    expect(objects.has(`${other.key}.upload`)).toBe(true);
    expect(await rowExists(other.id)).toBe(true);
  });

  test('a detached row is unreachable while it waits: no workspace, private, unshared', async () => {
    const a = await seedWorkspace();
    const f = await upload({ workspaceId: a.workspaceId, visibility: 'public' });
    await deleteTeam(a.teamId);
    const [row] = await db.select().from(artifacts).where(eq(artifacts.id, f.id));
    expect(row!.workspaceId).toBeNull();
    expect(row!.workerId).toBeNull();
    expect(row!.visibility).toBe('private');
    expect(row!.shareToken).toBeNull();
    expect((row!.metadata as { storageOrphan?: { teamId?: string } }).storageOrphan?.teamId).toBe(a.teamId);
  });

  test('an object another row still holds is kept', async () => {
    const a = await seedWorkspace();
    const b = await seedWorkspace();
    const f = await upload({ workspaceId: a.workspaceId });
    await db.insert(artifacts).values({ workspaceId: b.workspaceId, type: 'file', storageKey: f.key, uploadState: 'ready' });
    await deleteTeam(a.teamId);
    const r = await removeTeamStoredFiles(a.teamId, { storage });
    expect(r).toEqual({ removed: 1, objectsRemoved: 0 });
    expect(objects.has(f.key)).toBe(true);
  });

  test('a living team is never touched by the sweep', async () => {
    const a = await seedWorkspace();
    const f = await upload({ workspaceId: a.workspaceId });
    await removeDetachedTeamFiles({ storage });
    expect(await rowExists(f.id)).toBe(true);
    expect(objects.has(f.key)).toBe(true);
  });

  test('what a crash leaves after the delete, the sweep takes', async () => {
    const a = await seedWorkspace();
    const f = await upload({ workspaceId: a.workspaceId });
    await deleteTeam(a.teamId); // request dies before the cleanup
    expect(objects.has(f.key)).toBe(true);
    const r = await removeDetachedTeamFiles({ storage, limit: 1000 });
    expect(r.removed).toBeGreaterThanOrEqual(1);
    expect(objects.has(f.key)).toBe(false);
    expect(await rowExists(f.id)).toBe(false);
  });

  test('a storage error never fails the cleanup', async () => {
    const a = await seedWorkspace();
    const f = await upload({ workspaceId: a.workspaceId });
    await deleteTeam(a.teamId);
    const r = await removeTeamStoredFiles(a.teamId, { storage: { ...storage, remove: async () => { throw new Error('bucket down'); } } });
    expect(r).toEqual({ removed: 1, objectsRemoved: 0 });
    expect(await rowExists(f.id)).toBe(false);
  });
});
