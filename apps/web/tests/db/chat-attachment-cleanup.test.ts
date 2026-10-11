/**
 * Chat attachments do not outlive their conversation
 * (apps/web/src/lib/artifact-chat-cleanup.ts), against real Postgres with an
 * in-memory object store: when a conversation goes, its 60k paste and its
 * uploaded file go too, with their revisions, links and stored object; an
 * attachment something live still refers to stays; the sweep takes orphans a
 * crash left behind and never a live attachment; one team's cleanup never
 * touches another team's conversations.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { eq, sql } from 'drizzle-orm';
import { assertDbConfigured, q, seedWorkspace } from './harness';

const { db } = await import('@buildd/core/db');
const { artifacts, artifactRevisions, artifactLinks, conversations, conversationMessages, teams } = await import('@buildd/core/db/schema');
const { storeChatAttachments, linkChatAttachments, attachmentRefPart } = await import('../../src/lib/artifact-chat-attachments');
const { createChatUpload, finalizeChatUpload, bindChatFiles, fileRefPart } = await import('../../src/lib/artifact-chat-files');
const { removeOrphanChatAttachments, removeTeamChatAttachments } = await import('../../src/lib/artifact-chat-cleanup');
const { STALE_UPLOAD_MS } = await import('../../src/lib/artifact-upload');

const objects = new Map<string, { bytes: Buffer; type: string }>();
const storage = {
  head: async (k: string) => (objects.has(k) ? { sizeBytes: objects.get(k)!.bytes.byteLength, contentType: objects.get(k)!.type } : null),
  sha256: async (k: string) => ({ sha256: sha(objects.get(k)!.bytes), sizeBytes: objects.get(k)!.bytes.byteLength }),
  remove: async (k: string) => { objects.delete(k); },
};
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
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

const PASTE = Array.from({ length: 1500 }, (_, i) => `${String(i).padStart(4, '0')} line of a pasted log, with détails 日本\r\n`).join('').slice(0, 60_000);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(20_000)]);

/** A conversation with one sent message carrying a 60k paste and an uploaded image. */
async function sentConversation(teamId: string, userId: string) {
  const convId = await conversation(teamId, userId);
  const pasteId = randomUUID();
  const pasted = await storeChatAttachments({ id: convId, teamId } as never, userId, [{ id: pasteId, title: 'Incident log', text: PASTE }]);
  if (!pasted.ok) throw new Error(pasted.error);
  const up = await createChatUpload({ teamId, userId, name: 'chart.png', mediaType: 'image/png', sizeBytes: PNG.byteLength });
  if (!up.ok) throw new Error(up.error);
  objects.set(up.storageKey, { bytes: PNG, type: 'image/png' });
  expect((await finalizeChatUpload(up.artifactId, userId, [teamId], { storage })).state).toBe('ready');
  const bound = await bindChatFiles({ id: convId, teamId }, userId, [{ kind: 'file' as const, id: up.artifactId, name: 'x', mediaType: 'image/png', sizeBytes: 1 }]);
  if (!bound.ok) throw new Error(bound.error);
  const messageId = await saveMessage(convId, userId, [attachmentRefPart(pasted.refs[0]!), ...bound.refs.map(fileRefPart)]);
  await linkChatAttachments(messageId, teamId, userId, [...pasted.refs, ...bound.refs]);
  return { convId, messageId, pasteId, fileId: up.artifactId, storageKey: up.storageKey };
}

const rowCount = async (id: string) => ({
  artifact: (await db.select({ id: artifacts.id }).from(artifacts).where(eq(artifacts.id, id))).length,
  revisions: (await db.select({ id: artifactRevisions.id }).from(artifactRevisions).where(eq(artifactRevisions.artifactId, id))).length,
  links: (await db.select({ id: artifactLinks.id }).from(artifactLinks).where(eq(artifactLinks.artifactId, id))).length,
});

let teamA: string; let userA: string;
let teamB: string; let userB: string;

beforeAll(async () => {
  assertDbConfigured();
  ({ teamId: teamA } = await seedWorkspace());
  ({ teamId: teamB } = await seedWorkspace());
  userA = await member(teamA);
  userB = await member(teamB);
});

describe('a conversation goes, its attachments go with it', () => {
  test('the 60k paste and the uploaded file: rows, revisions, links and stored object', async () => {
    const s = await sentConversation(teamA, userA);
    expect(await rowCount(s.pasteId)).toEqual({ artifact: 1, revisions: 1, links: 1 });
    expect(await rowCount(s.fileId)).toEqual({ artifact: 1, revisions: 1, links: 1 });
    expect(objects.has(s.storageKey)).toBe(true);

    // Nothing is an orphan while the conversation lives.
    expect((await removeOrphanChatAttachments({ conversationId: s.convId, storage })).removed).toBe(0);

    await db.delete(conversations).where(eq(conversations.id, s.convId));
    const r = await removeOrphanChatAttachments({ conversationId: s.convId, storage });
    expect(r).toEqual({ removed: 2, objectsRemoved: 1 });
    expect(await rowCount(s.pasteId)).toEqual({ artifact: 0, revisions: 0, links: 0 });
    expect(await rowCount(s.fileId)).toEqual({ artifact: 0, revisions: 0, links: 0 });
    expect(objects.has(s.storageKey)).toBe(false);
  });

  test('an attachment still linked from something live stays, with its object', async () => {
    const s = await sentConversation(teamA, userA);
    const [task] = await q<{ id: string }>(sql`SELECT gen_random_uuid() AS id`);
    // A typed link from another subject (e.g. a task it informs).
    await db.insert(artifactLinks).values({ artifactId: s.fileId, artifactRevision: 1, subjectKind: 'task', subjectId: task.id, relation: 'context', teamId: teamA, createdBy: `user:${userA}` });
    await db.delete(conversations).where(eq(conversations.id, s.convId));

    const r = await removeOrphanChatAttachments({ conversationId: s.convId, storage });
    expect(r.removed).toBe(1); // the paste
    expect((await rowCount(s.pasteId)).artifact).toBe(0);
    expect((await rowCount(s.fileId)).artifact).toBe(1);
    expect(objects.has(s.storageKey)).toBe(true);
  });
});

describe('a deleted team', () => {
  test('its chat attachments are removed in the same request; another team is untouched', async () => {
    const [t] = await q<{ id: string }>(sql`INSERT INTO teams (name, slug) VALUES (${`T ${rand()}`}, ${`t-${rand()}`}) RETURNING id`);
    const u = await member(t.id);
    const gone = await sentConversation(t.id, u);
    const other = await sentConversation(teamB, userB);

    await db.delete(teams).where(eq(teams.id, t.id));
    const r = await removeTeamChatAttachments(t.id, { storage });
    expect(r).toEqual({ removed: 2, objectsRemoved: 1 });
    expect((await rowCount(gone.pasteId)).artifact).toBe(0);
    expect((await rowCount(gone.fileId)).artifact).toBe(0);
    // Team B's live conversation keeps everything.
    expect(await rowCount(other.pasteId)).toEqual({ artifact: 1, revisions: 1, links: 1 });
    expect(await rowCount(other.fileId)).toEqual({ artifact: 1, revisions: 1, links: 1 });
    expect(objects.has(other.storageKey)).toBe(true);
  });

  test('scoping to one team never removes another team\'s orphan', async () => {
    const s = await sentConversation(teamB, userB);
    await db.delete(conversations).where(eq(conversations.id, s.convId));
    expect((await removeOrphanChatAttachments({ teamId: teamA, storage })).removed).toBe(0);
    expect((await rowCount(s.pasteId)).artifact).toBe(1);
    // The unscoped sweep takes it.
    expect((await removeOrphanChatAttachments({ storage })).removed).toBeGreaterThanOrEqual(2);
    expect((await rowCount(s.pasteId)).artifact).toBe(0);
    expect(objects.has(s.storageKey)).toBe(false);
  });
});

describe('the maintenance sweep', () => {
  test('takes what a crash left behind and keeps live attachments', async () => {
    const live = await sentConversation(teamA, userA);
    // Crash after the conversation went but before cleanup ran.
    const crashed = await sentConversation(teamA, userA);
    await db.delete(conversations).where(eq(conversations.id, crashed.convId));
    // Crash after the paste was stored but before its message was saved: no link, ever.
    const convC = await conversation(teamA, userA);
    const neverSent = randomUUID();
    const p = await storeChatAttachments({ id: convC, teamId: teamA } as never, userA, [{ id: neverSent, title: 'Draft', text: 'x'.repeat(9_000) }]);
    expect(p.ok).toBe(true);

    const now = new Date();
    await removeOrphanChatAttachments({ now, storage });
    expect((await rowCount(crashed.pasteId)).artifact).toBe(0);
    expect((await rowCount(crashed.fileId)).artifact).toBe(0);
    expect(objects.has(crashed.storageKey)).toBe(false);
    // An unlinked paste is kept while a retry could still send it...
    expect((await rowCount(neverSent)).artifact).toBe(1);
    // ...and goes once it is past the window.
    await removeOrphanChatAttachments({ now: new Date(now.getTime() + STALE_UPLOAD_MS + 60_000), storage });
    expect((await rowCount(neverSent)).artifact).toBe(0);
    // Live attachments are never touched, however old.
    expect(await rowCount(live.pasteId)).toEqual({ artifact: 1, revisions: 1, links: 1 });
    expect(await rowCount(live.fileId)).toEqual({ artifact: 1, revisions: 1, links: 1 });
    expect(objects.has(live.storageKey)).toBe(true);
  });

  test('never touches a workspace artifact, however unlinked', async () => {
    const { workspaceId } = await seedWorkspace();
    const [a] = await db.insert(artifacts).values({ workspaceId, type: 'content', title: 'report', content: 'body', metadata: { chatAttachment: { conversationId: randomUUID(), teamId: teamA, source: 'paste' } } }).returning({ id: artifacts.id });
    await removeOrphanChatAttachments({ now: new Date(Date.now() + 2 * STALE_UPLOAD_MS), storage });
    expect((await rowCount(a.id)).artifact).toBe(1);
  });
});
