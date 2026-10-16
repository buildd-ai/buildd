/**
 * A spec revision's design (Living Specs §12), against real Postgres: an
 * artifact design is pinned to its revision on write; a revise that changes
 * only the design is a new revision and an omitted design carries forward;
 * approving records the design version, and the spec page says when the
 * design moved on since approval. Visual verdicts on a criterion that names
 * design screens cite a shot of the design too.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { assertDbConfigured, q, seedWorkspace } from './harness';

const { createSpecDraft, reviseSpecDraft, getSpec } = await import('../../src/lib/specs/store');
const { approveSpecRevision } = await import('../../src/lib/specs/approval');
const { specPageView } = await import('../../src/lib/specs/page-view');

const rand = () => Math.random().toString(36).slice(2, 10);
const BODY = '# Cart\n- AC-1: An empty cart shows the empty state.\n  screen: cart-empty\n';

let teamA: string; let wsA: string; let wsB: string; let admin: string;
beforeAll(async () => {
  assertDbConfigured();
  ({ teamId: teamA, workspaceId: wsA } = await seedWorkspace());
  ({ workspaceId: wsB } = await seedWorkspace());
  const [u] = await q<{ id: string }>(sql`INSERT INTO users (email) VALUES (${`u-${rand()}@example.test`}) RETURNING id`);
  await q(sql`INSERT INTO team_members (team_id, user_id, role) VALUES (${teamA}::uuid, ${u.id}::uuid, 'admin')`);
  admin = u.id;
});
const user = () => ({ kind: 'user' as const, userId: admin });

async function prototype(workspaceId = wsA) {
  const [a] = await q<{ id: string; current_revision: number }>(sql`
    INSERT INTO artifacts (workspace_id, type, title, content) VALUES (${workspaceId}::uuid, 'content', 'Cart prototype', '<main>v1</main>') RETURNING id, current_revision`);
  return a;
}
const bump = (id: string, html: string) => q(sql`UPDATE artifacts SET content = ${html}, updated_at = now() WHERE id = ${id}::uuid`);

describe('a revision carries its design', () => {
  test('an artifact design is pinned to its current revision; one in another workspace or a missing revision is refused', async () => {
    const art = await prototype();
    const d = await createSpecDraft(user(), { workspaceId: wsA, title: `Cart ${rand()}`, body: BODY, design: { kind: 'artifact', ref: art.id, screens: [{ id: 'cart-empty', name: 'Empty cart' }] } });
    if (!d.ok) throw new Error(d.error);
    expect(d.revision.design).toEqual({ kind: 'artifact', ref: art.id, version: String(art.current_revision), screens: [{ id: 'cart-empty', name: 'Empty cart' }] });

    const other = await prototype(wsB);
    expect(await createSpecDraft(user(), { workspaceId: wsA, title: 'x', body: BODY, design: { kind: 'artifact', ref: other.id } })).toMatchObject({ ok: false, status: 400 });
    expect(await createSpecDraft(user(), { workspaceId: wsA, title: 'x', body: BODY, design: { kind: 'artifact', ref: art.id, version: 99 } })).toMatchObject({ ok: false, status: 400 });
    expect(await createSpecDraft(user(), { workspaceId: wsA, title: 'x', body: BODY, design: { kind: 'url', ref: 'https://proto.test/cart' } })).toMatchObject({ ok: false, status: 400 });
  });

  test('a design-only revise is a new revision; omitted carries forward; null clears', async () => {
    const art = await prototype();
    const d = await createSpecDraft(user(), { workspaceId: wsA, title: `Cart ${rand()}`, body: BODY, design: { kind: 'artifact', ref: art.id } });
    if (!d.ok) throw new Error(d.error);
    await bump(art.id, '<main>v2</main>');
    const r2 = await reviseSpecDraft(user(), d.spec.id, { expectedVersion: d.spec.version, body: BODY, design: { kind: 'artifact', ref: art.id } });
    if (!r2.ok) throw new Error(r2.error);
    expect([r2.unchanged, r2.revision.revision, r2.revision.design?.version, r2.revision.contentHash]).toEqual([false, 2, String(art.current_revision + 1), d.revision.contentHash]);
    const r3 = await reviseSpecDraft(user(), d.spec.id, { expectedVersion: r2.spec.version, body: `${BODY}- AC-2: Totals.\n` });
    if (!r3.ok) throw new Error(r3.error);
    expect(r3.revision.design).toEqual(r2.revision.design);
    const r4 = await reviseSpecDraft(user(), d.spec.id, { expectedVersion: r3.spec.version, body: `${BODY}- AC-2: Totals.\n`, design: null });
    if (!r4.ok) throw new Error(r4.error);
    expect([r4.unchanged, r4.revision.design]).toEqual([false, null]);
    const read = await getSpec(user(), d.spec.id, { revision: 2 });
    expect(read.ok && read.view.revision.design?.version).toBe(String(art.current_revision + 1));
  });

  test('approval records the design version; the page says when the design changed since', async () => {
    const art = await prototype();
    const d = await createSpecDraft(user(), { workspaceId: wsA, title: `Cart ${rand()}`, body: BODY, design: { kind: 'artifact', ref: art.id, screens: [{ id: 'cart-empty', name: 'Empty cart' }] } });
    if (!d.ok) throw new Error(d.error);
    const a = await approveSpecRevision(user(), d.spec.id, { revision: 1, expectedVersion: 1 });
    if (!a.ok) throw new Error(a.error);
    const before = await specPageView(admin, d.spec.id);
    if (before.state !== 'ok') throw new Error('not found');
    expect(before.design).toEqual({ label: 'Cart prototype', href: `/app/artifacts/${art.id}`, version: String(art.current_revision), screens: ['Empty cart'], changedSince: null });
    await bump(art.id, '<main>v2, redesigned</main>');
    const after = await specPageView(admin, d.spec.id);
    if (after.state !== 'ok') throw new Error('not found');
    expect(after.design?.changedSince).toEqual({ pinned: String(art.current_revision), current: String(art.current_revision + 1) });
    // The approved revision still names the version it was approved with.
    const [rev] = await q<{ design: any }>(sql`SELECT design FROM spec_revisions WHERE spec_id = ${d.spec.id}::uuid AND revision = 1`);
    expect(rev.design.version).toBe(String(art.current_revision));
  });
});
