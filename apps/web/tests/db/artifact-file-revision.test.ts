/**
 * A new body for a file artifact (upload_artifact { artifactId, filename, ... })
 * and links asked for in the upload call (upload_artifact `attach`), against
 * real Postgres with an in-memory object store: the new bytes become revision
 * N+1 only once verified, every earlier revision keeps its own object, a link
 * that follows the current body moves while a pinned one stays, and an attach
 * waits for the bytes.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'crypto';
import { eq, sql } from 'drizzle-orm';
import { assertDbConfigured, q, seedMission, seedTask, seedWorkspace } from './harness';

const { db } = await import('@buildd/core/db');
const { artifacts, artifactLinks } = await import('@buildd/core/db/schema');
const { finalizeArtifactUpload, startFileRevision, revisionStorageKey } = await import('../../src/lib/artifact-upload');
const { linkArtifact, artifactsLinkedTo, checkPendingLink, PENDING_LINKS_KEY } = await import('../../src/lib/artifact-links');
const { getArtifactRevision } = await import('../../src/lib/artifact-revisions');
const { uploadStagingKey } = await import('../../src/lib/storage-keys');

const objects = new Map<string, Buffer>();
const types = new Map<string, string>();
const storage = {
  head: async (k: string) => (objects.has(k) ? { sizeBytes: objects.get(k)!.byteLength, contentType: types.get(k) ?? 'text/html' } : null),
  sha256: async (k: string) => ({ sha256: createHash('sha256').update(objects.get(k)!).digest('hex'), sizeBytes: objects.get(k)!.byteLength }),
  copy: async (from: string, to: string) => { objects.set(to, objects.get(from)!); },
  remove: async (k: string) => { objects.delete(k); },
};
const sign = async (key: string) => `https://r2.example/${key}`;
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

let teamId: string; let workspaceId: string; let missionId: string; let taskId: string;
let userId: string;

async function readyDesign(bytes: Buffer) {
  const key = `artifacts/${workspaceId}/${crypto.randomUUID()}/nav.html`;
  const [a] = await db.insert(artifacts).values({
    workspaceId, type: 'file', title: 'Navigation', storageKey: key, uploadState: 'pending',
    metadata: { filename: 'nav.html', mimeType: 'text/html', sizeBytes: bytes.byteLength, kind: 'design', screens: [{ id: 'home', name: 'Home', viewport: '1440x900' }] },
  }).returning();
  objects.set(uploadStagingKey(key), bytes);
  expect((await finalizeArtifactUpload(a.id, { storage })).state).toBe('ready');
  return { id: a.id, key };
}
const row = async (id: string) => (await db.select().from(artifacts).where(eq(artifacts.id, id)))[0]!;

beforeAll(async () => {
  assertDbConfigured();
  ({ teamId, workspaceId } = await seedWorkspace());
  missionId = await seedMission(teamId, workspaceId);
  taskId = await seedTask(workspaceId, { missionId });
  const [u] = await q<{ id: string }>(sql`INSERT INTO users (email) VALUES (${`u-${crypto.randomUUID()}@example.test`}) RETURNING id`);
  await q(sql`INSERT INTO team_members (team_id, user_id, role) VALUES (${teamId}::uuid, ${u.id}::uuid, 'owner')`);
  userId = u.id;
});

describe('a second upload to the same artifact', () => {
  test('becomes revision 2 once verified; revision 1 stays readable with its own bytes', async () => {
    const v1 = Buffer.from('<html>v1</html>');
    const d = await readyDesign(v1);
    const v2 = Buffer.from('<html>version two</html>');
    const started = await startFileRevision(d.id, { filename: 'nav.html', mimeType: 'text/html', sizeBytes: v2.byteLength, author: `user:${userId}`, metadata: { screens: [{ id: 'home', name: 'Home', viewport: '390x844' }] } }, sign);
    expect(started).toMatchObject({ ok: true, revision: 2 });
    if (!started.ok) return;
    expect(started.storageKey).toBe(revisionStorageKey(workspaceId, d.id, 2, 'nav.html'));
    expect(started.uploadUrl).toContain(uploadStagingKey(started.storageKey));

    // Until the bytes arrive, readers keep revision 1.
    expect(await finalizeArtifactUpload(d.id, { storage })).toEqual({ state: 'pending', reason: 'not_uploaded' });
    expect((await row(d.id)).storageKey).toBe(d.key);

    objects.set(uploadStagingKey(started.storageKey), v2);
    expect(await finalizeArtifactUpload(d.id, { storage, expectedSha256: sha(v2) })).toEqual({ state: 'ready', sha256: sha(v2), sizeBytes: v2.byteLength, revision: 2 });
    const now = await row(d.id);
    expect(now.currentRevision).toBe(2);
    expect(now.storageKey).toBe(started.storageKey);
    expect(now.uploadState).toBe('ready');
    const meta = now.metadata as Record<string, unknown>;
    expect(meta.pendingRevision).toBeUndefined();
    expect(meta.kind).toBe('design');
    expect((meta.screens as Array<{ viewport: string }>)[0]!.viewport).toBe('390x844');

    const r1 = await getArtifactRevision(d.id, 1);
    const r2 = await getArtifactRevision(d.id, 2);
    expect(r1!.storageKey).toBe(d.key);
    expect(r1!.contentHash).toBe(sha(v1));
    expect(objects.get(d.key)!.equals(v1)).toBe(true);
    expect(r2!.storageKey).toBe(started.storageKey);
    expect(r2!.contentHash).toBe(sha(v2));
    expect(r2!.author).toBe(`user:${userId}`);
    expect(objects.has(uploadStagingKey(started.storageKey))).toBe(false);
  });

  test('a floating link follows the new body; a pinned one stays on its revision', async () => {
    const d = await readyDesign(Buffer.from('<p>one</p>'));
    const caller = { kind: 'user' as const, userId };
    expect((await linkArtifact(caller, d.id, { subjectKind: 'mission', subjectId: missionId, relation: 'design_reference' })).ok).toBe(true);
    expect((await linkArtifact(caller, d.id, { subjectKind: 'task', subjectId: taskId, relation: 'design_reference', revision: 1 })).ok).toBe(true);
    const v2 = Buffer.from('<p>two!</p>');
    const s = await startFileRevision(d.id, { filename: 'nav.html', mimeType: 'text/html', sizeBytes: v2.byteLength, author: `user:${userId}` }, sign);
    if (!s.ok) throw new Error(s.error);
    objects.set(uploadStagingKey(s.storageKey), v2);
    expect((await finalizeArtifactUpload(d.id, { storage })).state).toBe('ready');

    const onMission = await artifactsLinkedTo('mission', missionId);
    const onTask = await artifactsLinkedTo('task', taskId);
    if (!Array.isArray(onMission) || !Array.isArray(onTask)) throw new Error('subject not found');
    expect(onMission.find((l) => l.artifactId === d.id)).toMatchObject({ pinnedRevision: null, currentRevision: 2, contentHash: sha(v2) });
    expect(onTask.find((l) => l.artifactId === d.id)).toMatchObject({ pinnedRevision: 1, contentHash: sha(Buffer.from('<p>one</p>')) });
  });

  test('wrong bytes fail the revision and leave the current body as it was', async () => {
    const d = await readyDesign(Buffer.from('keep me'));
    const s = await startFileRevision(d.id, { filename: 'nav.html', mimeType: 'text/html', sizeBytes: 100, author: `user:${userId}` }, sign);
    if (!s.ok) throw new Error(s.error);
    objects.set(uploadStagingKey(s.storageKey), Buffer.from('short'));
    expect(await finalizeArtifactUpload(d.id, { storage })).toMatchObject({ state: 'failed', reason: expect.stringContaining('size_mismatch') });
    const now = await row(d.id);
    expect(now.currentRevision).toBe(1);
    expect(now.storageKey).toBe(d.key);
    expect(now.uploadState).toBe('ready');
    expect((now.metadata as Record<string, unknown>).pendingRevision).toBeUndefined();
  });

  test('a body written since the upload started wins; the upload is refused, not lost silently', async () => {
    const d = await readyDesign(Buffer.from('base'));
    const s = await startFileRevision(d.id, { filename: 'nav.html', mimeType: 'text/html', sizeBytes: 4, author: `user:${userId}` }, sign);
    if (!s.ok) throw new Error(s.error);
    await db.update(artifacts).set({ storageKey: `${d.key}-other` }).where(eq(artifacts.id, d.id));
    objects.set(uploadStagingKey(s.storageKey), Buffer.from('next'));
    expect(await finalizeArtifactUpload(d.id, { storage })).toMatchObject({ state: 'failed', reason: expect.stringContaining('revision_conflict') });
    expect((await row(d.id)).storageKey).toBe(`${d.key}-other`);
  });

  test('a text artifact, or one whose first upload is not verified, takes no uploaded body', async () => {
    const [text] = await db.insert(artifacts).values({ workspaceId, type: 'content', title: 't', content: 'x' }).returning();
    expect(await startFileRevision(text.id, { filename: 'a.html', mimeType: 'text/html', sizeBytes: 3, author: 'x' }, sign)).toMatchObject({ ok: false, status: 400 });
    const [pending] = await db.insert(artifacts).values({ workspaceId, type: 'file', title: 'p', storageKey: `artifacts/${workspaceId}/${crypto.randomUUID()}/p.html`, uploadState: 'pending' }).returning();
    expect(await startFileRevision(pending.id, { filename: 'a.html', mimeType: 'text/html', sizeBytes: 3, author: 'x' }, sign)).toMatchObject({ ok: false, status: 409 });
  });
});

describe('attach in the upload call', () => {
  test('is checked when asked and written once the bytes are verified', async () => {
    const caller = { kind: 'user' as const, userId };
    const checked = await checkPendingLink(caller, { workspaceId }, { subjectKind: 'mission', subjectId: missionId, relation: 'design_reference' });
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    const key = `artifacts/${workspaceId}/${crypto.randomUUID()}/d.html`;
    const [a] = await db.insert(artifacts).values({
      workspaceId, type: 'file', title: 'd', storageKey: key, uploadState: 'pending',
      metadata: { filename: 'd.html', mimeType: 'text/html', sizeBytes: 4, [PENDING_LINKS_KEY]: [checked.link] },
    }).returning();
    const links = async () => db.select().from(artifactLinks).where(eq(artifactLinks.artifactId, a.id));
    expect(await finalizeArtifactUpload(a.id, { storage })).toEqual({ state: 'pending', reason: 'not_uploaded' });
    expect(await links()).toHaveLength(0);
    objects.set(uploadStagingKey(key), Buffer.from('abcd'));
    expect((await finalizeArtifactUpload(a.id, { storage })).state).toBe('ready');
    expect((await links()).map((l) => [l.subjectKind, l.subjectId, l.relation, l.artifactRevision])).toEqual([['mission', missionId, 'design_reference', null]]);
    expect(((await row(a.id)).metadata as Record<string, unknown>)[PENDING_LINKS_KEY]).toBeUndefined();
  });

  test('a spec is a link subject', async () => {
    const d = await readyDesign(Buffer.from('spec design'));
    const [spec] = await q<{ id: string }>(sql`INSERT INTO specs (workspace_id, title, scope, body_artifact_id) VALUES (${workspaceId}::uuid, 'Nav', 'feature', ${d.id}::uuid) RETURNING id`);
    const caller = { kind: 'user' as const, userId };
    expect((await linkArtifact(caller, d.id, { subjectKind: 'spec', subjectId: spec.id, relation: 'design_reference' })).ok).toBe(true);
    const linked = await artifactsLinkedTo('spec', spec.id);
    expect(Array.isArray(linked) && linked.map((l) => l.artifactId)).toEqual([d.id]);
  });

  test('a subject in another workspace is refused up front, not dropped later', async () => {
    const [other] = await q<{ id: string }>(sql`INSERT INTO workspaces (name, team_id) VALUES (${`w-${crypto.randomUUID()}`}, ${teamId}::uuid) RETURNING id`);
    const otherTask = await seedTask(other.id);
    const r = await checkPendingLink({ kind: 'user', userId }, { workspaceId }, { subjectKind: 'task', subjectId: otherTask, relation: 'design_reference' });
    expect(r.ok).toBe(false);
  });
});
