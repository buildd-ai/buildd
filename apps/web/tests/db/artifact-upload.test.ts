/**
 * Upload finalize and the stale-upload sweep (apps/web/src/lib/artifact-upload.ts),
 * against real Postgres with an in-memory object store: an upload is ready only
 * once its stored bytes match what the URL was signed for, its hash lands on its
 * revision, and the sweep removes only what never arrived.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'crypto';
import { eq, sql } from 'drizzle-orm';
import { assertDbConfigured, q, seedTask, seedWorkspace } from './harness';

const { db } = await import('@buildd/core/db');
const { artifacts, artifactLinks, specs } = await import('@buildd/core/db/schema');
const { finalizeArtifactUpload, sweepStaleUploads, STALE_UPLOAD_MS } = await import('../../src/lib/artifact-upload');

const objects = new Map<string, Buffer>();
const removed: string[] = [];
const storedTypes = new Map<string, string>();
const storage = {
  head: async (k: string) => (objects.has(k) ? { sizeBytes: objects.get(k)!.byteLength, contentType: storedTypes.get(k) ?? 'application/pdf' } : null),
  sha256: async (k: string) => ({ sha256: createHash('sha256').update(objects.get(k)!).digest('hex'), sizeBytes: objects.get(k)!.byteLength }),
  copy: async (from: string, to: string) => { copies.push(to); objects.set(to, objects.get(from)!); if (storedTypes.has(from)) storedTypes.set(to, storedTypes.get(from)!); },
  remove: async (k: string) => { removed.push(k); objects.delete(k); },
};
const copies: string[] = [];
const { uploadStagingKey } = await import('../../src/lib/storage-keys');

let workspaceId: string;
let teamId: string;
let seq = 0;
async function pendingUpload(bytes: number, opts: { ageMs?: number; mimeType?: string } = {}) {
  const key = `artifacts/${workspaceId}/${++seq}-${Date.now()}/file.pdf`;
  const [a] = await db.insert(artifacts).values({
    workspaceId, type: 'file', title: 'f', storageKey: key, uploadState: 'pending', metadata: { sizeBytes: bytes, filename: 'file.pdf', ...(opts.mimeType ? { mimeType: opts.mimeType } : {}) },
    ...(opts.ageMs ? { createdAt: new Date(Date.now() - opts.ageMs) } : {}),
  }).returning();
  return { id: a.id, key };
}
const state = async (id: string) => (await db.select({ s: artifacts.uploadState }).from(artifacts).where(eq(artifacts.id, id)))[0]?.s ?? 'gone';
const revHash = async (id: string) => (await q<{ content_hash: string | null; size_bytes: number | null }>(sql`
  SELECT content_hash, size_bytes FROM artifact_revisions WHERE artifact_id = ${id}::uuid ORDER BY revision DESC LIMIT 1`))[0];

beforeAll(async () => {
  assertDbConfigured();
  ({ workspaceId, teamId } = await seedWorkspace());
});

describe('finalizeArtifactUpload', () => {
  test('bytes not there yet: still pending, nothing written', async () => {
    const u = await pendingUpload(10);
    expect(await finalizeArtifactUpload(u.id, { storage })).toEqual({ state: 'pending', reason: 'not_uploaded' });
    expect(await state(u.id)).toBe('pending');
  });

  test('matching bytes: ready, and the revision carries their sha256 and size', async () => {
    const u = await pendingUpload(11);
    const bytes = Buffer.from('hello world');
    objects.set(u.key, bytes);
    const sha = createHash('sha256').update(bytes).digest('hex');
    expect(await finalizeArtifactUpload(u.id, { storage, expectedSha256: sha })).toEqual({ state: 'ready', sha256: sha, sizeBytes: 11 });
    expect(await state(u.id)).toBe('ready');
    expect(await revHash(u.id)).toEqual({ content_hash: sha, size_bytes: 11 });
    // Idempotent: a second finalize reads the recorded hash back.
    expect(await finalizeArtifactUpload(u.id, { storage })).toEqual({ state: 'ready', sha256: sha, sizeBytes: 11 });
  });

  test('a size other than the URL was signed for fails, and says so', async () => {
    const u = await pendingUpload(100);
    objects.set(u.key, Buffer.from('short'));
    const r = await finalizeArtifactUpload(u.id, { storage });
    expect(r).toMatchObject({ state: 'failed' });
    expect(await state(u.id)).toBe('failed');
  });

  test('a hash other than the uploader sent fails', async () => {
    const u = await pendingUpload(3);
    objects.set(u.key, Buffer.from('abc'));
    expect(await finalizeArtifactUpload(u.id, { storage, expectedSha256: 'f'.repeat(64) })).toMatchObject({ state: 'failed', reason: expect.stringContaining('sha256_mismatch') });
    expect((await revHash(u.id)).content_hash).toBeNull();
  });

  test('a content type other than the URL was signed for fails; case and parameters do not count', async () => {
    const bad = await pendingUpload(4, { mimeType: 'image/png' });
    objects.set(bad.key, Buffer.from('data'));
    storedTypes.set(bad.key, 'text/html');
    const r = await finalizeArtifactUpload(bad.id, { storage });
    expect(r.state).toBe('failed');
    if (r.state === 'failed') expect(r.reason).toContain('content_type_mismatch');
    expect(await state(bad.id)).toBe('failed');

    const ok = await pendingUpload(4, { mimeType: 'Text/Plain' });
    objects.set(ok.key, Buffer.from('data'));
    storedTypes.set(ok.key, 'text/plain; charset=utf-8');
    expect((await finalizeArtifactUpload(ok.id, { storage })).state).toBe('ready');
  });

  test('bytes PUT where the URL is signed for are copied to the key every reader uses, then the staged copy goes', async () => {
    const u = await pendingUpload(11);
    const bytes = Buffer.from('hello there');
    objects.set(uploadStagingKey(u.key), bytes);
    const sha = createHash('sha256').update(bytes).digest('hex');
    expect(await finalizeArtifactUpload(u.id, { storage, expectedSha256: sha })).toEqual({ state: 'ready', sha256: sha, sizeBytes: 11 });
    expect(objects.get(u.key)!.equals(bytes)).toBe(true);
    expect(objects.has(uploadStagingKey(u.key))).toBe(false);
    expect(await revHash(u.id)).toEqual({ content_hash: sha, size_bytes: 11 });
    const [row] = await db.select({ metadata: artifacts.metadata }).from(artifacts).where(eq(artifacts.id, u.id));
    expect((row!.metadata as Record<string, unknown>).finalizingAt).toBeUndefined();
  });

  test('a PUT through the upload URL after finalize changes nothing a reader gets', async () => {
    const u = await pendingUpload(11, { mimeType: 'application/pdf' });
    const bytes = Buffer.from('%PDF-honest');
    objects.set(uploadStagingKey(u.key), bytes);
    const sha = createHash('sha256').update(bytes).digest('hex');
    expect((await finalizeArtifactUpload(u.id, { storage })).state).toBe('ready');

    // Same size, another type: the artifact URL signs only the length.
    objects.set(uploadStagingKey(u.key), Buffer.from('<html>evil<'));
    storedTypes.set(uploadStagingKey(u.key), 'text/html');
    const before = copies.length;
    expect(await finalizeArtifactUpload(u.id, { storage })).toEqual({ state: 'ready', sha256: sha, sizeBytes: 11 });
    expect(copies.length).toBe(before);
    // Every reader (download, link pin, model read) reads storageKey.
    const [row] = await db.select({ storageKey: artifacts.storageKey }).from(artifacts).where(eq(artifacts.id, u.id));
    expect(row!.storageKey).toBe(u.key);
    expect(objects.get(u.key)!.equals(bytes)).toBe(true);
    expect((await storage.sha256(u.key)).sha256).toBe((await revHash(u.id)).content_hash!);
    expect(storedTypes.get(u.key) ?? 'application/pdf').toBe('application/pdf');
  });

  test('a type swapped on the staged object before finalize is caught on the copy', async () => {
    const u = await pendingUpload(4, { mimeType: 'image/png' });
    objects.set(uploadStagingKey(u.key), Buffer.from('data'));
    storedTypes.set(uploadStagingKey(u.key), 'text/html');
    const r = await finalizeArtifactUpload(u.id, { storage });
    expect(r).toMatchObject({ state: 'failed', reason: expect.stringContaining('content_type_mismatch') });
  });

  test('while another finalize holds the copy, a second one neither copies nor reads ready', async () => {
    const u = await pendingUpload(4);
    objects.set(uploadStagingKey(u.key), Buffer.from('data'));
    await db.update(artifacts).set({ metadata: sql`${artifacts.metadata} || ${JSON.stringify({ finalizingAt: new Date().toISOString() })}::jsonb` }).where(eq(artifacts.id, u.id));
    const before = copies.length;
    expect(await finalizeArtifactUpload(u.id, { storage })).toEqual({ state: 'pending', reason: 'finalizing' });
    expect(copies.length).toBe(before);
    expect(await state(u.id)).toBe('pending');
    // A lease nobody released in time is taken over.
    await db.update(artifacts).set({ metadata: sql`${artifacts.metadata} || ${JSON.stringify({ finalizingAt: new Date(Date.now() - 11 * 60_000).toISOString() })}::jsonb` }).where(eq(artifacts.id, u.id));
    expect((await finalizeArtifactUpload(u.id, { storage })).state).toBe('ready');
  });

  test('an inline artifact is simply ready', async () => {
    const [a] = await db.insert(artifacts).values({ workspaceId, type: 'content', title: 't', content: 'x' }).returning();
    expect((await finalizeArtifactUpload(a.id, { storage })).state).toBe('ready');
  });
});

describe('sweepStaleUploads', () => {
  test('finalizes what arrived, keeps a young upload waiting, removes what never arrived or failed', async () => {
    const arrived = await pendingUpload(4, { ageMs: STALE_UPLOAD_MS + 60_000 });
    objects.set(arrived.key, Buffer.from('data'));
    const young = await pendingUpload(4, { ageMs: 5 * 60_000 });
    const never = await pendingUpload(4, { ageMs: STALE_UPLOAD_MS + 60_000 });
    const bad = await pendingUpload(9, { ageMs: STALE_UPLOAD_MS + 60_000 });
    objects.set(bad.key, Buffer.from('nope'));
    const badStaged = await pendingUpload(9, { ageMs: STALE_UPLOAD_MS + 60_000 });
    objects.set(uploadStagingKey(badStaged.key), Buffer.from('nope'));

    const r = await sweepStaleUploads(new Date(), storage, 1_000);
    expect(r.finalized).toBeGreaterThanOrEqual(1);
    expect(await state(arrived.id)).toBe('ready');
    expect(await state(young.id)).toBe('pending');
    expect(await state(never.id)).toBe('gone');
    expect(await state(bad.id)).toBe('gone');
    expect(removed).toEqual(expect.arrayContaining([never.key, bad.key]));
    // Whichever key holds a removed upload's bytes goes: the staged one and the copy.
    expect(await state(badStaged.id)).toBe('gone');
    expect(objects.has(badStaged.key)).toBe(false);
    expect(objects.has(uploadStagingKey(badStaged.key))).toBe(false);
    expect(removed).not.toContain(arrived.key);
  });
});

describe('sweepStaleUploads never deletes what something refers to', () => {
  test('a linked stale upload and a spec body survive with their objects; an unreferenced one is still swept', async () => {
    const stale = STALE_UPLOAD_MS + 60_000;
    const linked = await pendingUpload(4, { ageMs: stale });
    const body = await pendingUpload(4, { ageMs: stale });
    const failedLinked = await pendingUpload(4, { ageMs: stale });
    await db.update(artifacts).set({ uploadState: 'failed' }).where(eq(artifacts.id, failedLinked.id));
    for (const u of [linked, body, failedLinked]) objects.set(u.key, Buffer.from('nope!')); // wrong size: fails, would be removed
    const loose = await pendingUpload(4, { ageMs: stale });
    const taskId = await seedTask(workspaceId);
    await db.insert(artifactLinks).values([linked, failedLinked].map(u => ({ artifactId: u.id, subjectKind: 'task' as const, subjectId: taskId, relation: 'context' as const, teamId })));
    await db.insert(specs).values({ workspaceId, title: 'spec', scope: 'feature', bodyArtifactId: body.id });

    const r = await sweepStaleUploads(new Date(), storage, 1_000);
    expect(r.removed).toBeGreaterThanOrEqual(1);
    expect(await state(loose.id)).toBe('gone');
    for (const u of [linked, body, failedLinked]) {
      expect(await state(u.id)).not.toBe('gone');
      expect(removed).not.toContain(u.key);
    }
  });
});
