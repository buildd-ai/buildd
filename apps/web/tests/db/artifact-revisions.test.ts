/**
 * Artifact revisions (migration *_artifact_revisions_trigger), against real
 * Postgres: every body change appends an immutable, hashed revision in the same
 * statement, a body from before revisions existed is kept as revision 1, and a
 * compare-and-swap on current_revision refuses a lost update.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'crypto';
import { eq, sql } from 'drizzle-orm';
import { assertDbConfigured, q, seedWorkspace } from './harness';

const { db } = await import('@buildd/core/db');
const { artifacts } = await import('@buildd/core/db/schema');
const { getArtifactRevision, writeArtifactBody } = await import('../../src/lib/artifact-revisions');
const { redactArtifactText } = await import('@buildd/core/artifact-redaction');

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

type Rev = { revision: number; content: string | null; content_hash: string | null; size_bytes: number | null; author: string | null };
const revisionsOf = (id: string) => q<Rev>(sql`
  SELECT revision, content, content_hash, size_bytes, author FROM artifact_revisions
  WHERE artifact_id = ${id}::uuid ORDER BY revision`);

let workspaceId: string;
async function insertArtifact(content: string | null, extra: { contentAuthor?: string } = {}) {
  const [a] = await db.insert(artifacts).values({ workspaceId, type: 'content', title: 't', content, ...extra }).returning();
  return a;
}

beforeAll(async () => {
  assertDbConfigured();
  ({ workspaceId } = await seedWorkspace());
});

describe('every body write is a revision', () => {
  test('an inserted body is revision 1, hashed over its UTF-8 bytes', async () => {
    const body = 'héllo 🚀 world';
    const a = await insertArtifact(body, { contentAuthor: 'user:u1' });
    expect(a.currentRevision).toBe(1);
    const [r] = await revisionsOf(a.id);
    expect(r).toEqual({ revision: 1, content: body, content_hash: sha256(body), size_bytes: Buffer.byteLength(body), author: 'user:u1' });
  });

  test('a change appends N+1 and N stays byte-identical; a metadata-only write appends nothing', async () => {
    const a = await insertArtifact('v1');
    await db.update(artifacts).set({ content: 'v2' }).where(eq(artifacts.id, a.id));
    await db.update(artifacts).set({ title: 'renamed', metadata: { x: 1 } }).where(eq(artifacts.id, a.id));
    await db.update(artifacts).set({ content: 'v2' }).where(eq(artifacts.id, a.id)); // unchanged body
    const revs = await revisionsOf(a.id);
    expect(revs.map((r) => [r.revision, r.content])).toEqual([[1, 'v1'], [2, 'v2']]);
    const [row] = await db.select({ n: artifacts.currentRevision }).from(artifacts).where(eq(artifacts.id, a.id));
    expect(row.n).toBe(2);
  });

  test('a 60,000-character astral paste keeps its exact bytes and hash', async () => {
    const body = '𝔘nicode ✓ '.repeat(6000).slice(0, 60_000);
    const a = await insertArtifact('short');
    await db.update(artifacts).set({ content: body }).where(eq(artifacts.id, a.id));
    const rev = await getArtifactRevision(a.id, 2);
    expect(rev?.content).toBe(body);
    expect(rev?.contentHash).toBe(sha256(body));
  });

  test('a body from before revisions existed is kept as revision 1 on its first change', async () => {
    await q(sql`ALTER TABLE artifacts DISABLE TRIGGER artifacts_record_revision`);
    await q(sql`ALTER TABLE artifacts DISABLE TRIGGER artifacts_record_first_revision`);
    let id: string;
    try {
      [{ id }] = await q<{ id: string }>(sql`
        INSERT INTO artifacts (workspace_id, type, title, content) VALUES (${workspaceId}::uuid, 'content', 'old', 'legacy body') RETURNING id`);
    } finally {
      await q(sql`ALTER TABLE artifacts ENABLE TRIGGER artifacts_record_revision`);
      await q(sql`ALTER TABLE artifacts ENABLE TRIGGER artifacts_record_first_revision`);
    }
    await db.update(artifacts).set({ content: 'new body' }).where(eq(artifacts.id, id!));
    const revs = await revisionsOf(id!);
    expect(revs.map((r) => [r.revision, r.content, r.author])).toEqual([[1, 'legacy body', 'legacy'], [2, 'new body', null]]);
  });

  test('a writer cannot set current_revision itself', async () => {
    const a = await insertArtifact('x');
    await db.update(artifacts).set({ currentRevision: 99, content: 'y' }).where(eq(artifacts.id, a.id));
    const [row] = await db.select({ n: artifacts.currentRevision }).from(artifacts).where(eq(artifacts.id, a.id));
    expect(row.n).toBe(2);
  });

  test('the author names only the statement that set it', async () => {
    const a = await insertArtifact('a', { contentAuthor: 'user:first' });
    await db.update(artifacts).set({ content: 'b' }).where(eq(artifacts.id, a.id));
    await db.update(artifacts).set({ content: 'c', contentAuthor: 'account:k' }).where(eq(artifacts.id, a.id));
    expect((await revisionsOf(a.id)).map((r) => r.author)).toEqual(['user:first', null, 'account:k']);
  });
});

describe('the same writer creating then editing', () => {
  test('both revisions name that writer', async () => {
    const a = await insertArtifact('first', { contentAuthor: 'account:k' });
    await writeArtifactBody(a.id, { content: 'second', expectedRevision: 1, author: 'account:k' });
    expect((await revisionsOf(a.id)).map((r) => r.author)).toEqual(['account:k', 'account:k']);
  });
});

describe('redacting a value removes it from history too', () => {
  test('the current body is rewritten and every revision holding the value is deleted, legacy snapshot included', async () => {
    const secret = 'sk_live_9f_x%y_SECRET';
    await q(sql`ALTER TABLE artifacts DISABLE TRIGGER artifacts_record_revision`);
    await q(sql`ALTER TABLE artifacts DISABLE TRIGGER artifacts_record_first_revision`);
    let legacyId: string;
    try {
      [{ id: legacyId }] = await q<{ id: string }>(sql`
        INSERT INTO artifacts (workspace_id, type, title, content) VALUES (${workspaceId}::uuid, 'content', 'old', ${`token=${secret}`}) RETURNING id`);
    } finally {
      await q(sql`ALTER TABLE artifacts ENABLE TRIGGER artifacts_record_revision`);
      await q(sql`ALTER TABLE artifacts ENABLE TRIGGER artifacts_record_first_revision`);
    }
    const a = await insertArtifact(`v1 ${secret}`);
    await db.update(artifacts).set({ content: `v2 ${secret}` }).where(eq(artifacts.id, a.id));
    // A near-miss that only LIKE would match (`_` and `%` are wildcards there) must survive.
    const bystander = await insertArtifact('sk_live_9fAx-yASECRET');

    const result = await redactArtifactText(secret, '[REDACTED]');
    expect(result.bodies).toBe(2);
    for (const id of [legacyId!, a.id]) {
      const revs = await revisionsOf(id);
      expect(revs.length).toBeGreaterThan(0);
      expect(revs.every((r) => !r.content?.includes(secret))).toBe(true);
      const [row] = await db.select({ content: artifacts.content }).from(artifacts).where(eq(artifacts.id, id));
      expect(row.content).toContain('[REDACTED]');
      expect((await getArtifactRevision(id, revs.at(-1)!.revision))?.content).toContain('[REDACTED]');
    }
    expect((await revisionsOf(bystander.id)).map((r) => r.content)).toEqual(['sk_live_9fAx-yASECRET']);
  });
});

describe('revisions are immutable', () => {
  test('rewriting a revision is refused; filling a NULL hash once is allowed', async () => {
    const a = await insertArtifact('keep me');
    await expect(q(sql`UPDATE artifact_revisions SET content = 'tampered' WHERE artifact_id = ${a.id}::uuid`)).rejects.toThrow();
    await expect(q(sql`UPDATE artifact_revisions SET content_hash = 'x' WHERE artifact_id = ${a.id}::uuid`)).rejects.toThrow();

    const [f] = await db.insert(artifacts).values({ workspaceId, type: 'file', title: 'f', storageKey: `artifacts/${workspaceId}/f.bin` }).returning();
    await q(sql`UPDATE artifact_revisions SET content_hash = 'abc', size_bytes = 3 WHERE artifact_id = ${f.id}::uuid`);
    await expect(q(sql`UPDATE artifact_revisions SET content_hash = 'def' WHERE artifact_id = ${f.id}::uuid`)).rejects.toThrow();
    expect((await revisionsOf(a.id))[0].content).toBe('keep me');
  });
});

describe('writeArtifactBody: compare-and-swap', () => {
  test('two writers holding the same revision: one wins, the other is told the current revision, both texts survive', async () => {
    const a = await insertArtifact('base');
    const [r1, r2] = await Promise.all([
      writeArtifactBody(a.id, { content: 'writer A', expectedRevision: 1, author: 'account:a' }),
      writeArtifactBody(a.id, { content: 'writer B', expectedRevision: 1, author: 'account:b' }),
    ]);
    const outcomes = [r1, r2].map((r) => r.ok);
    expect(outcomes.sort()).toEqual([false, true]);
    const lost = [r1, r2].find((r) => !r.ok)!;
    expect(lost).toMatchObject({ ok: false, conflict: true, currentRevision: 2 });
    const revs = await revisionsOf(a.id);
    expect(revs).toHaveLength(2);

    // The loser re-reads N=2 and retries on top of it: nothing is overwritten unseen.
    const retry = await writeArtifactBody(a.id, { content: 'writer B (merged)', expectedRevision: 2, author: 'account:b' });
    expect(retry).toMatchObject({ ok: true, revision: 3 });
    expect((await revisionsOf(a.id)).map((r) => r.revision)).toEqual([1, 2, 3]);
  });

  test('an unchanged body with the right revision is a no-op success', async () => {
    const a = await insertArtifact('same');
    expect(await writeArtifactBody(a.id, { content: 'same', expectedRevision: 1 })).toMatchObject({ ok: true, revision: 1, unchanged: true });
    expect(await revisionsOf(a.id)).toHaveLength(1);
  });

  test('without expectedRevision the write still lands as a recorded revision', async () => {
    const a = await insertArtifact('one');
    expect(await writeArtifactBody(a.id, { content: 'two' })).toMatchObject({ ok: true, revision: 2 });
  });

  test('a missing artifact is not a conflict', async () => {
    expect(await writeArtifactBody('00000000-0000-4000-8000-000000000000', { content: 'x', expectedRevision: 1 }))
      .toMatchObject({ ok: false, conflict: false });
  });
});
