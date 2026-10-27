/**
 * One decision on one screen (Living Spec b7fc9316 R-15, R-16, R-18, R-19),
 * against real Postgres.
 *
 * - create_draft and revise store the explanation with the revision it was
 *   written with (R-15); a revise never carries one forward.
 * - The confirm view checks it against the real change list, no model (R-16):
 *   covered, not explained, and lines naming something that did not change
 *   (AC-13 to AC-16).
 * - Once written it cannot change (AC-18): a revise that only sends another
 *   explanation is refused and writes nothing, and the column itself refuses
 *   an UPDATE, so the page keeps showing the original.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { assertDbConfigured, q, seedWorkspace } from './harness';

process.env.AUTH_SECRET ||= 'spec-revision-explanation-test-secret';

const { createSpecDraft, reviseSpecDraft } = await import('../../src/lib/specs/store');
const { approvalPinView } = await import('../../src/lib/specs/approval-view');
const { specApprovalDeps } = await import('../../src/lib/specs/approval');

const rand = () => Math.random().toString(36).slice(2, 10);
let wsA: string; let admin: string;
beforeAll(async () => {
  assertDbConfigured();
  let teamA: string;
  ({ teamId: teamA, workspaceId: wsA } = await seedWorkspace());
  await q(sql`UPDATE workspaces SET access_mode = 'open' WHERE id = ${wsA}::uuid`);
  const [u] = await q<{ id: string }>(sql`INSERT INTO users (email) VALUES (${`u-${rand()}@example.test`}) RETURNING id`);
  await q(sql`INSERT INTO team_members (team_id, user_id, role) VALUES (${teamA}::uuid, ${u.id}::uuid, 'admin')`);
  admin = u.id;
  specApprovalDeps.notify = async () => {};
});

const user = (userId: string) => ({ kind: 'user' as const, userId });
const V1 = (s: string) => [
  `# Checkout ${s}`, '', '## Context', '', 'Totals are shown before paying.', '',
  '## Requirements', '', '- R-1: Totals are exact.', '- R-2: Totals are in the shopper currency.', '- R-3: Tax is shown.', '- AC-1: GIVEN a cart THEN the total shows.', '',
].join('\n');
const V2 = (s: string) => [
  `# Checkout ${s}`, '', '## Context', '', 'Totals are shown before paying.', '',
  '## Requirements', '', '- R-1: Totals round to cents.', '- R-2: Totals are in the shopper currency, never converted.', '- R-3: Tax is shown per line.', '- AC-1: GIVEN a cart WHEN it has three items THEN the total shows rounded.', '',
].join('\n');
const ALL = { 'R-1': 'Rounds to cents.', 'R-2': 'No conversion.', 'R-3': 'Tax per line.', 'AC-1': 'Checks the rounding.' };

/** A spec approved at revision 1 and revised to revision 2 with `explanation`. */
async function revised(explanation: unknown) {
  const s = rand();
  const c = await createSpecDraft(user(admin), { workspaceId: wsA, title: `Checkout ${s}`, body: V1(s) }, { duplicates: false });
  if (!c.ok) throw new Error(c.error);
  const [r1] = await q<{ content_hash: string }>(sql`SELECT content_hash FROM spec_revisions WHERE spec_id = ${c.spec.id}::uuid AND revision = 1`);
  // Approved at revision 1 directly, so revision 2 is reviewed against it.
  await q(sql`UPDATE specs SET approved_revision = 1, status = 'approved' WHERE id = ${c.spec.id}::uuid`);
  await q(sql`UPDATE spec_revisions SET approved_at = now(), approved_by = ${`user:${admin}`} WHERE spec_id = ${c.spec.id}::uuid AND revision = 1`);
  void r1;
  const r = await reviseSpecDraft(user(admin), c.spec.id, { expectedVersion: c.spec.version, body: V2(s), changeSummary: 'R-1 to R-3, AC-1', explanation }, { duplicates: false });
  if (!r.ok) throw new Error(r.error);
  return { specId: c.spec.id, version: r.spec.version, revision: r.revision.revision, contentHash: r.revision.contentHash };
}
async function view(p: Awaited<ReturnType<typeof revised>>) {
  const v = await approvalPinView(admin, p.specId, { revision: p.revision, expectedVersion: p.version, contentHash: p.contentHash });
  if (v.state !== 'ready') throw new Error(`view is ${v.state}`);
  return v;
}

describe('the explanation is stored with its revision (R-15)', () => {
  test('create_draft and revise store it; a revise without one does not carry it forward', async () => {
    const s = rand();
    const c = await createSpecDraft(user(admin), { workspaceId: wsA, title: `Checkout ${s}`, body: V1(s), explanation: { summary: 'First draft.', lines: { 'R-1': 'Exact totals.' } } }, { duplicates: false });
    if (!c.ok) throw new Error(c.error);
    expect(c.revision.explanation).toEqual({ summary: 'First draft.', lines: { 'R-1': 'Exact totals.' } });
    const r = await reviseSpecDraft(user(admin), c.spec.id, { expectedVersion: c.spec.version, body: V2(s) }, { duplicates: false });
    if (!r.ok) throw new Error(r.error);
    expect(r.revision.explanation).toBeNull();
  });

  test('a malformed explanation is a 400 and writes nothing', async () => {
    const s = rand();
    const c = await createSpecDraft(user(admin), { workspaceId: wsA, title: `Checkout ${s}`, body: V1(s), explanation: { lines: { 'R-1': 'no summary' } } }, { duplicates: false });
    expect(c.ok).toBe(false);
    if (!c.ok) expect(c.status).toBe(400);
  });
});

describe('the confirm view checks it against the real change (R-16, AC-13 to AC-16)', () => {
  test('AC-13: four changed criteria, a line for each: covers 4 of 4', async () => {
    const v = await view(await revised({ summary: 'Totals round to cents.', lines: ALL }));
    expect(v.coverage!.line).toBe('Explanation covers 4 of 4 changes');
    expect(v.coverage!.passed).toBe(true);
  });

  test('AC-14: one criterion missing is listed under Not explained', async () => {
    const { 'R-3': _r3, ...missing } = ALL;
    const v = await view(await revised({ summary: 'Totals round to cents.', lines: missing }));
    expect(v.coverage!.notExplained.map((i) => i.key)).toEqual(['R-3']);
    expect(v.coverage!.passed).toBe(false);
  });

  test('AC-15: a line naming a criterion that did not change is reported apart', async () => {
    const v = await view(await revised({ summary: 'Totals round to cents.', lines: { ...ALL, 'R-9': 'ghost' } }));
    expect(v.coverage!.extra).toEqual([{ key: 'R-9', text: 'ghost' }]);
  });

  test('AC-16: no explanation leaves every change not explained', async () => {
    const v = await view(await revised(undefined));
    expect(v.explanation).toBeNull();
    expect(v.coverage!.notExplained.map((i) => i.key)).toEqual(['R-1', 'R-2', 'R-3', 'AC-1']);
  });
});

describe('an explanation cannot change once written (AC-18)', () => {
  test('a revise that only sends another explanation is refused, and nothing is written', async () => {
    const p = await revised({ summary: 'Totals round to cents.', lines: ALL });
    const [spec] = await q<{ version: number; head_revision: number }>(sql`SELECT version, head_revision FROM specs WHERE id = ${p.specId}::uuid`);
    const [head] = await q<{ body: string }>(sql`
      SELECT a.content AS body FROM specs s JOIN artifacts a ON a.id = s.body_artifact_id WHERE s.id = ${p.specId}::uuid`);
    const r = await reviseSpecDraft(user(admin), p.specId, { expectedVersion: spec.version, body: head.body, explanation: { summary: 'Something else.', lines: ALL } }, { duplicates: false });
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.status).toBe(409); expect(r.code).toBe('explanation_immutable'); }
    const [after] = await q<{ version: number; head_revision: number }>(sql`SELECT version, head_revision FROM specs WHERE id = ${p.specId}::uuid`);
    expect(after).toEqual(spec);
    expect((await view(p)).explanation!.summary).toBe('Totals round to cents.');
  });

  test('the column refuses an UPDATE, and the page shows the original', async () => {
    const p = await revised({ summary: 'Totals round to cents.', lines: ALL });
    await expect(q(sql`UPDATE spec_revisions SET explanation = ${JSON.stringify({ summary: 'Rewritten.', lines: {} })}::jsonb WHERE spec_id = ${p.specId}::uuid AND revision = ${p.revision}`)).rejects.toThrow();
    // Clearing it is a change too.
    await expect(q(sql`UPDATE spec_revisions SET explanation = NULL WHERE spec_id = ${p.specId}::uuid AND revision = ${p.revision}`)).rejects.toThrow();
    // Other columns of the revision still update (approval writes approved_at).
    await q(sql`UPDATE spec_revisions SET criteria_count = criteria_count WHERE spec_id = ${p.specId}::uuid AND revision = ${p.revision}`);
    expect((await view(p)).explanation!.summary).toBe('Totals round to cents.');
  });
});
