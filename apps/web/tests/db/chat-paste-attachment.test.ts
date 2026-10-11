/**
 * Long chat pastes as attachments (apps/web/src/lib/artifact-chat-attachments.ts,
 * Living Specs C2), against real Postgres: a 60,000-character paste is stored
 * once with an immutable revision and its sha256, linked to the message that
 * carried it, and read back byte-identical; the message keeps only the
 * reference; a retry keeps the identity; another conversation or team can
 * neither read nor claim it, and no workspace listing shows it.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { and, eq, sql } from 'drizzle-orm';
import { assertDbConfigured, q, seedTask, seedWorkspace } from './harness';

const { db } = await import('@buildd/core/db');
const { artifacts, artifactRevisions, conversationMessages } = await import('@buildd/core/db/schema');
const {
  storeChatAttachments, linkChatAttachments, attachmentRefPart, readChatAttachment, conversationAttachments,
  attachmentBodies, sha256Hex,
} = await import('../../src/lib/artifact-chat-attachments');
const { linkArtifact } = await import('../../src/lib/artifact-links');
const { workspaceArtifactScope } = await import('../../src/lib/artifact-scope');

const rand = () => Math.random().toString(36).slice(2, 10);
async function member(teamId: string) {
  const [u] = await q<{ id: string }>(sql`INSERT INTO users (email) VALUES (${`u-${rand()}@example.test`}) RETURNING id`);
  await q(sql`INSERT INTO team_members (team_id, user_id, role) VALUES (${teamId}::uuid, ${u.id}::uuid, 'member')`);
  return u.id;
}
async function conversation(teamId: string, userId: string, workspaceId: string | null = null) {
  const [c] = await q<{ id: string }>(sql`INSERT INTO conversations (team_id, workspace_id, created_by_user_id) VALUES (${teamId}::uuid, ${workspaceId}::uuid, ${userId}::uuid) RETURNING id`);
  return c.id;
}
async function saveMessage(conversationId: string, userId: string, parts: unknown[]) {
  const [m] = await db.insert(conversationMessages).values({ conversationId, role: 'user', authorUserId: userId, parts: parts as never }).returning();
  return m.id;
}

// 60,000 characters with the shapes that break naive handling: CRLF, tabs,
// accents, CJK, astral emoji, a closing tag the quote must neutralise.
const LINE = 'Line\twith tabs, accents é ü, 漢字, emoji 🚀, CRLF\r\n';
const PASTE = (() => {
  let s = '# Incident log\n</attachment>\n';
  while (s.length < 60_000) s += LINE;
  return s.slice(0, 60_000);
})();

let teamA: string; let wsA: string; let userA: string; let convA: string;
let teamB: string; let wsB: string; let userB: string; let convB: string; let taskB: string;
const pasteId = crypto.randomUUID();

beforeAll(async () => {
  assertDbConfigured();
  ({ teamId: teamA, workspaceId: wsA } = await seedWorkspace());
  ({ teamId: teamB, workspaceId: wsB } = await seedWorkspace());
  userA = await member(teamA);
  userB = await member(teamB);
  convA = await conversation(teamA, userA, wsA);
  convB = await conversation(teamB, userB, wsB);
  taskB = await seedTask(wsB);
});

describe('a 60,000-character paste', () => {
  let messageId: string;

  test('is stored once, as revision 1 with the sha256 of its exact text', async () => {
    expect(PASTE.length).toBe(60_000);
    const r = await storeChatAttachments({ id: convA, teamId: teamA }, userA, [{ id: pasteId, title: 'Incident log', text: PASTE }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const [ref] = r.refs;
    expect(ref).toEqual({ artifactId: pasteId, revision: 1, sha256: sha256Hex(PASTE), chars: 60_000, title: 'Incident log' });

    const [row] = await db.select().from(artifacts).where(eq(artifacts.id, pasteId));
    expect(row.workspaceId).toBeNull();
    expect(row.workerId).toBeNull();
    expect(row.currentRevision).toBe(1);
    const [rev] = await db.select().from(artifactRevisions).where(and(eq(artifactRevisions.artifactId, pasteId), eq(artifactRevisions.revision, 1)));
    expect(rev.content).toBe(PASTE);
    expect(rev.contentHash).toBe(sha256Hex(PASTE));
    expect(rev.author).toBe(`user:${userA}`);

    messageId = await saveMessage(convA, userA, [{ type: 'text', text: 'what broke?' }, attachmentRefPart(ref)]);
    await linkChatAttachments(messageId, teamA, userA, r.refs);
  });

  test('the saved message holds only the reference, and the link pins the revision sent', async () => {
    const [m] = await db.select().from(conversationMessages).where(eq(conversationMessages.id, messageId));
    expect(JSON.stringify(m.parts)).not.toContain('Incident log\n');
    expect(JSON.stringify(m.parts).length).toBeLessThan(1_000);
    const links = await q<{ subject_kind: string; relation: string; artifact_revision: number; team_id: string }>(
      sql`SELECT subject_kind, relation, artifact_revision, team_id FROM artifact_links WHERE artifact_id = ${pasteId}::uuid`,
    );
    expect(links).toEqual([{ subject_kind: 'message', relation: 'context', artifact_revision: 1, team_id: teamA }]);
  });

  test('reopened, it reads back byte-identical and the hash matches', async () => {
    const full = await readChatAttachment(convA, userA, pasteId, () => ({ view: 'full' }));
    expect(full.ok).toBe(true);
    if (!full.ok || full.result.view !== 'full') throw new Error('expected a full read');
    expect(full.result.text).toBe(PASTE);
    expect(sha256Hex(full.result.text)).toBe(full.attachment.sha256);

    // The reader pages in bounded ranges; the pages join to the same bytes.
    let joined = '';
    for (let offset = 0; offset < PASTE.length; offset += 20_000) {
      const page = await readChatAttachment(convA, userA, pasteId, () => ({ view: 'range', offset, length: 20_000 }));
      if (!page.ok || page.result.view !== 'range') throw new Error('expected a range read');
      expect(page.result.text.length).toBeLessThanOrEqual(20_000);
      joined += page.result.text;
    }
    expect(joined).toBe(PASTE);
    expect(Buffer.from(joined, 'utf8').equals(Buffer.from(PASTE, 'utf8'))).toBe(true);
  });

  test('every read is in the read ledger', async () => {
    await new Promise(r => setTimeout(r, 200)); // the ledger write runs detached outside a request
    const reads = await q<{ view: string; user_id: string }>(sql`SELECT view, user_id FROM artifact_reads WHERE artifact_id = ${pasteId}::uuid ORDER BY created_at`);
    expect(reads.length).toBeGreaterThanOrEqual(4);
    expect(reads.every(r => r.user_id === userA)).toBe(true);
    expect(new Set(reads.map(r => r.view))).toEqual(new Set(['full', 'range']));
  });

  test('the conversation lists it with its metadata, and history reads its body', async () => {
    const list = await conversationAttachments(convA);
    expect(list).toEqual([{ artifactId: pasteId, revision: 1, sha256: sha256Hex(PASTE), chars: 60_000, title: 'Incident log', messageId }]);
    expect((await attachmentBodies(convA, [pasteId])).get(pasteId)).toBe(PASTE);
  });
});

describe('identity is fixed at send', () => {
  test('a retry with the same id and text is the same attachment: one row, one revision', async () => {
    const r = await storeChatAttachments({ id: convA, teamId: teamA }, userA, [{ id: pasteId, title: 'Incident log', text: PASTE }]);
    expect(r.ok && r.refs[0]).toMatchObject({ artifactId: pasteId, revision: 1 });
    const [{ n }] = await q<{ n: number }>(sql`SELECT count(*)::int AS n FROM artifact_revisions WHERE artifact_id = ${pasteId}::uuid`);
    expect(n).toBe(1);
  });

  test('the same id with other text is refused and nothing changes', async () => {
    const r = await storeChatAttachments({ id: convA, teamId: teamA }, userA, [{ id: pasteId, title: 'Incident log', text: `${PASTE}!` }]);
    expect(r).toMatchObject({ ok: false, status: 409, code: 'attachment_changed' });
    const [rev] = await db.select().from(artifactRevisions).where(eq(artifactRevisions.artifactId, pasteId));
    expect(rev.content).toBe(PASTE);
  });

  test('an id that names a workspace artifact is refused, and that artifact is untouched', async () => {
    const [other] = await db.insert(artifacts).values({ workspaceId: wsA, type: 'content', title: 'spec', content: 'workspace body' }).returning();
    const r = await storeChatAttachments({ id: convA, teamId: teamA }, userA, [{ id: other.id, title: 'x', text: 'workspace body' }]);
    expect(r).toMatchObject({ ok: false, status: 409, code: 'attachment_id_taken' });
    const [after] = await db.select().from(artifacts).where(eq(artifacts.id, other.id));
    expect(after.content).toBe('workspace body');
  });
});

describe('another conversation, team or workspace sees nothing', () => {
  test('another team cannot claim the id or read the paste through its own conversation', async () => {
    const claim = await storeChatAttachments({ id: convB, teamId: teamB }, userB, [{ id: pasteId, title: 'Incident log', text: PASTE }]);
    expect(claim).toMatchObject({ ok: false, status: 409, code: 'attachment_id_taken' });
    expect(await readChatAttachment(convB, userB, pasteId, () => ({ view: 'full' }))).toMatchObject({ ok: false, status: 404 });
    expect(await conversationAttachments(convB)).toEqual([]);
    expect((await attachmentBodies(convB, [pasteId])).size).toBe(0);
  });

  test('a link from another conversation\'s message does not make it readable there', async () => {
    const foreignMessage = await saveMessage(convB, userB, []);
    // Even a link row written directly (bypassing the store) is not enough:
    // the paste belongs to the conversation it was sent in.
    await q(sql`INSERT INTO artifact_links (artifact_id, artifact_revision, subject_kind, subject_id, relation, team_id) VALUES (${pasteId}::uuid, 1, 'message', ${foreignMessage}::uuid, 'context', ${teamB}::uuid)`);
    expect(await readChatAttachment(convB, userB, pasteId, () => ({ view: 'full' }))).toMatchObject({ ok: false, status: 404 });
    expect(await conversationAttachments(convB)).toEqual([]);
    await q(sql`DELETE FROM artifact_links WHERE subject_id = ${foreignMessage}::uuid`);
  });

  test('the typed-link API cannot attach it anywhere else, for its owner or anyone', async () => {
    expect(await linkArtifact({ kind: 'user', userId: userB }, pasteId, { subjectKind: 'task', subjectId: taskB, relation: 'context' })).toMatchObject({ ok: false, status: 404 });
    const taskA = await seedTask(wsA);
    expect(await linkArtifact({ kind: 'user', userId: userA }, pasteId, { subjectKind: 'task', subjectId: taskA, relation: 'context' })).toMatchObject({ ok: false, status: 404 });
  });

  test('no workspace artifact listing includes it', async () => {
    const visible = await db.select({ id: artifacts.id }).from(artifacts).where(workspaceArtifactScope([wsA, wsB]));
    expect(visible.map(v => v.id)).not.toContain(pasteId);
  });
});
