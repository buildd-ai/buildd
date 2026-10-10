/**
 * Upload finalize and the stale-upload sweep (apps/web/src/lib/artifact-upload.ts),
 * against real Postgres with an in-memory object store: an upload is ready only
 * once its stored bytes match what the URL was signed for, its hash lands on its
 * revision, and the sweep removes only what never arrived.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'crypto';
import { eq, sql } from 'drizzle-orm';
import { assertDbConfigured, q, seedWorkspace } from './harness';

const { db } = await import('@buildd/core/db');
const { artifacts } = await import('@buildd/core/db/schema');
const { finalizeArtifactUpload, sweepStaleUploads, STALE_UPLOAD_MS } = await import('../../src/lib/artifact-upload');

const objects = new Map<string, Buffer>();
const removed: string[] = [];
const storage = {
  head: async (k: string) => (objects.has(k) ? { sizeBytes: objects.get(k)!.byteLength, contentType: 'application/pdf' } : null),
  sha256: async (k: string) => ({ sha256: createHash('sha256').update(objects.get(k)!).digest('hex'), sizeBytes: objects.get(k)!.byteLength }),
  remove: async (k: string) => { removed.push(k); objects.delete(k); },
};

let workspaceId: string;
let seq = 0;
async function pendingUpload(bytes: number, opts: { ageMs?: number } = {}) {
  const key = `artifacts/${workspaceId}/${++seq}-${Date.now()}/file.pdf`;
  const [a] = await db.insert(artifacts).values({
    workspaceId, type: 'file', title: 'f', storageKey: key, uploadState: 'pending', metadata: { sizeBytes: bytes, filename: 'file.pdf' },
    ...(opts.ageMs ? { createdAt: new Date(Date.now() - opts.ageMs) } : {}),
  }).returning();
  return { id: a.id, key };
}
const state = async (id: string) => (await db.select({ s: artifacts.uploadState }).from(artifacts).where(eq(artifacts.id, id)))[0]?.s ?? 'gone';
const revHash = async (id: string) => (await q<{ content_hash: string | null; size_bytes: number | null }>(sql`
  SELECT content_hash, size_bytes FROM artifact_revisions WHERE artifact_id = ${id}::uuid ORDER BY revision DESC LIMIT 1`))[0];

beforeAll(async () => {
  assertDbConfigured();
  ({ workspaceId } = await seedWorkspace());
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

    const r = await sweepStaleUploads(new Date(), storage, 1_000);
    expect(r.finalized).toBeGreaterThanOrEqual(1);
    expect(await state(arrived.id)).toBe('ready');
    expect(await state(young.id)).toBe('pending');
    expect(await state(never.id)).toBe('gone');
    expect(await state(bad.id)).toBe('gone');
    expect(removed).toEqual(expect.arrayContaining([never.key, bad.key]));
    expect(removed).not.toContain(arrived.key);
  });
});
