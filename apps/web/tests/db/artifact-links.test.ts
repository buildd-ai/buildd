/**
 * Typed artifact links (apps/web/src/lib/artifact-links.ts), against real
 * Postgres: one artifact linked from a chat message, a mission and a task with
 * a single payload row; an unrelated workspace sees neither the metadata nor
 * the link; a normative reference stays pinned to its revision after the body
 * moves on.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import { assertDbConfigured, q, seedMission, seedTask, seedWorkspace } from './harness';

const { db } = await import('@buildd/core/db');
const { artifacts } = await import('@buildd/core/db/schema');
const { linkArtifact, unlinkArtifact, linksOfArtifact, artifactsLinkedTo } = await import('../../src/lib/artifact-links');

const rand = () => Math.random().toString(36).slice(2, 10);
async function member(teamId: string) {
  const [u] = await q<{ id: string }>(sql`INSERT INTO users (email) VALUES (${`u-${rand()}@example.test`}) RETURNING id`);
  await q(sql`INSERT INTO team_members (team_id, user_id, role) VALUES (${teamId}::uuid, ${u.id}::uuid, 'member')`);
  return u.id;
}
async function conversationOf(teamId: string, userId: string) {
  const [c] = await q<{ id: string }>(sql`INSERT INTO conversations (team_id, created_by_user_id) VALUES (${teamId}::uuid, ${userId}::uuid) RETURNING id`);
  const [m] = await q<{ id: string }>(sql`INSERT INTO conversation_messages (conversation_id, role, parts) VALUES (${c.id}::uuid, 'user', '[]'::jsonb) RETURNING id`);
  return { conversationId: c.id, messageId: m.id };
}

let teamA: string; let wsA: string; let userA: string; let missionA: string; let taskA: string; let chat: { conversationId: string; messageId: string };
let teamB: string; let wsB: string; let userB: string; let taskB: string;
let artifactId: string;
const TITLE = `design screenshot ${rand()}`;

beforeAll(async () => {
  assertDbConfigured();
  ({ teamId: teamA, workspaceId: wsA } = await seedWorkspace());
  ({ teamId: teamB, workspaceId: wsB } = await seedWorkspace());
  userA = await member(teamA);
  userB = await member(teamB);
  missionA = await seedMission(teamA, wsA);
  taskA = await seedTask(wsA, { missionId: missionA });
  taskB = await seedTask(wsB);
  chat = await conversationOf(teamA, userA);
  const [a] = await db.insert(artifacts).values({ workspaceId: wsA, type: 'file', title: TITLE, content: 'v1 body' }).returning();
  artifactId = a.id;
});

const A = () => ({ kind: 'user' as const, userId: userA });
const B = () => ({ kind: 'user' as const, userId: userB });

describe('one artifact, many subjects, one payload row', () => {
  test('a message, a mission and a task link the same artifact without copying it', async () => {
    for (const [subjectKind, subjectId, relation] of [['message', chat.messageId, 'context'], ['mission', missionA, 'design_reference'], ['task', taskA, 'context']] as const) {
      const r = await linkArtifact(A(), artifactId, { subjectKind, subjectId, relation });
      expect(r.ok).toBe(true);
    }
    const [{ n }] = await q<{ n: number }>(sql`SELECT count(*)::int AS n FROM artifacts WHERE title = ${TITLE}`);
    expect(n).toBe(1);
    const all = await linksOfArtifact(A(), artifactId);
    expect(all.ok && all.links.map((l) => l.subjectKind).sort()).toEqual(['message', 'mission', 'task']);
    const forMission = await artifactsLinkedTo('mission', missionA, { caller: A() });
    expect(Array.isArray(forMission) && forMission.map((x) => [x.artifactId, x.relation])).toEqual([[artifactId, 'design_reference']]);
  });

  test('linking twice updates the link instead of duplicating it', async () => {
    await linkArtifact(A(), artifactId, { subjectKind: 'task', subjectId: taskA, relation: 'context' });
    const [{ n }] = await q<{ n: number }>(sql`SELECT count(*)::int AS n FROM artifact_links WHERE subject_id = ${taskA}::uuid AND relation = 'context'`);
    expect(n).toBe(1);
  });
});

describe('an unrelated workspace sees nothing', () => {
  test('another team cannot link the artifact, read its links, or see it through a subject', async () => {
    expect(await linkArtifact(B(), artifactId, { subjectKind: 'task', subjectId: taskB, relation: 'context' })).toMatchObject({ ok: false, status: 404 });
    expect(await linksOfArtifact(B(), artifactId)).toMatchObject({ ok: false, status: 404 });
    expect(await artifactsLinkedTo('mission', missionA, { caller: B() })).toMatchObject({ ok: false, status: 404 });
  });

  test('a caller who can read the artifact still cannot attach it to another team\'s subject', async () => {
    // userA can read the artifact but taskB is in team B: refused, and nothing written.
    expect(await linkArtifact(A(), artifactId, { subjectKind: 'task', subjectId: taskB, relation: 'context' })).toMatchObject({ ok: false, status: 404 });
    const [{ n }] = await q<{ n: number }>(sql`SELECT count(*)::int AS n FROM artifact_links WHERE subject_id = ${taskB}::uuid`);
    expect(n).toBe(0);
  });

  test('a chat subject is its creator\'s only, even within the team', async () => {
    const teammate = await member(teamA);
    expect(await linkArtifact({ kind: 'user', userId: teammate }, artifactId, { subjectKind: 'message', subjectId: chat.messageId, relation: 'context' }))
      .toMatchObject({ ok: false, status: 404 });
  });
});

describe('normative references are pinned', () => {
  test('an unpinned normative reference pins the current revision and keeps resolving it after the body changes', async () => {
    const r = await linkArtifact(A(), artifactId, { subjectKind: 'task', subjectId: taskA, relation: 'normative_reference' });
    expect(r.ok && r.link.artifactRevision).toBe(1);
    await db.update(artifacts).set({ content: 'v2 body' }).where(eq(artifacts.id, artifactId));
    const linked = await artifactsLinkedTo('task', taskA, { caller: A(), relations: ['normative_reference'] });
    expect(Array.isArray(linked) && linked[0]).toMatchObject({ pinnedRevision: 1, currentRevision: 2 });
    const [{ hash }] = await q<{ hash: string }>(sql`SELECT content_hash AS hash FROM artifact_revisions WHERE artifact_id = ${artifactId}::uuid AND revision = 1`);
    expect(Array.isArray(linked) && linked[0].contentHash).toBe(hash);
  });

  test('the table refuses an unpinned normative reference written around the library', async () => {
    await expect(q(sql`INSERT INTO artifact_links (artifact_id, subject_kind, subject_id, relation, team_id)
      VALUES (${artifactId}::uuid, 'mission', ${missionA}::uuid, 'normative_reference', ${teamA}::uuid)`)).rejects.toThrow();
  });

  test('a pin to a revision that does not exist is refused', async () => {
    expect(await linkArtifact(A(), artifactId, { subjectKind: 'mission', subjectId: missionA, relation: 'requirement', revision: 99 })).toMatchObject({ ok: false, status: 404 });
  });
});

describe('unlink', () => {
  test('removes only a link the caller can reach', async () => {
    const r = await linkArtifact(A(), artifactId, { subjectKind: 'mission', subjectId: missionA, relation: 'evidence' });
    if (!r.ok) throw new Error('link failed');
    expect(await unlinkArtifact(B(), artifactId, r.link.id)).toMatchObject({ ok: false, status: 404 });
    expect(await unlinkArtifact(A(), artifactId, r.link.id)).toEqual({ ok: true });
  });

  test('refuses an unknown subject kind and the kinds that do not exist yet', async () => {
    expect(await linkArtifact(A(), artifactId, { subjectKind: 'spec_revision', subjectId: missionA, relation: 'context' })).toMatchObject({ ok: false, status: 400 });
    expect(await linkArtifact(A(), artifactId, { subjectKind: 'nope', subjectId: missionA, relation: 'context' })).toMatchObject({ ok: false, status: 400 });
  });
});
