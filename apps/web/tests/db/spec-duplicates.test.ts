/**
 * Spec duplicates on create (Living Specs §13), against real Postgres: the
 * shortlist reads the workspace's approved specs, a clear duplicate is refused
 * with nothing written, an override creates it, an overlap warns, and with no
 * decision model the spec is created with a note. The model is stubbed.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { assertDbConfigured, q, seedWorkspace } from './harness';

const { createSpecDraft } = await import('../../src/lib/specs/store');
const { approveSpecRevision } = await import('../../src/lib/specs/approval');

const rand = () => Math.random().toString(36).slice(2, 10);
const CART = '# Cart\nThe cart page.\n- **AC-1** An empty cart shows the empty state.\n- **AC-2** Totals are in the shopper currency.\n';
const BASKET = '# Basket\nThe basket page.\n- **AC-1** No items: show the empty basket message.\n- **AC-2** Prices in the buyer currency.\n';

let wsA: string; let admin: string; let cartId: string;
beforeAll(async () => {
  assertDbConfigured();
  const seeded = await seedWorkspace();
  wsA = seeded.workspaceId;
  const [u] = await q<{ id: string }>(sql`INSERT INTO users (email) VALUES (${`u-${rand()}@example.test`}) RETURNING id`);
  await q(sql`INSERT INTO team_members (team_id, user_id, role) VALUES (${seeded.teamId}::uuid, ${u.id}::uuid, 'admin')`);
  admin = u.id;
  const d = await createSpecDraft(user(), { workspaceId: wsA, title: 'Cart', body: CART }, { duplicates: false });
  if (!d.ok) throw new Error(d.error);
  const a = await approveSpecRevision(user(), d.spec.id, { revision: 1, expectedVersion: 1 });
  if (!a.ok) throw new Error(a.error);
  cartId = d.spec.id;
});
const user = () => ({ kind: 'user' as const, userId: admin });
const judging = (decision: string, confidence: number) => ({
  judge: async () => ({ response: { decision, confidence, source: 'model', fallbackCause: null } as any, recordId: null }),
});
const count = async () => (await q<{ n: number }>(sql`SELECT count(*)::int AS n FROM specs WHERE workspace_id = ${wsA}::uuid`))[0]!.n;

describe('creating a spec checks it against the approved ones', () => {
  test('a clear duplicate is refused, naming the spec, and nothing is written', async () => {
    const before = await count();
    const r = await createSpecDraft(user(), { workspaceId: wsA, title: 'Basket', body: BASKET }, { duplicates: judging('duplicate', 0.97) });
    expect(r).toMatchObject({ ok: false, status: 409, code: 'spec_duplicate', duplicates: [{ specId: cartId, title: 'Cart', relation: 'duplicate' }] });
    expect(!r.ok && r.error).toContain('supersedes');
    expect(await count()).toBe(before);
  });

  test('supersedes or distinctBecause creates it; a supersedes outside the workspace is refused', async () => {
    const s = await createSpecDraft(user(), { workspaceId: wsA, title: `Basket ${rand()}`, body: BASKET, supersedes: cartId }, { duplicates: judging('duplicate', 0.97) });
    expect(s.ok).toBe(true);
    const d = await createSpecDraft(user(), { workspaceId: wsA, title: `Basket ${rand()}`, body: BASKET, distinctBecause: 'This is the B2B basket with quotes, not the shop cart.' }, { duplicates: judging('duplicate', 0.97) });
    expect(d.ok).toBe(true);
    const other = (await seedWorkspace()).workspaceId;
    const [foreign] = await q<{ id: string }>(sql`INSERT INTO artifacts (workspace_id, type, title, content) VALUES (${other}::uuid, 'content', 'x', 'x') RETURNING id`);
    const [fs] = await q<{ id: string }>(sql`INSERT INTO specs (workspace_id, title, scope, body_artifact_id, created_by) VALUES (${other}::uuid, 'Elsewhere', 'feature', ${foreign.id}::uuid, 'test') RETURNING id`);
    expect(await createSpecDraft(user(), { workspaceId: wsA, title: 'x', body: BASKET, supersedes: fs.id }, { duplicates: judging('duplicate', 0.97) })).toMatchObject({ ok: false, status: 400 });
  });

  test('an overlap is created with a warning; with no decision model it is created with a note', async () => {
    const o = await createSpecDraft(user(), { workspaceId: wsA, title: `Basket ${rand()}`, body: BASKET }, { duplicates: judging('overlap', 0.8) });
    expect(o).toMatchObject({ ok: true, duplicateCheck: { ran: true, blocking: [], warnings: [{ specId: cartId, relation: 'overlap' }] } });
    // The real path: no team key in the test DB, so nothing answers.
    const n = await createSpecDraft(user(), { workspaceId: wsA, title: `Basket ${rand()}`, body: BASKET });
    expect(n).toMatchObject({ ok: true, duplicateCheck: { ran: false } });
  });
});
