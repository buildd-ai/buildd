/**
 * An approved Living Spec becomes findable in recall and joins the knowledge
 * graph, against real Postgres: one approved text per spec (a new approval
 * replaces the old chunks), drafts never indexed, edges only from the spec's
 * own parent / repo refs / prior approval, rebuilt on each approval, and an
 * indexing failure never undoes the approval.
 */
import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { assertDbConfigured, q, seedWorkspace } from './harness';

process.env.AUTH_SECRET ||= 'spec-knowledge-test-secret';
delete process.env.VOYAGE_API_KEY; // lexical-only store: no network

const { createSpecDraft, reviseSpecDraft } = await import('../../src/lib/specs/store');
const { approveSpecRevision } = await import('../../src/lib/specs/approval');
const { specKnowledgeDeps } = await import('../../src/lib/specs/knowledge');
const { PgVectorStore, buildNamespace } = await import('@buildd/core/knowledge-store');

const rand = () => Math.random().toString(36).slice(2, 10);
let teamId: string; let ws: string; let admin: string; let member: string;
beforeAll(async () => {
  assertDbConfigured();
  ({ teamId, workspaceId: ws } = await seedWorkspace());
  await q(sql`UPDATE workspaces SET access_mode = 'open' WHERE id = ${ws}::uuid`);
  const mk = async (role: string) => {
    const [u] = await q<{ id: string }>(sql`INSERT INTO users (email) VALUES (${`u-${rand()}@example.test`}) RETURNING id`);
    await q(sql`INSERT INTO team_members (team_id, user_id, role) VALUES (${teamId}::uuid, ${u.id}::uuid, ${role})`);
    return u.id;
  };
  admin = await mk('admin');
  member = await mk('member');
});

const realDeps = { ...specKnowledgeDeps };
afterEach(() => Object.assign(specKnowledgeDeps, realDeps));

const user = (userId: string) => ({ kind: 'user' as const, userId });
const ns = () => buildNamespace(ws, 'spec');
const REF_A = { path: 'docs/specs/bug-intake-and-quality.md', commitSha: 'a'.repeat(40) };
const REF_B = { path: 'docs/specs/failure-incident-recovery.md', commitSha: 'b'.repeat(40) };

async function draft(title: string, body: string, parentSpecId?: string) {
  const r = await createSpecDraft(user(member), { workspaceId: ws, title, body, parentSpecId });
  if (!r.ok) throw new Error(r.error);
  return r.spec;
}
/** Repo refs are checked against GitHub on write; set them directly to stay offline. */
const setRefs = (specId: string, revision: number, refs: unknown[]) =>
  q(sql`UPDATE spec_revisions SET repo_refs = ${JSON.stringify(refs)}::jsonb WHERE spec_id = ${specId}::uuid AND revision = ${revision}`);
async function approve(specId: string) {
  const [s] = await q<{ version: number; head_revision: number }>(sql`SELECT version, head_revision FROM specs WHERE id = ${specId}::uuid`);
  const r = await approveSpecRevision(user(admin), specId, { revision: s.head_revision, expectedVersion: s.version });
  if (!r.ok || 'pending' in r) throw new Error(JSON.stringify(r));
  return r;
}
const chunks = (specId: string) => q<{ source_id: string; content: string; source_path: string | null; metadata: any }>(sql`
  SELECT source_id, content, source_path, metadata FROM knowledge_chunks
  WHERE namespace = ${ns()} AND starts_with(source_id, ${`living-spec:${specId}#`}) ORDER BY source_id`);
const edges = (specId: string) => q<{ edge: string }>(sql`
  SELECT f.kind || ':' || f.key || ' -' || e.type || '-> ' || t.kind || ':' || t.key AS edge
  FROM knowledge_edges e JOIN knowledge_entities f ON f.id = e.from_entity_id JOIN knowledge_entities t ON t.id = e.to_entity_id
  WHERE e.workspace_id = ${ws} AND ((f.kind = 'spec' AND f.key = ${specId}) OR (f.kind = 'spec_revision' AND starts_with(f.key, ${`${specId}@`})))
  ORDER BY 1`).then(rows => rows.map(r => r.edge));

describe('approval indexes the approved text', () => {
  test('a draft is not indexed; approval writes its chunks with the approved hash; recall finds it by title', async () => {
    const title = `Bug Intake ${rand()}`;
    const spec = await draft(title, `# ${title}\n\nEvery defect report lands as one report on one incident.\n`);
    expect(await chunks(spec.id)).toEqual([]);

    const r = await approve(spec.id);
    const rows = await chunks(spec.id);
    expect(rows.length).toBe(1);
    expect(rows[0].source_path).toBeNull();
    expect(rows[0].metadata).toMatchObject({ specId: spec.id, revision: 1, contentHash: r.revision.contentHash, workspaceId: ws });

    const hits = await new PgVectorStore(null).query(ns(), { text: 'defect report incident', mode: 'lexical', useGraph: false, trackHits: false });
    expect(hits.some(h => h.id === rows[0].source_id)).toBe(true);
  });

  test('revising an approved spec leaves the approved text in recall; approving N+1 replaces it', async () => {
    const spec = await draft(`Rates ${rand()}`, '# Rates\n\nR-1: Totals are in the shopper currency.\n');
    await approve(spec.id);
    const [s] = await q<{ version: number }>(sql`SELECT version FROM specs WHERE id = ${spec.id}::uuid`);
    const rv = await reviseSpecDraft(user(member), spec.id, { expectedVersion: s.version, body: '# Rates\n\nR-1: Totals are in the shopper currency.\nR-2: Rates are cached for 15 minutes.\n' });
    if (!rv.ok) throw new Error(rv.error);
    let rows = await chunks(spec.id);
    expect(rows.map(c => c.metadata.revision)).toEqual([1]);
    expect(rows.some(c => c.content.includes('R-2'))).toBe(false);

    await approve(spec.id);
    rows = await chunks(spec.id);
    expect(rows.length).toBe(1);
    expect(rows[0].metadata.revision).toBe(2);
    expect(rows[0].content).toContain('R-2: Rates are cached');
  });
});

describe('approval projects the explicit references into the graph', () => {
  test('parent + two repo refs, then re-approved with one ref removed', async () => {
    const parent = await draft(`Quality ${rand()}`, '# Quality\n\nThe parent.\n');
    const child = await draft(`Intake ${rand()}`, '# Intake\n\nThe child.\n', parent.id);
    await setRefs(child.id, 1, [REF_A, REF_B]);
    await approve(child.id);
    expect(await edges(child.id)).toEqual([
      `spec:${child.id} -part_of-> spec:${parent.id}`,
      `spec_revision:${child.id}@1 -references_doc-> file:${REF_A.path}`,
      `spec_revision:${child.id}@1 -references_doc-> file:${REF_B.path}`,
    ]);
    // The chunk is linked to the spec, so a graph query can walk from it.
    const [link] = await q<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM chunk_entities ce JOIN knowledge_entities e ON e.id = ce.entity_id
      WHERE ce.namespace = ${ns()} AND starts_with(ce.chunk_source_id, ${`living-spec:${child.id}#`}) AND e.kind = 'spec' AND e.key = ${child.id}`);
    expect(link.n).toBe(1);

    const [s] = await q<{ version: number }>(sql`SELECT version FROM specs WHERE id = ${child.id}::uuid`);
    const rv = await reviseSpecDraft(user(member), child.id, { expectedVersion: s.version, body: '# Intake\n\nThe child, revised.\n' });
    if (!rv.ok) throw new Error(rv.error);
    await setRefs(child.id, 2, [REF_A]);
    await approve(child.id);
    expect(await edges(child.id)).toEqual([
      `spec:${child.id} -part_of-> spec:${parent.id}`,
      `spec_revision:${child.id}@2 -references_doc-> file:${REF_A.path}`,
      `spec_revision:${child.id}@2 -supersedes-> spec_revision:${child.id}@1`,
    ]);
  });
});

describe('fail-open', () => {
  test('a throwing store and graph writer never undo the approval', async () => {
    specKnowledgeDeps.store = async () => { throw new Error('store down'); };
    specKnowledgeDeps.writeGraph = async () => { throw new Error('graph down'); };
    const spec = await draft(`Down ${rand()}`, '# Down\n\nStill approved.\n');
    const r = await approve(spec.id);
    expect([r.spec.status, r.spec.approvedRevision]).toEqual(['approved', 1]);
    expect(await chunks(spec.id)).toEqual([]);
  });
});
