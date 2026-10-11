/**
 * Images and files attached to chat messages (apps/web/src/lib/artifact-chat-files.ts,
 * Living Specs C3), against real Postgres with an in-memory object store: an
 * image and a PDF are uploaded, verified, sent, and after a reload their
 * original bytes come back byte-identical under the sha256 the message
 * carries; an upload never finalized or never sent is never on a message and
 * is swept; a failed check never reads ready and cannot be sent; another
 * person cannot finalize, cancel, send or download it.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'crypto';
import { eq, sql } from 'drizzle-orm';
import { assertDbConfigured, q, seedWorkspace } from './harness';

const { db } = await import('@buildd/core/db');
const { artifacts, conversationMessages } = await import('@buildd/core/db/schema');
const {
  createChatUpload, finalizeChatUpload, cancelChatUpload, bindChatFiles, checkChatFiles, fileRefPart, fileRefOf,
  conversationFiles, conversationFile, storeChatUploadBytes, chatUploadKey,
} = await import('../../src/lib/artifact-chat-files');
const { linkChatAttachments } = await import('../../src/lib/artifact-chat-attachments');
const { sweepStaleUploads, STALE_UPLOAD_MS } = await import('../../src/lib/artifact-upload');
const { workspaceArtifactScope } = await import('../../src/lib/artifact-scope');

const objects = new Map<string, { bytes: Buffer; type: string }>();
const storage = {
  head: async (k: string) => (objects.has(k) ? { sizeBytes: objects.get(k)!.bytes.byteLength, contentType: objects.get(k)!.type } : null),
  sha256: async (k: string) => ({ sha256: sha(objects.get(k)!.bytes), sizeBytes: objects.get(k)!.bytes.byteLength }),
  copy: async (from: string, to: string) => { copies.push(to); objects.set(to, { ...objects.get(from)! }); },
  remove: async (k: string) => { objects.delete(k); },
};
const copies: string[] = [];
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const { uploadStagingKey } = await import('../../src/lib/storage-keys');

const rand = () => Math.random().toString(36).slice(2, 10);
async function member(teamId: string) {
  const [u] = await q<{ id: string }>(sql`INSERT INTO users (email) VALUES (${`u-${rand()}@example.test`}) RETURNING id`);
  await q(sql`INSERT INTO team_members (team_id, user_id, role) VALUES (${teamId}::uuid, ${u.id}::uuid, 'member')`);
  return u.id;
}
async function conversation(teamId: string, userId: string) {
  const [c] = await q<{ id: string }>(sql`INSERT INTO conversations (team_id, created_by_user_id) VALUES (${teamId}::uuid, ${userId}::uuid) RETURNING id`);
  return c.id;
}
async function saveMessage(conversationId: string, userId: string, parts: unknown[]) {
  const [m] = await db.insert(conversationMessages).values({ conversationId, role: 'user', authorUserId: userId, parts: parts as never }).returning();
  return m.id;
}
/** Start an upload and, unless told otherwise, PUT exactly its bytes where its URL is signed for. */
async function upload(teamId: string, userId: string, name: string, mediaType: string, bytes: Buffer, stored: { bytes?: Buffer; type?: string } | null = {}) {
  const r = await createChatUpload({ teamId, userId, name, mediaType, sizeBytes: bytes.byteLength });
  if (!r.ok) throw new Error(r.error);
  if (stored) objects.set(uploadStagingKey(r.storageKey), { bytes: stored.bytes ?? bytes, type: stored.type ?? mediaType });
  return r;
}
const stateOf = async (id: string) => (await db.select({ s: artifacts.uploadState }).from(artifacts).where(eq(artifacts.id, id)))[0]?.s ?? 'gone';

// A real PNG header and a PDF header, with random bodies: binary bytes a text path would mangle.
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(48_000)]);
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1'), randomBytes(150_000)]);

let teamA: string; let userA: string; let convA: string;
let teamB: string; let userB: string; let convB: string; let wsA: string;

beforeAll(async () => {
  assertDbConfigured();
  ({ teamId: teamA, workspaceId: wsA } = await seedWorkspace());
  ({ teamId: teamB } = await seedWorkspace());
  userA = await member(teamA);
  userB = await member(teamB);
  convA = await conversation(teamA, userA);
  convB = await conversation(teamB, userB);
});

describe('an image and a PDF, sent and reloaded', () => {
  test('come back byte-identical under the sha256 the message keeps', async () => {
    const img = await upload(teamA, userA, 'chart.png', 'image/png', PNG);
    const pdf = await upload(teamA, userA, 'Q3 report.pdf', 'application/pdf', PDF);
    // Verified with the hash the browser computed.
    expect(await finalizeChatUpload(img.artifactId, userA, [teamA], { storage, expectedSha256: sha(PNG) })).toEqual({ state: 'ready', sha256: sha(PNG), sizeBytes: PNG.byteLength });
    expect(await finalizeChatUpload(pdf.artifactId, userA, [teamA], { storage })).toEqual({ state: 'ready', sha256: sha(PDF), sizeBytes: PDF.byteLength });

    const drafts = [img, pdf].map(u => ({ kind: 'file' as const, id: u.artifactId, name: 'ignored', mediaType: 'text/html', sizeBytes: 1 }));
    const bound = await bindChatFiles({ id: convA, teamId: teamA }, userA, drafts);
    expect(bound.ok).toBe(true);
    if (!bound.ok) return;
    // Name, type and size come from the upload, never from the part the client sent.
    expect(bound.refs).toEqual([
      { artifactId: img.artifactId, revision: 1, sha256: sha(PNG), name: 'chart.png', mediaType: 'image/png', sizeBytes: PNG.byteLength },
      { artifactId: pdf.artifactId, revision: 1, sha256: sha(PDF), name: 'Q3 report.pdf', mediaType: 'application/pdf', sizeBytes: PDF.byteLength },
    ]);
    const messageId = await saveMessage(convA, userA, [{ type: 'text', text: 'Does the chart match?' }, ...bound.refs.map(fileRefPart)]);
    await linkChatAttachments(messageId, teamA, userA, bound.refs);

    // Reload: the stored message, then each file through its conversation.
    const [row] = await db.select().from(conversationMessages).where(eq(conversationMessages.id, messageId));
    const refs = (row.parts as never[]).map(fileRefOf).filter(Boolean);
    expect(refs).toEqual(bound.refs);
    for (const [ref, original] of [[refs[0]!, PNG], [refs[1]!, PDF]] as const) {
      const file = await conversationFile(convA, ref.artifactId);
      expect(file).not.toBeNull();
      const got = objects.get(file!.storageKey)!.bytes;
      expect(got.equals(original)).toBe(true);
      expect(sha(got)).toBe(ref.sha256);
    }
    expect((await conversationFiles(convA)).map(f => f.messageId)).toEqual([messageId, messageId]);
  });

  test('a retry of the same message is the same file; another conversation cannot take it', async () => {
    const u = await upload(teamA, userA, 'again.png', 'image/png', PNG);
    await finalizeChatUpload(u.artifactId, userA, [teamA], { storage });
    const d = [{ kind: 'file' as const, id: u.artifactId, name: '', mediaType: '', sizeBytes: 0 }];
    const first = await bindChatFiles({ id: convA, teamId: teamA }, userA, d);
    const retry = await bindChatFiles({ id: convA, teamId: teamA }, userA, d);
    expect(first.ok && retry.ok && first.refs[0]!.artifactId === retry.refs[0]!.artifactId).toBe(true);
    const otherConv = await conversation(teamA, userA);
    expect(await bindChatFiles({ id: otherConv, teamId: teamA }, userA, d)).toMatchObject({ ok: false, status: 409, code: 'file_taken' });
  });

  test('the check a turn runs before spending returns the same references and ties nothing to the conversation', async () => {
    const u = await upload(teamA, userA, 'check.png', 'image/png', PNG);
    await finalizeChatUpload(u.artifactId, userA, [teamA], { storage });
    const d = [{ kind: 'file' as const, id: u.artifactId, name: '', mediaType: '', sizeBytes: 0 }];
    const checked = await checkChatFiles({ id: convA, teamId: teamA }, userA, d);
    expect(checked.ok).toBe(true);
    // Not bound: a refused message leaves the file free to send in another conversation.
    const elsewhere = await conversation(teamA, userA);
    const bound = await bindChatFiles({ id: elsewhere, teamId: teamA }, userA, d);
    expect(bound.ok).toBe(true);
    if (checked.ok && bound.ok) expect(checked.refs).toEqual(bound.refs);
    // Once bound, the check refuses it for any other conversation, as the bind does.
    expect(await checkChatFiles({ id: convA, teamId: teamA }, userA, d)).toMatchObject({ ok: false, status: 409, code: 'file_taken' });
    // Another team's member is refused like the bind.
    expect(await checkChatFiles({ id: convB, teamId: teamB }, userB, d)).toMatchObject({ ok: false, status: 409, code: 'file_not_found' });
  });

  test('a PUT through the upload URL after finalize changes nothing the download or the model read returns', async () => {
    const u = await upload(teamA, userA, 'swap.png', 'image/png', PNG);
    expect(await finalizeChatUpload(u.artifactId, userA, [teamA], { storage, expectedSha256: sha(PNG) })).toMatchObject({ state: 'ready', sha256: sha(PNG) });
    const bound = await bindChatFiles({ id: convA, teamId: teamA }, userA, [{ kind: 'file' as const, id: u.artifactId, name: '', mediaType: '', sizeBytes: 0 }]);
    if (!bound.ok) throw new Error(bound.error);
    const messageId = await saveMessage(convA, userA, [{ type: 'text', text: 'swap?' }, ...bound.refs.map(fileRefPart)]);
    await linkChatAttachments(messageId, teamA, userA, bound.refs);

    // The URL is still valid for a while: other bytes, same size and type, PUT to what it is signed for.
    const other = randomBytes(PNG.byteLength);
    objects.set(uploadStagingKey(u.storageKey), { bytes: other, type: 'image/png' });
    // A late finalize (the lazy one a read triggers) does not copy them in.
    const copiesBefore = copies.length;
    expect(await finalizeChatUpload(u.artifactId, userA, [teamA], { storage })).toMatchObject({ state: 'ready', sha256: sha(PNG) });
    expect(copies.length).toBe(copiesBefore);

    const file = await conversationFile(convA, u.artifactId);
    const modelKey = await chatUploadKey(u.artifactId);
    expect(modelKey).toBe(file!.storageKey);
    for (const key of [file!.storageKey, modelKey!]) {
      const got = objects.get(key)!.bytes;
      expect(got.equals(PNG)).toBe(true);
      expect(sha(got)).toBe(bound.refs[0]!.sha256);
    }
    expect(uploadStagingKey(u.storageKey)).not.toBe(file!.storageKey);
  });

  test('no artifact route or workspace listing reaches a chat file', async () => {
    const files = await conversationFiles(convA);
    expect(files.length).toBeGreaterThan(0);
    const listed = await db.select({ id: artifacts.id }).from(artifacts).where(workspaceArtifactScope([wsA]));
    for (const f of files) expect(listed.map(r => r.id)).not.toContain(f.artifactId);
  });
});

describe('never ready, never sent', () => {
  test('uploading (bytes not stored yet) is pending and cannot be sent', async () => {
    const u = await upload(teamA, userA, 'later.png', 'image/png', PNG, null);
    expect(await finalizeChatUpload(u.artifactId, userA, [teamA], { storage })).toEqual({ state: 'pending', reason: 'not_uploaded' });
    expect(await bindChatFiles({ id: convA, teamId: teamA }, userA, [{ kind: 'file', id: u.artifactId, name: '', mediaType: '', sizeBytes: 0 }]))
      .toMatchObject({ ok: false, status: 409, code: 'file_not_ready' });
  });

  test('a size, type or hash mismatch fails, never reads ready, and cannot be sent', async () => {
    const short = await upload(teamA, userA, 'short.png', 'image/png', PNG, { bytes: PNG.subarray(0, 100) });
    const html = await upload(teamA, userA, 'x.png', 'image/png', PNG, { type: 'text/html' });
    const hash = await upload(teamA, userA, 'h.png', 'image/png', PNG);
    expect((await finalizeChatUpload(short.artifactId, userA, [teamA], { storage })).state).toBe('failed');
    expect((await finalizeChatUpload(html.artifactId, userA, [teamA], { storage })).state).toBe('failed');
    expect((await finalizeChatUpload(hash.artifactId, userA, [teamA], { storage, expectedSha256: 'a'.repeat(64) })).state).toBe('failed');
    for (const u of [short, html, hash]) {
      expect(await stateOf(u.artifactId)).toBe('failed');
      // A later finalize does not turn it ready.
      expect((await finalizeChatUpload(u.artifactId, userA, [teamA], { storage })).state).toBe('failed');
      expect(await bindChatFiles({ id: convA, teamId: teamA }, userA, [{ kind: 'file', id: u.artifactId, name: '', mediaType: '', sizeBytes: 0 }]))
        .toMatchObject({ ok: false, code: 'file_not_ready' });
      expect(await chatUploadKey(u.artifactId)).toBeNull();
    }
  });

  test('a type outside the allowlist, or over the size cap, is refused before any upload', async () => {
    expect(await createChatUpload({ teamId: teamA, userId: userA, name: 'a.exe', mediaType: 'application/x-msdownload', sizeBytes: 10 })).toMatchObject({ ok: false, code: 'file_type_unsupported' });
    expect(await createChatUpload({ teamId: teamA, userId: userA, name: 'a.png', mediaType: 'image/png', sizeBytes: 21 * 1024 * 1024 })).toMatchObject({ ok: false, status: 413 });
  });

  test('a cancelled upload is gone with its bytes, and is never on a message', async () => {
    const u = await upload(teamA, userA, 'cancel.png', 'image/png', PNG);
    expect(await cancelChatUpload(u.artifactId, userA, [teamA], storage)).toEqual({ ok: true, removed: true });
    expect(await stateOf(u.artifactId)).toBe('gone');
    expect(objects.has(u.storageKey)).toBe(false);
    expect(objects.has(uploadStagingKey(u.storageKey))).toBe(false);
    expect((await conversationFiles(convA)).map(f => f.artifactId)).not.toContain(u.artifactId);
  });

  test('a sent file cannot be cancelled', async () => {
    const [sent] = await conversationFiles(convA);
    expect(await cancelChatUpload(sent!.artifactId, userA, [teamA], storage)).toMatchObject({ ok: false, status: 409 });
  });

  test('the sweep removes uploads never sent, ready ones included, and keeps sent ones', async () => {
    const old = new Date(Date.now() - STALE_UPLOAD_MS - 60_000);
    const pending = await upload(teamA, userA, 'never-arrived.png', 'image/png', PNG, null);
    const unsent = await upload(teamA, userA, 'never-sent.png', 'image/png', PNG);
    await finalizeChatUpload(unsent.artifactId, userA, [teamA], { storage });
    for (const u of [pending, unsent]) await db.update(artifacts).set({ createdAt: old }).where(eq(artifacts.id, u.artifactId));
    const [sent] = await conversationFiles(convA);
    await db.update(artifacts).set({ createdAt: old }).where(eq(artifacts.id, sent!.artifactId));

    await sweepStaleUploads(new Date(), storage, 1000);
    expect(await stateOf(pending.artifactId)).toBe('gone');
    expect(await stateOf(unsent.artifactId)).toBe('gone');
    expect(objects.has(unsent.storageKey)).toBe(false);
    expect(await stateOf(sent!.artifactId)).toBe('ready');
    expect(objects.has(sent!.storageKey)).toBe(true);
  });
});

describe('only the uploader, only through the conversation', () => {
  test('another person cannot finalize, relay, cancel or send it', async () => {
    const u = await upload(teamA, userA, 'mine.png', 'image/png', PNG, null);
    expect(await finalizeChatUpload(u.artifactId, userB, [teamB], { storage })).toEqual({ state: 'missing' });
    // Same team, another person: still not theirs.
    const peer = await member(teamA);
    expect(await finalizeChatUpload(u.artifactId, peer, [teamA], { storage })).toEqual({ state: 'missing' });
    expect(await storeChatUploadBytes(u.artifactId, userB, [teamB], PNG, 'image/png', async () => {})).toMatchObject({ ok: false, status: 404 });
    expect(await cancelChatUpload(u.artifactId, userB, [teamB], storage)).toMatchObject({ ok: false, status: 404 });
    expect(await bindChatFiles({ id: convB, teamId: teamB }, userB, [{ kind: 'file', id: u.artifactId, name: '', mediaType: '', sizeBytes: 0 }]))
      .toMatchObject({ ok: false, code: 'file_not_found' });
  });

  test('another conversation cannot download it, even with a link to it', async () => {
    const [sent] = await conversationFiles(convA);
    expect(await conversationFile(convB, sent!.artifactId)).toBeNull();
    const msgB = await saveMessage(convB, userB, [{ type: 'text', text: 'x' }]);
    await linkChatAttachments(msgB, teamB, userB, [{ artifactId: sent!.artifactId, revision: 1 }]);
    expect(await conversationFile(convB, sent!.artifactId)).toBeNull();
  });

  test('the relay stores exactly the started size and type, and only while pending', async () => {
    const u = await upload(teamA, userA, 'relay.png', 'image/png', PNG, null);
    const put = async (k: string, b: Buffer, t: string) => { objects.set(k, { bytes: b, type: t }); };
    expect(await storeChatUploadBytes(u.artifactId, userA, [teamA], PNG.subarray(0, 10), 'image/png', put)).toMatchObject({ ok: false, status: 400 });
    expect(await storeChatUploadBytes(u.artifactId, userA, [teamA], PNG, 'text/html', put)).toMatchObject({ ok: false, status: 400 });
    expect(await storeChatUploadBytes(u.artifactId, userA, [teamA], PNG, 'image/png', put)).toEqual({ ok: true });
    expect(objects.has(uploadStagingKey(u.storageKey))).toBe(true);
    expect(objects.has(u.storageKey)).toBe(false);
    expect((await finalizeChatUpload(u.artifactId, userA, [teamA], { storage })).state).toBe('ready');
    expect(await storeChatUploadBytes(u.artifactId, userA, [teamA], PNG, 'image/png', put)).toMatchObject({ ok: false, status: 409 });
  });
});
