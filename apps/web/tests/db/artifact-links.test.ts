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
const { linkArtifact, unlinkArtifact, linksOfArtifact, artifactsLinkedTo, linkContextArtifacts } = await import('../../src/lib/artifact-links');
const { buildMissionContext } = await import('../../src/lib/mission-context');
const { attachArtifactReferences } = await import('../../src/app/api/workers/claim/context-injection');

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

describe('contextArtifactIds is dual-written into links and read from them', () => {
  async function missionWithColumn(ids: string[]) {
    const id = await seedMission(teamA, wsA);
    await q(sql`UPDATE missions SET context_artifact_ids = ${JSON.stringify(ids)}::jsonb WHERE id = ${id}::uuid`);
    return id;
  }
  async function contextArtifactIdsOf(missionId: string) {
    const [m] = await q<{ ids: string[] }>(sql`SELECT context_artifact_ids AS ids FROM missions WHERE id = ${missionId}::uuid`);
    return m.ids;
  }
  const referenced = async (missionId: string) => (await buildMissionContext(missionId)).context.priorArtifacts.map((a: { artifactId: string }) => a.artifactId);

  test('each id becomes a context link, and mission context reads it', async () => {
    const [ref] = await db.insert(artifacts).values({ workspaceId: wsA, type: 'content', title: `ref ${rand()}`, content: 'reference body' }).returning();
    const m = await missionWithColumn([ref.id]);
    const r = await linkContextArtifacts(A(), 'mission', m, [ref.id]);
    expect(r).toEqual({ linked: [ref.id], failed: [] });
    const linked = await artifactsLinkedTo('mission', m, { relations: ['context'] });
    expect(Array.isArray(linked) && linked.map((l) => l.artifactId)).toEqual([ref.id]);
    expect(await referenced(m)).toContain(ref.id);
  });

  test('a mission from before links is still read from its column', async () => {
    const [old] = await db.insert(artifacts).values({ workspaceId: wsA, type: 'content', title: `old ${rand()}`, content: 'old body' }).returning();
    const m = await missionWithColumn([old.id]);
    expect(await referenced(m)).toContain(old.id);
  });

  test('unlinking a context link removes the id from the column too, so it is gone from context', async () => {
    const [ref] = await db.insert(artifacts).values({ workspaceId: wsA, type: 'content', title: `gone ${rand()}`, content: 'x' }).returning();
    const m = await missionWithColumn([ref.id, artifactId]);
    await linkContextArtifacts(A(), 'mission', m, [ref.id, artifactId]);
    const [link] = await q<{ id: string }>(sql`SELECT id FROM artifact_links WHERE subject_id = ${m}::uuid AND artifact_id = ${ref.id}::uuid`);
    expect(await unlinkArtifact(A(), ref.id, link.id)).toEqual({ ok: true });
    expect(await contextArtifactIdsOf(m)).toEqual([artifactId]);
    expect(await referenced(m)).not.toContain(ref.id);
  });

  test('an id another team owns is not linked, and says why', async () => {
    const [foreign] = await db.insert(artifacts).values({ workspaceId: wsB, type: 'content', title: 'theirs', content: 'b' }).returning();
    const m = await seedMission(teamA, wsA);
    const r = await linkContextArtifacts(A(), 'mission', m, [foreign.id]);
    expect(r.linked).toEqual([]);
    expect(r.failed.map((f) => f.artifactId)).toEqual([foreign.id]);
  });
});

describe('a per-task token reaches only its own workspace', () => {
  test('a task-scoped account cannot link into, or read links of, another workspace of its own team', async () => {
    // The minting account is team A's; the token is confined to a workspace other than wsA.
    const { workspaceId: ws2 } = await seedWorkspace();
    const account = { id: crypto.randomUUID(), teamId: teamA, level: 'admin' } as never;
    const scoped = { kind: 'account' as const, account, taskScope: { workspaceId: ws2 } };
    expect(await linksOfArtifact(scoped, artifactId)).toMatchObject({ ok: false, status: 404 });
    expect(await linkArtifact(scoped, artifactId, { subjectKind: 'mission', subjectId: missionA, relation: 'context' })).toMatchObject({ ok: false, status: 404 });
  });
});

describe('the claim-time reference manifest', () => {
  test('lists the task\'s and its mission\'s links with size, revision and hash, never the body', async () => {
    const body = `manifest body ${rand()}`;
    const [ref] = await db.insert(artifacts).values({ workspaceId: wsA, type: 'content', title: `spec ${rand()}`, content: body }).returning();
    const t = await seedTask(wsA, { missionId: missionA });
    await linkArtifact(A(), ref.id, { subjectKind: 'task', subjectId: t, relation: 'normative_reference' });
    await linkArtifact(A(), ref.id, { subjectKind: 'mission', subjectId: missionA, relation: 'context' });
    const cw = { taskId: t, task: { id: t, context: {} } } as any;
    await attachArtifactReferences([cw], [{ id: t, title: 'x', workspaceId: wsA, missionId: missionA } as any]);

    const block: string = cw.resolvedContextProviders?.[0] ?? '';
    expect(block).toContain('## Linked artifacts');
    expect(block).toContain(ref.id);
    expect(block).not.toContain(body);
    const entries = cw.task.context.artifactManifest as Array<Record<string, unknown>>;
    const pinned = entries.find((e) => e.artifactId === ref.id && e.relation === 'normative_reference');
    const [rev] = await q<{ hash: string }>(sql`SELECT content_hash AS hash FROM artifact_revisions WHERE artifact_id = ${ref.id}::uuid AND revision = 1`);
    expect(pinned).toMatchObject({ via: 'task', revision: 1, pinned: true, sizeBytes: Buffer.byteLength(body), contentHash: rev.hash });
    expect(entries.find((e) => e.artifactId === ref.id && e.relation === 'context')).toMatchObject({ via: 'mission', pinned: false });
  });

  test('a task with no links gets no block', async () => {
    const t = await seedTask(wsB);
    const cw = { taskId: t, task: { id: t, context: {} } } as any;
    await attachArtifactReferences([cw], [{ id: t, title: 'x', workspaceId: wsB } as any]);
    expect(cw.resolvedContextProviders).toBeUndefined();
  });
});

describe('an upload is linkable only once its bytes are verified', () => {
  test('a pending or failed upload is refused with 409 naming its state; ready and legacy rows link', async () => {
    const mk = async (uploadState: 'pending' | 'failed' | 'ready' | null) => {
      const [a] = await db.insert(artifacts).values({ workspaceId: wsA, type: 'file', title: `upload ${rand()}`, storageKey: `artifacts/${rand()}.png`, uploadState }).returning();
      return a.id;
    };
    for (const state of ['pending', 'failed'] as const) {
      const r = await linkArtifact(A(), await mk(state), { subjectKind: 'task', subjectId: taskA, relation: 'context' });
      expect(r.ok).toBe(false);
      if (!r.ok) { expect(r.status).toBe(409); expect(r.error).toContain(state); }
    }
    for (const state of ['ready', null] as const) {
      const r = await linkArtifact(A(), await mk(state), { subjectKind: 'task', subjectId: taskA, relation: 'context' });
      expect(r.ok).toBe(true);
    }
  });
});
