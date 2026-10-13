/**
 * Living Spec neighbours and derived edges (living-specs.md §14), against real
 * Postgres: specs whose pinned tasks changed the same files are neighbours
 * both ways, from the knowledge ingest's merged-PR file lists when there are
 * any; a recompute replaces a spec's rows; `overlaps` rows a writer passes in
 * read from either side; exact derived edges land in the graph under the
 * derived rule; and a neighbour failure never touches the approval.
 */
import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { assertDbConfigured, q, seedWorkspace } from './harness';

process.env.AUTH_SECRET ||= 'spec-neighbours-test-secret';
delete process.env.VOYAGE_API_KEY;

const { createSpecDraft } = await import('../../src/lib/specs/store');
const { approveSpecRevision, specApprovalDeps } = await import('../../src/lib/specs/approval');
const { pinSpecSource } = await import('../../src/lib/specs/pin');
const { specKnowledgeDeps, refreshSpecDerived } = await import('../../src/lib/specs/knowledge');
const { neighbourDeps, readSpecNeighbours, replaceSpecNeighbours, suggestParent, specFiles } = await import('../../src/lib/specs/neighbours');

const rand = () => Math.random().toString(36).slice(2, 10);
let teamId: string; let ws: string; let admin: string;
beforeAll(async () => {
  assertDbConfigured();
  ({ teamId, workspaceId: ws } = await seedWorkspace());
  const [u] = await q<{ id: string }>(sql`INSERT INTO users (email) VALUES (${`u-${rand()}@example.test`}) RETURNING id`);
  await q(sql`INSERT INTO team_members (team_id, user_id, role) VALUES (${teamId}::uuid, ${u.id}::uuid, 'admin')`);
  admin = u.id;
});

const realSimilar = neighbourDeps.similar;
const realKnowledge = { ...specKnowledgeDeps };
afterEach(() => { neighbourDeps.similar = realSimilar; Object.assign(specKnowledgeDeps, realKnowledge); });
// No embedding or recall store in these tests: chunks go nowhere, the graph is real.
const noStore = () => { specKnowledgeDeps.store = async () => ({ upsert: async () => ({ upserted: 0 } as any), deleteBySource: async () => 0 as any }); };

const user = () => ({ kind: 'user' as const, userId: admin });
const BODY = (t: string) => `# ${t}\n- AC-1: ${t} shows the empty state.\n- AC-2: ${t} lists each line.\n`;

async function approved(title: string, opts: { scope?: string; parentSpecId?: string } = {}) {
  const d = await createSpecDraft(user(), { workspaceId: ws, title: `${title} ${rand()}`, body: BODY(title), scope: opts.scope, parentSpecId: opts.parentSpecId });
  if (!d.ok) throw new Error(d.error);
  const scheduled: Array<() => Promise<unknown>> = [];
  const real = specApprovalDeps.afterResponse;
  specApprovalDeps.afterResponse = (t) => { scheduled.push(t); };
  try {
    const a = await approveSpecRevision(user(), d.spec.id, { revision: 1, expectedVersion: 1 });
    if (!a.ok || 'pending' in a) throw new Error(JSON.stringify(a));
    for (const t of scheduled) await t();
  } finally {
    specApprovalDeps.afterResponse = real;
  }
  return d.spec;
}

/** A completed task pinned to the spec, optionally scoped, with a merged PR. */
async function pinnedTask(specId: string, opts: { manifest?: string[]; pr?: number; criteria?: string[] } = {}) {
  const pinned = await pinSpecSource(ws, { specSource: { specId, ...(opts.criteria ? { criteria: opts.criteria } : {}) } });
  if (!pinned.ok) throw new Error(pinned.error);
  const [t] = await q<{ id: string }>(sql`INSERT INTO tasks (workspace_id, title, status, context, path_manifest)
    VALUES (${ws}::uuid, ${`build ${rand()}`}, 'completed', ${JSON.stringify(pinned.context)}::jsonb, ${JSON.stringify(opts.manifest ?? [])}::jsonb) RETURNING id`);
  if (opts.pr) {
    await q(sql`INSERT INTO workers (workspace_id, task_id, name, runner, branch, status, pr_number, merged_at)
      VALUES (${ws}::uuid, ${t.id}::uuid, 'w', 'test', ${`b-${rand()}`}, 'completed', ${opts.pr}, now())`);
  }
  return t.id;
}
const ingestJob = (pr: number, files: string[]) => q(sql`INSERT INTO knowledge_ingest_jobs (workspace_id, repo, trigger, pr_number, scope, status, changed_files)
  VALUES (${ws}::uuid, 'acme/shop', 'pr_merged', ${pr}, 'diff', 'done', ${JSON.stringify(files)}::jsonb)`);

const rows = (specId: string) => q<{ neighbor_spec_id: string; kind: string; source: string; score: number; detail: any }>(sql`
  SELECT neighbor_spec_id, kind, source, score, detail FROM spec_neighbors WHERE spec_id = ${specId}::uuid ORDER BY kind, neighbor_spec_id`);
const derivedEdges = (specId: string) => q<{ rule: string; type: string; from_key: string; to_key: string }>(sql`
  SELECT e.rule, e.type, f.key AS from_key, t.key AS to_key FROM knowledge_edges e
  JOIN knowledge_entities f ON f.id = e.from_entity_id JOIN knowledge_entities t ON t.id = e.to_entity_id
  WHERE e.workspace_id = ${ws} AND starts_with(e.rule, 'living_spec:derived:') AND (f.key = ${specId} OR starts_with(f.key, ${`${specId}@`}))
  ORDER BY e.rule, f.key, t.key`);

describe('neighbours (§14)', () => {
  test('shares_files from merged PR files, both ways, and a recompute replaces the rows', async () => {
    noStore();
    neighbourDeps.similar = async () => [];
    const pr1 = 9000 + Math.floor(Math.random() * 900);
    const a0 = await createSpecDraft(user(), { workspaceId: ws, title: `Cart ${rand()}`, body: BODY('Cart') });
    if (!a0.ok) throw new Error(a0.error);
    // Approve A, pin a task to it with a merged PR, then approve B sharing a file.
    const scheduled: Array<() => Promise<unknown>> = [];
    const real = specApprovalDeps.afterResponse; specApprovalDeps.afterResponse = (t) => { scheduled.push(t); };
    await approveSpecRevision(user(), a0.spec.id, { revision: 1, expectedVersion: 1 });
    specApprovalDeps.afterResponse = real;
    for (const t of scheduled) await t();
    await pinnedTask(a0.spec.id, { pr: pr1, manifest: ['src/ignored-by-pr-files.ts'] });
    await ingestJob(pr1, ['src/cart.ts', 'src/total.ts']);
    expect(await specFiles(ws, a0.spec.id)).toEqual({ files: ['src/cart.ts', 'src/total.ts'], source: 'pr_files' });

    const b = await approved('Refunds');
    await pinnedTask(b.id, { manifest: ['src/cart.ts', 'src/refund.ts', 'src/**'] });
    await refreshSpecDerived(b.id);
    expect((await rows(b.id)).map((r) => [r.neighbor_spec_id, r.kind, r.source, r.detail])).toEqual([
      [a0.spec.id, 'shares_files', 'path_manifest', { files: 1, sample: ['src/cart.ts'] }],
    ]);
    // Read from A's side too, though A's rows were computed before B existed.
    expect((await readSpecNeighbours(a0.spec.id)).map((n) => [n.specId, n.kind, n.reason])).toEqual([[b.id, 'shares_files', "Changes a file this spec's work changed"]]);

    // A recompute replaces, never adds: B's work stops touching the shared file.
    await q(sql`UPDATE tasks SET path_manifest = '["src/refund.ts"]'::jsonb WHERE context->'specSource'->>'specId' = ${b.id}`);
    await refreshSpecDerived(b.id);
    expect(await rows(b.id)).toEqual([]);
  });

  test('similar keeps its own floor and skips the spec\'s parent; overlaps passed in read from either side', async () => {
    noStore();
    const product = await approved('Shop', { scope: 'product' });
    const x = await approved('Totals', { parentSpecId: product.id });
    const y = await approved('Tax');
    neighbourDeps.similar = async () => [
      { specId: product.id, score: 0.95, source: 'vector' },
      { specId: y.id, score: 0.8, source: 'vector' },
    ];
    await refreshSpecDerived(x.id);
    expect((await rows(x.id)).map((r) => [r.neighbor_spec_id, r.kind, r.source])).toEqual([[y.id, 'similar', 'vector']]);

    await replaceSpecNeighbours(ws, y.id, 'overlaps', [{ neighborSpecId: x.id, score: 0.97, source: 'jev', detail: { pairs: [{ here: 'AC-1', there: 'AC-2' }] } }]);
    const fromX = await readSpecNeighbours(x.id);
    // overlaps outranks similar, and its criteria read the right way round from X's side.
    expect(fromX.map((n) => [n.specId, n.kind, n.reason])).toEqual([[y.id, 'overlaps', 'AC-2 here matches AC-1 there']]);
    expect((await readSpecNeighbours(y.id))[0]).toMatchObject({ specId: x.id, kind: 'overlaps', reason: 'AC-1 here matches AC-2 there' });
    // A neighbour recompute never touches overlaps.
    await refreshSpecDerived(y.id);
    expect((await rows(y.id)).some((r) => r.kind === 'overlaps')).toBe(true);
  });

  test('a parent is suggested from the closest product, else from where the closest spec sits', async () => {
    const product = await approved('Billing', { scope: 'product' });
    const child = await approved('Invoices', { parentSpecId: product.id });
    neighbourDeps.similar = async () => [{ specId: product.id, score: 0.7, source: 'vector' }];
    expect(await suggestParent(ws, 'new', 'invoices')).toMatchObject({ specId: product.id, reason: 'Closest product by what it asks for' });
    neighbourDeps.similar = async () => [{ specId: child.id, score: 0.9, source: 'vector' }];
    expect(await suggestParent(ws, 'new', 'invoices')).toMatchObject({ specId: product.id });
    neighbourDeps.similar = async () => [{ specId: child.id, score: 0.2, source: 'vector' }];
    expect(await suggestParent(ws, 'new', 'invoices')).toBeNull();
  });
});

describe('exact derived edges (§14)', () => {
  test('criteria, the scoped task answering and passing one, files and the design, under the derived rule', async () => {
    noStore();
    neighbourDeps.similar = async () => [];
    const [art] = await q<{ id: string }>(sql`INSERT INTO artifacts (workspace_id, type, title, content) VALUES (${ws}::uuid, 'content', 'proto', '<main/>') RETURNING id`);
    const d = await createSpecDraft(user(), { workspaceId: ws, title: `Checkout ${rand()}`, body: BODY('Checkout'), design: { kind: 'artifact', ref: art.id } });
    if (!d.ok) throw new Error(d.error);
    await approveSpecRevision(user(), d.spec.id, { revision: 1, expectedVersion: 1 });
    const taskId = await pinnedTask(d.spec.id, { manifest: ['src/checkout.ts'], criteria: ['AC-2'] });
    const [rev] = await q<{ id: string }>(sql`SELECT id FROM spec_revisions WHERE spec_id = ${d.spec.id}::uuid AND revision = 1`);
    await q(sql`INSERT INTO spec_outcome_verdicts (workspace_id, task_id, spec_revision_id, criterion_id, verdict, head_sha, evidence)
      VALUES (${ws}::uuid, ${taskId}::uuid, ${rev.id}::uuid, 'AC-2', 'pass', ${'c'.repeat(40)}, '{}'::jsonb)`);
    const r = await refreshSpecDerived(d.spec.id);
    expect(r.errors).toEqual([]);
    const e = (await derivedEdges(d.spec.id)).map((x) => `${x.rule.replace('living_spec:derived:', '')} ${x.type} ${x.from_key.replace(d.spec.id, 'S')} -> ${x.to_key.replace(d.spec.id, 'S').replace(taskId, 'T').replace(art.id, 'ART')}`);
    expect(e).toEqual([
      'answers_for relates_to S@1#AC-2 -> T',
      'built_to references S@1 -> ART',
      'criterion part_of S@1#AC-1 -> S@1',
      'criterion part_of S@1#AC-2 -> S@1',
      'implemented_in:path_manifest references S -> src/checkout.ts',
      'verified outcome_of S@1#AC-2 -> T',
    ]);
    // Rebuilt whole: a second refresh writes the same set, not twice.
    await refreshSpecDerived(d.spec.id);
    expect((await derivedEdges(d.spec.id)).length).toBe(e.length);
  });

  test('a failing neighbour writer never fails the approval or moves a pin', async () => {
    noStore();
    neighbourDeps.similar = async () => { throw new Error('embedder down'); };
    const s = await approved('Payments');
    const [row] = await q<{ approved_revision: number }>(sql`SELECT approved_revision FROM specs WHERE id = ${s.id}::uuid`);
    expect(row.approved_revision).toBe(1);
    const pinned = await pinSpecSource(ws, { specSource: { specId: s.id } });
    expect(pinned.ok && (pinned.context as any).specSource.revision).toBe(1);
  });
});
