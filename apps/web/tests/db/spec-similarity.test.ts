/**
 * Spec similarity and duplicates read the knowledge store's spec corpus,
 * criterion by criterion ("Related specs" R-101, R-102; "Duplicates" R-104 to
 * R-106), against real Postgres with a deterministic offline embedder:
 * `similar` and `recall scope=spec` rank from the same chunks and the
 * neighbour code makes no embedding call (AC-138); a criterion match is the
 * reason (AC-139); the duplicate shortlist names the matched pair (AC-141); a
 * revise warns (AC-142); drafts compare with each other and stay out of
 * default recall (AC-143). The decision model is stubbed.
 */
import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { assertDbConfigured, q, seedWorkspace } from './harness';
import { bowEmbedder } from './bow-embedder';

process.env.AUTH_SECRET ||= 'spec-similarity-test-secret';
delete process.env.VOYAGE_API_KEY; // the store's own model would need a key: the test embedder stands in

const { createSpecDraft, reviseSpecDraft } = await import('../../src/lib/specs/store');
const { approveSpecRevision, specApprovalDeps } = await import('../../src/lib/specs/approval');
const { specKnowledgeDeps } = await import('../../src/lib/specs/knowledge');
const { computeSpecNeighbours, readSpecNeighbours } = await import('../../src/lib/specs/neighbours');
const { PgVectorStore, buildNamespace } = await import('@buildd/core/knowledge-store');
const { handleRecallAction } = await import('@buildd/core/mcp-tools');

const rand = () => Math.random().toString(36).slice(2, 8);
const embedder = bowEmbedder();
const store = new PgVectorStore(embedder);

let teamId: string; let ws: string; let admin: string;
const scheduled: Array<() => Promise<unknown>> = [];
const realDeps = { ...specKnowledgeDeps };
beforeAll(async () => {
  assertDbConfigured();
  ({ teamId, workspaceId: ws } = await seedWorkspace());
  const [u] = await q<{ id: string }>(sql`INSERT INTO users (email) VALUES (${`u-${rand()}@example.test`}) RETURNING id`);
  await q(sql`INSERT INTO team_members (team_id, user_id, role) VALUES (${teamId}::uuid, ${u.id}::uuid, 'admin')`);
  admin = u.id;
});
const useCorpus = () => {
  specKnowledgeDeps.store = async () => store;
  // The draft index runs after the response; here it is collected and awaited.
  specKnowledgeDeps.afterResponse = (t) => { scheduled.push(t); };
};
afterEach(() => Object.assign(specKnowledgeDeps, realDeps));
const flush = async () => { while (scheduled.length) await scheduled.shift()!(); };

const user = () => ({ kind: 'user' as const, userId: admin });
const ns = () => buildNamespace(ws, 'spec');
const judging = (decision: string, confidence: number) => ({
  judge: async () => ({ response: { decision, confidence, source: 'model', fallbackCause: null } as any, recordId: null }),
});

async function draft(title: string, body: string, duplicates: any = false) {
  const r = await createSpecDraft(user(), { workspaceId: ws, title, body }, { duplicates });
  if (!r.ok) throw new Error(r.error);
  await flush();
  return r;
}
async function approve(specId: string) {
  const [s] = await q<{ version: number; head_revision: number }>(sql`SELECT version, head_revision FROM specs WHERE id = ${specId}::uuid`);
  const jobs: Array<() => Promise<unknown>> = [];
  const real = specApprovalDeps.afterResponse;
  specApprovalDeps.afterResponse = (t) => { jobs.push(t); };
  try {
    const r = await approveSpecRevision(user(), specId, { revision: s.head_revision, expectedVersion: s.version });
    if (!r.ok || 'pending' in r) throw new Error(JSON.stringify(r));
    for (const t of jobs) await t();
  } finally {
    specApprovalDeps.afterResponse = real;
  }
  await flush();
}

const CART = '# Shopping cart\n\nThe cart page for shoppers.\n\n## Totals\n\n- **R-1** The cart total is shown in the shopper currency.\n- **AC-3** GIVEN an empty cart THEN the page shows the empty cart message.\n';
const CHECKOUT = '# Checkout\n\nPaying for an order.\n\n## Display\n\n- **R-7** GIVEN an empty cart THEN the page shows the empty cart message.\n- **R-8** Shipping is calculated at checkout.\n';
const SIGN_IN = '# Sign in\n\n- **R-1** A wrong password keeps the email address.\n';

describe('related specs read the spec corpus (R-101, R-102)', () => {
  test('AC-138, AC-139: similar and recall scope=spec rank the second spec from the same chunks; no embedding by the neighbour code; the criterion pair is the reason', async () => {
    useCorpus();
    const cart = (await draft(`Shopping cart`, CART)).spec;
    const checkout = (await draft(`Checkout ${rand()}`, CHECKOUT)).spec;
    const signIn = (await draft(`Sign in ${rand()}`, SIGN_IN)).spec;
    for (const s of [cart, checkout, signIn]) await approve(s.id);

    const before = embedder.calls;
    const nb = await computeSpecNeighbours(cart.id, CART);
    expect(nb.errors).toEqual([]);
    expect(embedder.calls).toBe(before);

    const [row] = await q<{ neighbor_spec_id: string; source: string; detail: any }>(sql`
      SELECT neighbor_spec_id, source, detail FROM spec_neighbors WHERE spec_id = ${cart.id}::uuid AND kind = 'similar'`);
    expect(row).toMatchObject({ neighbor_spec_id: checkout.id, source: 'vector', detail: { pair: { here: 'AC-3', there: 'R-7' } } });
    const similarChunks: string[] = row!.detail.chunks;
    expect(similarChunks.length).toBeGreaterThan(0);

    // recall scope=spec with the first spec's title, through the same store.
    const returned: string[] = [];
    const recording = { ...store, query: async (n: string, p: any) => { const r = await store.query(n, p); returned.push(...r.map((x) => x.id)); return r; } } as any;
    const res: any = await handleRecallAction({ batch: async () => ({ memories: [] }) } as any, { query: 'Shopping cart', scope: 'spec' }, { workspaceId: ws, teamId, project: 'p', knowledgeStore: recording, embedder } as any);
    expect(res.isError).toBeFalsy();
    expect(returned.some((id) => similarChunks.includes(id))).toBe(true);

    // AC-139: the neighbour reads with the criterion pair, both ways round.
    expect((await readSpecNeighbours(cart.id)).find((n) => n.specId === checkout.id)).toMatchObject({ kind: 'similar', reason: 'AC-3 here reads like R-7 there' });
    expect((await readSpecNeighbours(checkout.id)).find((n) => n.specId === cart.id)?.reason).toBe('R-7 here reads like AC-3 there');
  });
});

describe('duplicates read the spec corpus (R-104 to R-106)', () => {
  test('AC-141: the shortlist names the approved spec with the matched pair', async () => {
    useCorpus();
    const cart = (await draft(`Cart ${rand()}`, CART)).spec;
    await approve(cart.id);
    const reworded = '# Basket view\n\n## Rules\n\n- **R-2** GIVEN an empty basket THEN the screen shows the empty basket notice.\n';
    const r = await createSpecDraft(user(), { workspaceId: ws, title: 'Basket view', body: reworded }, { duplicates: judging('overlap', 0.8) });
    if (!r.ok) throw new Error(r.error);
    const hit = r.duplicateCheck && r.duplicateCheck.ran ? r.duplicateCheck.warnings.find((w) => w.specId === cart.id) : undefined;
    expect(hit).toMatchObject({ relation: 'overlap' });
    expect(hit!.pairs?.[0]).toEqual({ here: 'R-2', there: 'AC-3' });
  });

  test('AC-142: a revise that adds a criterion another spec has warns naming both, and the revision is written', async () => {
    useCorpus();
    const checkout = (await draft(`Checkout ${rand()}`, CHECKOUT)).spec;
    await approve(checkout.id);
    const mine = (await draft(`Payments ${rand()}`, '# Payments\n\n- **R-1** Cards are charged once.\n')).spec;
    const body = '# Payments\n\n- **R-1** Cards are charged once.\n- **R-2** Shipping is calculated at checkout.\n';
    const rv = await reviseSpecDraft(user(), mine.id, { expectedVersion: mine.version, body }, { duplicates: judging('duplicate', 0.97) });
    if (!rv.ok) throw new Error(rv.error);
    expect(rv.revision.revision).toBe(2);
    // Warnings only: the spec already exists, so even a clear duplicate does not refuse.
    expect(rv.duplicateCheck).toMatchObject({ ran: true, blocking: [] });
    const w = rv.duplicateCheck && rv.duplicateCheck.ran ? rv.duplicateCheck.warnings.find((x) => x.specId === checkout.id) : undefined;
    expect(w).toMatchObject({ relation: 'duplicate', pairs: [{ here: 'R-2', there: 'R-8' }] });
    // Only the added criterion was checked: R-1 matched nothing and is not a pair.
    expect(rv.duplicateCheck && rv.duplicateCheck.ran ? rv.duplicateCheck.warnings.flatMap((x) => x.pairs ?? []).every((p) => p.here === 'R-2') : false).toBe(true);
  });

  test('AC-143: two drafts of the same idea: the second warns naming the first; default recall returns neither', async () => {
    useCorpus();
    const idea = `Gift wrap ${rand()}`;
    const first = (await draft(idea, '# Gift wrap\n\n- **R-1** A shopper can add gift wrapping to any order line.\n')).spec;
    const [chunk] = await q<{ n: number }>(sql`SELECT count(*)::int AS n FROM knowledge_chunks WHERE namespace = ${ns()} AND starts_with(source_id, ${`living-spec-draft:${first.id}@1#`})`);
    expect(chunk!.n).toBeGreaterThan(0);

    const second = await createSpecDraft(user(), { workspaceId: ws, title: `${idea} again`, body: '# Wrapping\n\n- **R-1** Shoppers may add gift wrapping to an order line.\n' }, { duplicates: judging('duplicate', 0.98) });
    if (!second.ok) throw new Error(second.error);
    // A draft never refuses: the match is a warning, marked draft.
    expect(second.duplicateCheck).toMatchObject({ ran: true, blocking: [] });
    expect(second.duplicateCheck && second.duplicateCheck.ran ? second.duplicateCheck.warnings.find((w) => w.specId === first.id) : undefined).toMatchObject({ draft: true, relation: 'duplicate' });
    await flush();

    const ids = (await store.query(ns(), { text: 'gift wrapping order line', mode: 'hybrid', topK: 50, useGraph: false, trackHits: false })).map((h) => h.metadata.specId);
    expect(ids).not.toContain(first.id);
    expect(ids).not.toContain(second.spec.id);
    const withDrafts = (await store.query(ns(), { text: 'gift wrapping order line', mode: 'hybrid', topK: 50, useGraph: false, trackHits: false, includeDrafts: true })).map((h) => h.metadata.specId);
    expect(withDrafts).toContain(first.id);
  });

  test('approving a draft head replaces its draft chunks with approved ones', async () => {
    useCorpus();
    const s = (await draft(`Receipts ${rand()}`, '# Receipts\n\n- **R-1** Every order gets an emailed receipt.\n')).spec;
    const count = (prefix: string) => q<{ n: number }>(sql`SELECT count(*)::int AS n FROM knowledge_chunks WHERE namespace = ${ns()} AND starts_with(source_id, ${prefix})`).then((r) => r[0]!.n);
    expect(await count(`living-spec-draft:${s.id}`)).toBeGreaterThan(0);
    await approve(s.id);
    expect(await count(`living-spec-draft:${s.id}`)).toBe(0);
    expect(await count(`living-spec:${s.id}@1#`)).toBeGreaterThan(0);
  });
});
