/**
 * Acceptance checks for Living Spec fc80b5a4 "Living Specs: finding and
 * organising specs", revision 6, R-105 and R-106 (AC-142, AC-143), against real
 * Postgres. Written before the build: each test fails on the starting commit
 * and passes once it is built. A check named here is listed in the spec's
 * metadata `verified_by`, keyed by its id.
 *
 * Seams used: the knowledge store behind `specKnowledgeDeps.store()` (an
 * in-memory fake that keeps what is upserted and answers a query with the
 * chunks it holds), the decision stubbed through `opts.duplicates` the way
 * spec-duplicates.test.ts does, and the same `opts.duplicates` on
 * `reviseSpecDraft`, whose reply carries `duplicateCheck` as create's does.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { assertDbConfigured, q, seedWorkspace } from './harness';

const { createSpecDraft, reviseSpecDraft } = await import('../../src/lib/specs/store');
const { approveSpecRevision } = await import('../../src/lib/specs/approval');
const knowledge = await import('../../src/lib/specs/knowledge');

const rand = () => Math.random().toString(36).slice(2, 10);

type Held = { id: string; content: string; metadata: Record<string, unknown> };
function memoryStore() {
  const held: Held[] = [];
  return {
    held,
    store: {
      upsert: async (_ns: string, chunks: Array<{ id: string; content: string; metadata?: Record<string, unknown> }>) => {
        for (const c of chunks) { const i = held.findIndex((h) => h.id === c.id); const row = { id: c.id, content: c.content, metadata: c.metadata ?? {} }; if (i >= 0) held[i] = row; else held.push(row); }
      },
      deleteBySource: async () => undefined,
      delete: async () => undefined,
      listNamespaces: async () => [],
      query: async (namespace: string, params: { text: string }) => {
        const words = new Set(params.text.toLowerCase().match(/[a-z]{4,}/g) ?? []);
        return held
          .map((h) => ({ h, hit: (h.content.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter((w) => words.has(w)).length }))
          .filter((x) => x.hit > 0)
          .map(({ h, hit }) => ({ id: h.id, namespace, corpus: 'spec', sourceType: 'living_spec', sourcePath: null, sourceUrl: null, content: h.content, metadata: h.metadata, score: Math.min(1, hit / 5), scoreBreakdown: { dense: Math.min(1, hit / 5) } }));
      },
    },
  };
}

const realStore = knowledge.specKnowledgeDeps.store;
afterAll(() => { knowledge.specKnowledgeDeps.store = realStore; });

let wsA: string; let admin: string;
beforeAll(async () => {
  assertDbConfigured();
  const seeded = await seedWorkspace();
  wsA = seeded.workspaceId;
  const [u] = await q<{ id: string }>(sql`INSERT INTO users (email) VALUES (${`u-${rand()}@example.test`}) RETURNING id`);
  await q(sql`INSERT INTO team_members (team_id, user_id, role) VALUES (${seeded.teamId}::uuid, ${u.id}::uuid, 'admin')`);
  admin = u.id;
});
const user = () => ({ kind: 'user' as const, userId: admin });
const judging = (decision: string, confidence: number) => ({
  teamOf: async () => 'team',
  judge: async () => ({ response: { decision, confidence, source: 'model', fallbackCause: null } as any, recordId: null }),
});

describe('R-105: a revise is checked too', () => {
  test('AC-142: a revise that adds a criterion another spec already has warns naming both criteria, and the revision is written', async () => {
    const mem = memoryStore();
    knowledge.specKnowledgeDeps.store = async () => mem.store as never;
    const other = await createSpecDraft(user(), { workspaceId: wsA, title: `Basket ${rand()}`, body: '# Basket\n\n- AC-4: An empty basket shows a friendly message.\n' }, { duplicates: false });
    if (!other.ok) throw new Error(other.error);
    const approved = await approveSpecRevision(user(), other.spec.id, { revision: 1, expectedVersion: 1 });
    if (!approved.ok) throw new Error(approved.error);
    await knowledge.indexApprovedSpec(other.spec.id);

    const mine = await createSpecDraft(user(), { workspaceId: wsA, title: `Cart ${rand()}`, body: '# Cart\n\n- R-1: Prices show two decimals.\n' }, { duplicates: false });
    if (!mine.ok) throw new Error(mine.error);
    const r = await reviseSpecDraft(user(), mine.spec.id, {
      expectedVersion: mine.spec.version, changeSummary: 'R-2: empty message',
      body: '# Cart\n\n- R-1: Prices show two decimals.\n- R-2: An empty basket shows a friendly message.\n',
    }, { duplicates: judging('overlap', 0.8) } as never);
    expect(r.ok).toBe(true);
    const warnings = JSON.stringify((r as { duplicateCheck?: { warnings?: unknown } }).duplicateCheck?.warnings ?? null);
    expect(warnings).toContain(other.spec.id);
    expect(warnings).toContain('AC-4');
    expect(warnings).toContain('R-2');
    const [row] = await q<{ head_revision: number }>(sql`SELECT head_revision FROM specs WHERE id = ${mine.spec.id}::uuid`);
    expect(row!.head_revision).toBe(2);
  });

  test('R-105: a revise never refuses, even for a clear duplicate', async () => {
    const mem = memoryStore();
    knowledge.specKnowledgeDeps.store = async () => mem.store as never;
    const mine = await createSpecDraft(user(), { workspaceId: wsA, title: `Cart ${rand()}`, body: '# Cart\n\n- R-1: Prices show two decimals.\n' }, { duplicates: false });
    if (!mine.ok) throw new Error(mine.error);
    const r = await reviseSpecDraft(user(), mine.spec.id, { expectedVersion: mine.spec.version, body: '# Cart\n\n- R-1: Prices show two decimals.\n- R-2: Taxes show separately.\n' }, { duplicates: judging('duplicate', 0.99) } as never);
    expect(r.ok).toBe(true);
  });
});

describe('R-106: drafts are indexed in the spec corpus, marked draft', () => {
  test('AC-143: a second draft of the same idea warns naming the first, and every draft chunk is marked draft so recall without drafts skips it', async () => {
    const mem = memoryStore();
    knowledge.specKnowledgeDeps.store = async () => mem.store as never;
    const body = '# Loyalty points\n\n- R-1: Shoppers earn loyalty points on every completed order.\n- AC-1: A refunded order removes its loyalty points.\n';
    const first = await createSpecDraft(user(), { workspaceId: wsA, title: `Loyalty ${rand()}`, body }, { duplicates: false });
    if (!first.ok) throw new Error(first.error);
    // Indexing a draft happens after the response in production; the build exposes it as part of the write.
    await new Promise((r) => setTimeout(r, 200));
    const draftChunks = mem.held.filter((h) => JSON.stringify(h.metadata).includes(first.spec.id) || h.id.includes(first.spec.id));
    expect(draftChunks.length).toBeGreaterThan(0);
    for (const c of draftChunks) expect(c.metadata.draft ?? c.metadata.isDraft ?? c.metadata.status).toMatch(/true|draft/);

    const second = await createSpecDraft(user(), { workspaceId: wsA, title: `Loyalty ${rand()}`, body: body.replace('Shoppers', 'Customers') }, { duplicates: judging('overlap', 0.8) });
    expect(second.ok).toBe(true);
    const warnings = JSON.stringify((second as { duplicateCheck?: { warnings?: unknown } }).duplicateCheck?.warnings ?? null);
    expect(warnings).toContain(first.spec.id);
  });
});
