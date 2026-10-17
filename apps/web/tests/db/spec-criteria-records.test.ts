/**
 * Criteria as records and what Review lists (spec aafdec35 "Reviewing a spec
 * revision", R-1 to R-5, R-8, R-11 to R-16, AC-1 to AC-3, AC-6 to AC-9),
 * against real Postgres: every revision write keeps one record per R-n/AC-n,
 * Review's change list comes from those records and is kept per pair, a
 * criterion has a history, a verdict counts only for the words it judged, and
 * a retired id is never given new words.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { assertDbConfigured, q, seedWorkspace } from './harness';

process.env.AUTH_SECRET ||= 'spec-criteria-records-test-secret';

const { createSpecDraft, reviseSpecDraft } = await import('../../src/lib/specs/store');
const { approveSpecRevision, specApprovalDeps } = await import('../../src/lib/specs/approval');
const { specReviewView } = await import('../../src/lib/specs/page-view');
const { specCriterionHistory, pairChanges, backfillSpecCriteria } = await import('../../src/lib/specs/revision-changes');
const { pinSpecSource } = await import('../../src/lib/specs/pin');
const { recordSpecVerdict, readGovernedOutcome } = await import('../../src/lib/specs/outcome');
const { readSpecDelivery } = await import('../../src/lib/specs/delivery');
const { addSpecComment, listSpecComments } = await import('../../src/lib/specs/comments');
const { criterionHash } = await import('../../src/lib/specs/criteria');

const rand = () => Math.random().toString(36).slice(2, 10);
const HEAD = 'b'.repeat(40);
const user = (userId: string) => ({ kind: 'user' as const, userId });
async function person(teamId: string, role: 'owner' | 'admin' | 'member') {
  const [u] = await q<{ id: string }>(sql`INSERT INTO users (email) VALUES (${`u-${rand()}@example.test`}) RETURNING id`);
  await q(sql`INSERT INTO team_members (team_id, user_id, role) VALUES (${teamId}::uuid, ${u.id}::uuid, ${role})`);
  return u.id;
}

let ws: string; let admin: string;
beforeAll(async () => {
  assertDbConfigured();
  const seeded = await seedWorkspace();
  ws = seeded.workspaceId;
  await q(sql`UPDATE workspaces SET access_mode = 'open' WHERE id = ${ws}::uuid`);
  admin = await person(seeded.teamId, 'admin');
  specApprovalDeps.afterResponse = () => {};
});

const V1 = [
  '# Slots',
  '## Queue',
  '- R-24: The queue shows what holds each row.',
  '- R-25: A free slot starts the next row.',
  '- R-26: Work that would start on a free slot reads "now".',
  '## Runner',
  '- AC-1: Two runners share one queue.',
  '',
].join('\n');

async function spec(body = V1) {
  const d = await createSpecDraft(user(admin), { workspaceId: ws, title: `Slots ${rand()}`, body, changeSummary: 'First draft' }, { duplicates: false });
  if (!d.ok) throw new Error(d.error);
  const a = await approveSpecRevision(user(admin), d.spec.id, { revision: 1, expectedVersion: 1 });
  if (!a.ok || 'pending' in a) throw new Error('approval failed');
  return { specId: d.spec.id, version: a.spec.version };
}
async function revise(specId: string, version: number, body: string, changeSummary: string) {
  const r = await reviseSpecDraft(user(admin), specId, { expectedVersion: version, body, changeSummary });
  if (!r.ok) throw new Error(r.error);
  return r;
}
async function approve(specId: string, revision: number, version: number) {
  const a = await approveSpecRevision(user(admin), specId, { revision, expectedVersion: version });
  if (!a.ok || 'pending' in a) throw new Error('approval failed');
  return a.spec.version;
}

describe('records (R-11)', () => {
  test('each revision write keeps one record per criterion, with its words, hash and section', async () => {
    const { specId } = await spec();
    const rows = await q<{ criterion_id: string; text: string; text_hash: string; section: string; revision: number }>(sql`
      SELECT criterion_id, text, text_hash, section, revision FROM spec_criteria WHERE spec_id = ${specId}::uuid ORDER BY position`);
    expect(rows.map((r) => [r.criterion_id, r.section])).toEqual([['R-24', 'Slots > Queue'], ['R-25', 'Slots > Queue'], ['R-26', 'Slots > Queue'], ['AC-1', 'Slots > Runner']]);
    expect(rows[2].text_hash).toBe(criterionHash('Work that would start on a free slot reads "now".'));
    const [rev] = await q<{ criteria_count: number }>(sql`SELECT criteria_count FROM spec_revisions WHERE spec_id = ${specId}::uuid AND revision = 1`);
    expect(rev.criteria_count).toBe(4);
  });

  test('a revision whose records were never written is derived from its body on first need', async () => {
    const { specId, version } = await spec();
    await revise(specId, version, V1.replace('reads "now"', 'reads "now", in bold'), 'Bold now on R-26');
    await q(sql`DELETE FROM spec_criteria WHERE spec_id = ${specId}::uuid`);
    await q(sql`UPDATE spec_revisions SET criteria_count = NULL WHERE spec_id = ${specId}::uuid`);
    await q(sql`DELETE FROM spec_revision_reviews WHERE spec_id = ${specId}::uuid`);
    const r = await specCriterionHistory(user(admin), specId, 'R-26');
    if (!r.ok) throw new Error(r.error);
    expect(r.history.entries.map((e) => e.revision)).toEqual([1, 2]);
    const [n] = await q<{ n: number }>(sql`SELECT count(*)::int AS n FROM spec_criteria WHERE spec_id = ${specId}::uuid`);
    expect(n.n).toBe(8);
  });
});

describe('backfill (R-8, R-11)', () => {
  test('derives the records and reviews of revisions written before they were kept, once', async () => {
    const { specId, version } = await spec();
    const r = await revise(specId, version, V1.replace('reads "now"', 'reads "next"'), 'R-26 reads next');
    await revise(specId, r.spec.version, `${V1.replace('reads "now"', 'reads "next"')}\nMore.\n`, 'More');
    await q(sql`DELETE FROM spec_criteria WHERE spec_id = ${specId}::uuid`);
    await q(sql`UPDATE spec_revisions SET criteria_count = NULL WHERE spec_id = ${specId}::uuid`);
    await q(sql`DELETE FROM spec_revision_reviews WHERE spec_id = ${specId}::uuid`);
    expect(await backfillSpecCriteria({ dryRun: true, specIds: [specId] })).toEqual({ specs: 1, revisions: 3, reviews: 4, failed: [] });
    const [none] = await q<{ n: number }>(sql`SELECT count(*)::int AS n FROM spec_criteria WHERE spec_id = ${specId}::uuid`);
    expect(none.n).toBe(0);
    // Pairs: 0→1, 1→2, 2→3, and the waiting head against the approved revision, 1→3.
    expect(await backfillSpecCriteria({ specIds: [specId] })).toEqual({ specs: 1, revisions: 3, reviews: 4, failed: [] });
    const [n] = await q<{ n: number }>(sql`SELECT count(*)::int AS n FROM spec_criteria WHERE spec_id = ${specId}::uuid`);
    expect(n.n).toBe(12);
    expect(await backfillSpecCriteria({ specIds: [specId] })).toEqual({ specs: 0, revisions: 0, reviews: 0, failed: [] });
    expect((await pairChanges(specId, 1, 3))?.lines.map((l) => l.kind)).toEqual(['changed']);
  });
});

describe('Review (R-1 to R-5, R-8, R-16)', () => {
  test('AC-1: one changed and one added range of three; the summary leads; the full diff is behind its toggle', async () => {
    const { specId, version } = await spec();
    const v2 = V1.replace('reads "now".', 'reads "now" and shows its slot.').replace('- AC-1: Two runners share one queue.', '- AC-1: Two runners share one queue.\n- R-44: a\n- R-45: b\n- R-46: c');
    await revise(specId, version, v2, 'R-26 names the slot; adds R-44 to R-46.');
    const r = await specReviewView(user(admin), specId);
    if (!r.ok) throw new Error(r.error);
    expect(r.review.changes?.summary).toBe('R-26 names the slot; adds R-44 to R-46.');
    expect(r.review.changes?.mismatch).toBeNull();
    const lines = r.review.changes!.lines;
    expect(lines.map((l) => l.kind)).toEqual(['changed', 'added-range']);
    expect(lines[0]).toMatchObject({ id: 'R-26' });
    expect(lines[1]).toMatchObject({ label: 'R-44 – R-46' });
    expect(r.review.changes?.otherText).toEqual([]);
    // Kept when the revision was written (R-8): Review read it, it did not compute it.
    const kept = await q<{ from_revision: number; to_revision: number }>(sql`SELECT from_revision, to_revision FROM spec_revision_reviews WHERE spec_id = ${specId}::uuid ORDER BY from_revision`);
    expect(kept.map((k) => [k.from_revision, k.to_revision])).toEqual([[0, 1], [1, 2]]);
  });

  test('AC-2: a summary naming R-26 while R-25 and R-26 changed names R-25 in one line', async () => {
    const { specId, version } = await spec();
    await revise(specId, version, V1.replace('starts the next row', 'starts the oldest row').replace('reads "now"', 'reads "now" at once'), 'Tighten R-26.');
    const c = await pairChanges(specId, 1, 2);
    expect(c?.mismatch).toBe('The summary does not mention R-25, which changed.');
  });

  test('AC-3: a criterion moved to another section unchanged is listed as moved, nowhere else', async () => {
    const { specId, version } = await spec();
    const v2 = V1.replace('- R-24: The queue shows what holds each row.\n', '').replace('- AC-1: Two runners share one queue.', '- AC-1: Two runners share one queue.\n- R-24: The queue shows what holds each row.');
    await revise(specId, version, v2, 'Move R-24 under Runner.');
    const c = await pairChanges(specId, 1, 2);
    expect(c?.lines).toEqual([{ kind: 'moved', id: 'R-24', text: 'The queue shows what holds each row.', section: 'Slots > Runner', movedFrom: 'Slots > Queue' }]);
    expect(c?.mismatch).toBeNull();
  });

  test('prose outside criteria is listed under Other text by section heading', async () => {
    const { specId, version } = await spec();
    await revise(specId, version, V1.replace('## Runner\n', '## Runner\n\nRunners are machines.\n\n'), 'Explain runners.');
    const c = await pairChanges(specId, 1, 2);
    expect(c?.lines).toEqual([]);
    expect(c?.otherText).toEqual([{ kind: 'changed', section: 'Slots > Runner' }]);
  });
});

describe('history, wordings and ids (R-12 to R-15)', () => {
  test('AC-6: a criterion changed in two revisions lists exactly those two, with summary, author and approval', async () => {
    const { specId, version } = await spec(V1.replace('- R-26: Work that would start on a free slot reads "now".\n', ''));
    let v = version;
    // Revisions 2 to 5 leave R-26 out; 6 adds it; 7 to 11 change something else; 12 changes it.
    for (let n = 2; n <= 5; n++) v = (await revise(specId, v, `${V1.replace('- R-26: Work that would start on a free slot reads "now".\n', '')}\nNote ${n}.\n`, `Note ${n}`)).spec.version;
    v = (await revise(specId, v, `${V1}\nNote 6.\n`, 'Adds R-26')).spec.version;
    v = await approve(specId, 6, v);
    for (let n = 7; n <= 11; n++) v = (await revise(specId, v, `${V1}\nNote ${n}.\n`, `Note ${n}`)).spec.version;
    await revise(specId, v, `${V1.replace('reads "now"', 'reads "now" in bold')}\nNote 12.\n`, 'Bold R-26');
    const r = await specCriterionHistory(user(admin), specId, 'R-26');
    if (!r.ok) throw new Error(r.error);
    expect(r.history.entries.map((e) => [e.revision, e.kind, e.changeSummary, e.author, e.approved])).toEqual([
      [6, 'added', 'Adds R-26', 'person', true],
      [12, 'changed', 'Bold R-26', 'person', false],
    ]);
    expect(r.history.retiredIn).toBeNull();
    expect(await specCriterionHistory(user(admin), specId, 'R-99')).toMatchObject({ ok: false, status: 404 });
  }, 60_000);

  test('AC-7: a pass on the earlier wording reads "passed an earlier wording" and does not count for the new one', async () => {
    const { specId, version } = await spec();
    const pinned = await pinSpecSource(ws, { specSource: { specId } });
    if (!pinned.ok) throw new Error(pinned.error);
    // The pin records the words it answers for.
    expect((pinned.context as { specSource: { criterionHashes: Record<string, string> } }).specSource.criterionHashes['R-26'])
      .toBe(criterionHash('Work that would start on a free slot reads "now".'));
    const [t] = await q<{ id: string }>(sql`INSERT INTO tasks (workspace_id, title, status, context) VALUES (${ws}::uuid, ${`build ${rand()}`}, 'completed', ${JSON.stringify(pinned.context)}::jsonb) RETURNING id`);
    await q(sql`INSERT INTO workflow_deliveries (workspace_id, owner_task_id, state, authority, current_head_sha, merged_at) VALUES (${ws}::uuid, ${t.id}::uuid, 'MERGED', 'kernel', ${HEAD}, now())`);
    for (const criterionId of ['R-24', 'R-25', 'R-26', 'AC-1']) {
      const v = await recordSpecVerdict(user(admin), t.id, { criterionId, verdict: 'pass', headSha: HEAD });
      if (!v.ok) throw new Error(v.error);
    }
    const [row] = await q<{ criterion_text_hash: string }>(sql`SELECT criterion_text_hash FROM spec_outcome_verdicts WHERE task_id = ${t.id}::uuid AND criterion_id = 'R-26'`);
    expect(row.criterion_text_hash).toBe(criterionHash('Work that would start on a free slot reads "now".'));
    expect((await readGovernedOutcome(null, t.id) as { ok: true; outcome: { outcome: string } }).outcome.outcome).toBe('verified');

    const r = await revise(specId, version, V1.replace('reads "now"', 'reads "now" in bold'), 'Bold R-26');
    await approve(specId, 2, r.spec.version);
    const entry = (await readSpecDelivery(user(admin), specId))!.entries.find((e) => e.id === t.id)!;
    expect(entry.criteria.find((c) => c.criterionId === 'R-26')?.mark).toBe('earlier-pass');
    expect(entry.criteria.find((c) => c.criterionId === 'R-24')?.mark).toBe('pass');
    expect(entry.standing.text).toBe('Not verified against revision 2.');
  });

  test('a verdict recorded on other words of the same revision does not count', async () => {
    const { specId } = await spec();
    const pinned = await pinSpecSource(ws, { specSource: { specId } });
    if (!pinned.ok) throw new Error(pinned.error);
    const [t] = await q<{ id: string }>(sql`INSERT INTO tasks (workspace_id, title, status, context) VALUES (${ws}::uuid, ${`build ${rand()}`}, 'completed', ${JSON.stringify(pinned.context)}::jsonb) RETURNING id`);
    await q(sql`INSERT INTO workflow_deliveries (workspace_id, owner_task_id, state, authority, current_head_sha, merged_at) VALUES (${ws}::uuid, ${t.id}::uuid, 'MERGED', 'kernel', ${HEAD}, now())`);
    const v = await recordSpecVerdict(user(admin), t.id, { criterionId: 'R-26', verdict: 'pass', headSha: HEAD });
    if (!v.ok) throw new Error(v.error);
    await q(sql`UPDATE spec_outcome_verdicts SET criterion_text_hash = ${'0'.repeat(64)} WHERE task_id = ${t.id}::uuid`);
    const o = await readGovernedOutcome(null, t.id);
    if (!o.ok) throw new Error(o.error);
    expect(o.outcome.criteria.find((c) => c.criterionId === 'R-26')?.verdict).toBeNull();
  });

  test('AC-8: a criterion with replaces: reads as replacing, and its history continues the one it replaces', async () => {
    const { specId, version } = await spec();
    await revise(specId, version, V1.replace('- R-26: Work that would start on a free slot reads "now".', '- R-50: Work that starts next reads "next".\n  replaces: R-26'), 'R-50 replaces R-26.');
    const c = await pairChanges(specId, 1, 2);
    expect(c?.lines).toEqual([{ kind: 'replacing', id: 'R-50', text: 'Work that starts next reads "next".', section: 'Slots > Queue', replaces: [{ id: 'R-26', oldText: 'Work that would start on a free slot reads "now".' }] }]);
    const h = await specCriterionHistory(user(admin), specId, 'R-50');
    if (!h.ok) throw new Error(h.error);
    expect(h.history.replaces).toEqual(['R-26']);
    expect(h.history.entries.map((e) => [e.criterionId, e.revision])).toEqual([['R-26', 1], ['R-50', 2]]);
    const old = await specCriterionHistory(user(admin), specId, 'R-26');
    expect(old.ok && [old.history.retiredIn, old.history.replacedBy]).toEqual([2, 'R-50']);
  });

  test('AC-9: giving a retired id new words is refused, naming the revision that retired it; its old words may come back', async () => {
    const { specId, version } = await spec();
    const v2 = await revise(specId, version, V1.replace('- R-26: Work that would start on a free slot reads "now".\n', ''), 'Drop R-26.');
    const reuse = await reviseSpecDraft(user(admin), specId, { expectedVersion: v2.spec.version, body: `${V1.replace('reads "now"', 'reads "soon"')}`, changeSummary: 'R-26 again' });
    expect(reuse).toMatchObject({ ok: false, status: 409, code: 'criterion_id_retired' });
    expect(!reuse.ok && reuse.error).toContain('R-26 was retired in revision 2');
    expect(!reuse.ok && reuse.error).toContain('the next free: R-27');
    expect(!reuse.ok && reuse.error.includes('\n')).toBe(false);
    const restore = await reviseSpecDraft(user(admin), specId, { expectedVersion: v2.spec.version, body: V1, changeSummary: 'Restore R-26' });
    expect(restore.ok).toBe(true);
  });

  test('a criterion comment records the criterion\'s text hash and goes outdated when the words change', async () => {
    const { specId, version } = await spec();
    const c = await addSpecComment(user(admin), specId, { anchor: { criterion: 'R-26' }, body: 'Is "now" right?' });
    if (!c.ok) throw new Error(c.error);
    const [row] = await q<{ anchor_hash: string }>(sql`SELECT anchor_hash FROM spec_comments WHERE id = ${c.comment.id}::uuid`);
    expect(row.anchor_hash).toBe(criterionHash('Work that would start on a free slot reads "now".'));
    await revise(specId, version, V1.replace('reads "now"', 'reads "next"'), 'R-26 reads next');
    const list = await listSpecComments(user(admin), specId);
    expect(list.ok && list.comments[0].state).toBe('outdated');
  });
});
