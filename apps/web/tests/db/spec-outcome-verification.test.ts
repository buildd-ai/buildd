/**
 * Governed outcomes (Living Specs V1, decision D-5), against real Postgres: a
 * task pinned to an approved spec revision reads verified only when every
 * criterion of that revision passes on the current PR head; a violated
 * requirement reads fail while the task stays completed and the PR merged; an
 * unverified criterion never reads as a pass; a task never grades itself; and
 * another workspace can neither record nor read a verdict.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { assertDbConfigured, q, seedWorkspace } from './harness';

const { createSpecDraft, reviseSpecDraft } = await import('../../src/lib/specs/store');
const { approveSpecRevision } = await import('../../src/lib/specs/approval');
const { pinSpecSource } = await import('../../src/lib/specs/pin');
const { readGovernedOutcome, recordSpecVerdict, recordSpecConflict } = await import('../../src/lib/specs/outcome');

const rand = () => Math.random().toString(36).slice(2, 10);
const HEAD1 = '1'.repeat(40);
const HEAD2 = '2'.repeat(40);
const ACCOUNT = '00000000-0000-4000-8000-0000000000a2';

async function person(teamId: string, role: 'owner' | 'admin' | 'member') {
  const [u] = await q<{ id: string }>(sql`INSERT INTO users (email) VALUES (${`u-${rand()}@example.test`}) RETURNING id`);
  await q(sql`INSERT INTO team_members (team_id, user_id, role) VALUES (${teamId}::uuid, ${u.id}::uuid, ${role})`);
  return u.id;
}
const user = (userId: string) => ({ kind: 'user' as const, userId });
const token = (teamId: string, workspaceId: string, taskId: string) =>
  ({ kind: 'account' as const, account: { id: ACCOUNT, teamId, workspaceIds: null, taskScope: { taskId, workspaceId } } as any });

let teamA: string; let wsA: string; let teamB: string; let wsB: string; let admin: string; let outsider: string;
beforeAll(async () => {
  assertDbConfigured();
  ({ teamId: teamA, workspaceId: wsA } = await seedWorkspace());
  await q(sql`UPDATE workspaces SET access_mode = 'open' WHERE id = ${wsA}::uuid`);
  ({ teamId: teamB, workspaceId: wsB } = await seedWorkspace());
  admin = await person(teamA, 'admin');
  outsider = await person(teamB, 'admin');
});

const BODY = '# Checkout\nR-1: Totals are in the shopper\'s currency.\n- AC-1: A EUR cart shows €.\n### D-1 Rates come from one provider\n';

/** An approved spec, a completed task pinned to it with a merged PR at HEAD1, and its reviewer. */
async function governedTask() {
  const d = await createSpecDraft(user(admin), { workspaceId: wsA, title: `Checkout ${rand()}`, body: BODY });
  if (!d.ok) throw new Error(d.error);
  const a = await approveSpecRevision(user(admin), d.spec.id, { revision: 1, expectedVersion: 1 });
  if (!a.ok) throw new Error(a.error);
  const pinned = await pinSpecSource(wsA, { specSource: { specId: d.spec.id } });
  if (!pinned.ok) throw new Error(pinned.error);
  const [task] = await q<{ id: string }>(sql`
    INSERT INTO tasks (workspace_id, title, status, context) VALUES (${wsA}::uuid, ${`build ${rand()}`}, 'completed', ${JSON.stringify(pinned.context)}::jsonb) RETURNING id`);
  const [delivery] = await q<{ id: string }>(sql`INSERT INTO workflow_deliveries (workspace_id, owner_task_id, state, authority, current_head_sha, merged_at)
    VALUES (${wsA}::uuid, ${task.id}::uuid, 'MERGED', 'kernel', ${HEAD1}, now()) RETURNING id`);
  // The kernel's review round for this delivery: the shape reviewer.ts files.
  const reviewerId = await child(task.id, delivery.id, 'review', `[reviewer] PR #1: review ${rand()}`);
  return { spec: d.spec, revision: a.revision, approvedVersion: a.spec.version, taskId: task.id, reviewerId, deliveryId: delivery.id };
}

/** A child task of the subject, as the platform files it (attempt class, delivery role set server-side). */
async function child(parentId: string, deliveryId: string | null, role: string | null, title: string) {
  const [t] = await q<{ id: string }>(sql`
    INSERT INTO tasks (workspace_id, title, status, parent_task_id, task_class, delivery_id, delivery_role)
    VALUES (${wsA}::uuid, ${title}, 'in_progress', ${parentId}::uuid, 'attempt', ${deliveryId}::uuid, ${role}) RETURNING id`);
  return t.id;
}
const moveHead = (taskId: string, head: string) => q(sql`UPDATE workflow_deliveries SET current_head_sha = ${head}, updated_at = now() WHERE owner_task_id = ${taskId}::uuid`);
const outcomeOf = async (taskId: string) => {
  const r = await readGovernedOutcome(user(admin), taskId);
  if (!r.ok) throw new Error(r.error);
  return r.outcome;
};

describe('a violated requirement is never reported verified', () => {
  test('violate an approved R-1: the task is completed and its PR merged, and the outcome reads fail; restore it on a new head and it reads verified', async () => {
    const g = await governedTask();
    const reviewer = token(teamA, wsA, g.reviewerId);

    // Nothing recorded yet: unverified, never pass.
    expect((await outcomeOf(g.taskId)).outcome).toBe('unverified');

    const fail = await recordSpecVerdict(reviewer, g.taskId, { criterionId: 'R-1', verdict: 'fail', headSha: HEAD1, evidenceRefs: [{ kind: 'file', ref: 'cart.ts:12' }], observed: 'Totals are always shown in USD.' });
    if (!fail.ok) throw new Error(fail.error);
    await recordSpecVerdict(reviewer, g.taskId, { criterionId: 'AC-1', verdict: 'pass', headSha: HEAD1 });
    const failed = await outcomeOf(g.taskId);
    expect([failed.outcome, failed.reason]).toEqual(['fail', 'R-1 failed']);
    expect(failed.criteria.map((c) => [c.criterionId, c.verdict])).toEqual([['R-1', 'fail'], ['AC-1', 'pass']]);
    // Completion and merge are untouched: the outcome is advisory and separate.
    const [row] = await q<{ status: string; merged: boolean }>(sql`
      SELECT t.status, d.merged_at IS NOT NULL AS merged FROM tasks t JOIN workflow_deliveries d ON d.owner_task_id = t.id WHERE t.id = ${g.taskId}::uuid`);
    expect(row).toEqual({ status: 'completed', merged: true });

    // The fix lands on a new head. The old fail still stands until R-1 is re-checked.
    await moveHead(g.taskId, HEAD2);
    expect((await outcomeOf(g.taskId)).outcome).toBe('fail');
    await recordSpecVerdict(reviewer, g.taskId, { criterionId: 'R-1', verdict: 'pass', headSha: HEAD2 });
    // AC-1 passed only on the old head: unverified, not verified.
    const partial = await outcomeOf(g.taskId);
    expect(partial.outcome).toBe('unverified');
    expect(partial.criteria.find((c) => c.criterionId === 'AC-1')).toMatchObject({ verdict: 'pass', stale: true, holds: false });
    await recordSpecVerdict(reviewer, g.taskId, { criterionId: 'AC-1', verdict: 'pass', headSha: HEAD2 });
    const verified = await outcomeOf(g.taskId);
    expect([verified.outcome, verified.currentHeadSha]).toEqual(['verified', HEAD2]);
  });

  test('inconclusive and unsupported never count as a pass, and a pass with no PR head is unverified', async () => {
    const g = await governedTask();
    const reviewer = token(teamA, wsA, g.reviewerId);
    await recordSpecVerdict(reviewer, g.taskId, { criterionId: 'R-1', verdict: 'pass', headSha: HEAD1 });
    await recordSpecVerdict(reviewer, g.taskId, { criterionId: 'AC-1', verdict: 'inconclusive', headSha: HEAD1 });
    expect((await outcomeOf(g.taskId)).outcome).toBe('unverified');
    await recordSpecVerdict(reviewer, g.taskId, { criterionId: 'AC-1', verdict: 'unsupported', headSha: HEAD1 });
    expect((await outcomeOf(g.taskId)).outcome).toBe('unverified');
    await recordSpecVerdict(reviewer, g.taskId, { criterionId: 'AC-1', verdict: 'pass', headSha: HEAD1 });
    expect((await outcomeOf(g.taskId)).outcome).toBe('verified');
    await q(sql`DELETE FROM workflow_deliveries WHERE owner_task_id = ${g.taskId}::uuid`);
    expect(await outcomeOf(g.taskId)).toMatchObject({ outcome: 'unverified', currentHeadSha: null });
  });

  test('the outcome is judged against the pinned revision, not a later approved one', async () => {
    const g = await governedTask();
    const r2 = await reviseSpecDraft(user(admin), g.spec.id, { expectedVersion: g.approvedVersion, body: `${BODY}R-2: Rates are cached for 15 minutes.\n` });
    if (!r2.ok) throw new Error(r2.error);
    await approveSpecRevision(user(admin), g.spec.id, { revision: 2, expectedVersion: r2.spec.version });
    const o = await outcomeOf(g.taskId);
    expect([o.revision, o.criteria.map((c) => c.criterionId)]).toEqual([1, ['R-1', 'AC-1']]);
    expect(await recordSpecVerdict(token(teamA, wsA, g.reviewerId), g.taskId, { criterionId: 'R-2', verdict: 'pass', headSha: HEAD1 }))
      .toMatchObject({ ok: false, status: 400 });
  });
});

describe('a task answers for the criteria it names', () => {
  async function scopedTask(criteria: unknown) {
    const d = await createSpecDraft(user(admin), { workspaceId: wsA, title: `Checkout ${rand()}`, body: BODY });
    if (!d.ok) throw new Error(d.error);
    const a = await approveSpecRevision(user(admin), d.spec.id, { revision: 1, expectedVersion: 1 });
    if (!a.ok) throw new Error(a.error);
    return { specId: d.spec.id, pinned: await pinSpecSource(wsA, { specSource: { specId: d.spec.id, criteria } }) };
  }

  test('a slice that names AC-1 reads verified when AC-1 passes on the head, with R-1 out of its scope', async () => {
    const s = await scopedTask(['AC-01']);
    if (!s.pinned.ok) throw new Error(s.pinned.error);
    expect((s.pinned.context as any).specSource.criteria).toEqual(['AC-1']);
    const [task] = await q<{ id: string }>(sql`
      INSERT INTO tasks (workspace_id, title, status, context) VALUES (${wsA}::uuid, ${`slice ${rand()}`}, 'completed', ${JSON.stringify(s.pinned.context)}::jsonb) RETURNING id`);
    const [delivery] = await q<{ id: string }>(sql`INSERT INTO workflow_deliveries (workspace_id, owner_task_id, state, authority, current_head_sha, merged_at)
      VALUES (${wsA}::uuid, ${task.id}::uuid, 'MERGED', 'kernel', ${HEAD1}, now()) RETURNING id`);
    const reviewer = token(teamA, wsA, await child(task.id, delivery.id, 'review', `[reviewer] PR #2: review ${rand()}`));

    expect((await outcomeOf(task.id)).criteria.map((c) => c.criterionId)).toEqual(['AC-1']);
    expect(await recordSpecVerdict(reviewer, task.id, { criterionId: 'R-1', verdict: 'pass', headSha: HEAD1 })).toMatchObject({ ok: false, status: 400 });
    await recordSpecVerdict(reviewer, task.id, { criterionId: 'AC-1', verdict: 'pass', headSha: HEAD1 });
    expect((await outcomeOf(task.id)).outcome).toBe('verified');
  });

  test('a scope naming a criterion the revision lacks, a decision, or nothing is refused at filing', async () => {
    for (const bad of [['AC-9'], ['D-1'], [], 'AC-1']) {
      const s = await scopedTask(bad);
      expect(s.pinned).toMatchObject({ ok: false, status: 400 });
    }
    const s = await scopedTask(['AC-9']);
    expect(!s.pinned.ok && s.pinned.error).toContain('R-1, AC-1');
  });
});

describe('a verdict is evidence bound to a head and to what was read', () => {
  test('a criterion the revision does not have, a verdict outside the vocabulary, or no head is refused, and nothing is written', async () => {
    const g = await governedTask();
    const reviewer = token(teamA, wsA, g.reviewerId);
    for (const input of [
      { criterionId: 'R-9', verdict: 'pass', headSha: HEAD1 },
      { criterionId: 'D-1', verdict: 'pass', headSha: HEAD1 },
      { criterionId: 'R-1', verdict: 'verified', headSha: HEAD1 },
      { criterionId: 'R-1', verdict: 'pass', headSha: undefined },
      { criterionId: 'R-1', verdict: 'pass', headSha: 'main' },
    ]) expect(await recordSpecVerdict(reviewer, g.taskId, input)).toMatchObject({ ok: false, status: 400 });
    const [{ n }] = await q<{ n: number }>(sql`SELECT count(*)::int AS n FROM spec_outcome_verdicts WHERE task_id = ${g.taskId}::uuid`);
    expect(n).toBe(0);
  });

  test('the reads behind a verdict are kept; a read from another workspace is refused', async () => {
    const g = await governedTask();
    const reviewer = token(teamA, wsA, g.reviewerId);
    const [own] = await q<{ id: string }>(sql`INSERT INTO artifact_reads (artifact_id, revision, workspace_id, view, returned_chars, total_chars)
      VALUES (gen_random_uuid(), 1, ${wsA}::uuid, 'section', 10, 100) RETURNING id`);
    const [foreign] = await q<{ id: string }>(sql`INSERT INTO artifact_reads (artifact_id, revision, workspace_id, view, returned_chars, total_chars)
      VALUES (gen_random_uuid(), 1, ${wsB}::uuid, 'full', 10, 10) RETURNING id`);
    expect(await recordSpecVerdict(reviewer, g.taskId, { criterionId: 'R-1', verdict: 'pass', headSha: HEAD1, readIds: [foreign.id] }))
      .toMatchObject({ ok: false, status: 400 });
    const ok = await recordSpecVerdict(reviewer, g.taskId, { criterionId: 'R-1', verdict: 'pass', headSha: HEAD1.toUpperCase(), readIds: [own.id] });
    if (!ok.ok) throw new Error(ok.error);
    const [row] = await q<{ head_sha: string; spec_revision_id: string; evidence: { readIds: string[]; recordedBy: string } }>(sql`
      SELECT head_sha, spec_revision_id, evidence FROM spec_outcome_verdicts WHERE id = ${ok.verdictId}::uuid`);
    expect([row.head_sha, row.spec_revision_id, row.evidence.readIds, row.evidence.recordedBy]).toEqual([HEAD1, g.revision.id, [own.id], `account:${ACCOUNT}`]);
  });
});

describe('who records and who reads', () => {
  test('a task never grades itself: its own token reads its outcome but cannot record a verdict', async () => {
    const g = await governedTask();
    const self = token(teamA, wsA, g.taskId);
    expect(await recordSpecVerdict(self, g.taskId, { criterionId: 'R-1', verdict: 'pass', headSha: HEAD1 })).toMatchObject({ ok: false, status: 403 });
    expect(await readGovernedOutcome(self, g.taskId)).toMatchObject({ ok: true });
    // An unrelated task's token in the same workspace does neither.
    const [other] = await q<{ id: string }>(sql`INSERT INTO tasks (workspace_id, title, status) VALUES (${wsA}::uuid, 'other', 'in_progress') RETURNING id`);
    expect(await recordSpecVerdict(token(teamA, wsA, other.id), g.taskId, { criterionId: 'R-1', verdict: 'pass', headSha: HEAD1 })).toMatchObject({ ok: false, status: 403 });
    expect(await readGovernedOutcome(token(teamA, wsA, other.id), g.taskId)).toMatchObject({ ok: false, status: 404 });
    // A person with write access records.
    expect(await recordSpecVerdict(user(admin), g.taskId, { criterionId: 'R-1', verdict: 'pass', headSha: HEAD1 })).toMatchObject({ ok: true });
  });

  test('a builder fix attempt never grades the task it is fixing; only the kernel review round of its delivery records', async () => {
    const g = await governedTask();
    const fixers = [
      await child(g.taskId, g.deliveryId, 'ci_fix', '[builder · after CI #1] build'),
      await child(g.taskId, g.deliveryId, 'conflict_fix', '[builder · after conflict #1] build'),
      await child(g.taskId, g.deliveryId, 'fix', '[builder · after review #1] build'),
      // Filed by the subject's own token under itself: no delivery role.
      await child(g.taskId, null, null, 'a verification task I filed myself'),
    ];
    for (const id of fixers) {
      expect(await recordSpecVerdict(token(teamA, wsA, id), g.taskId, { criterionId: 'R-1', verdict: 'pass', headSha: HEAD1 })).toMatchObject({ ok: false, status: 403 });
      expect(await recordSpecVerdict(token(teamA, wsA, id), g.taskId, { criterionId: 'AC-1', verdict: 'pass', headSha: HEAD1 })).toMatchObject({ ok: false, status: 403 });
    }
    // A review round of another delivery is not this task's reviewer.
    const other = await governedTask();
    const strayReview = await child(g.taskId, other.deliveryId, 'review', '[reviewer] PR #2');
    expect(await recordSpecVerdict(token(teamA, wsA, strayReview), g.taskId, { criterionId: 'R-1', verdict: 'pass', headSha: HEAD1 })).toMatchObject({ ok: false, status: 403 });
    const [{ n }] = await q<{ n: number }>(sql`SELECT count(*)::int AS n FROM spec_outcome_verdicts WHERE task_id = ${g.taskId}::uuid`);
    expect(n).toBe(0);
    expect((await outcomeOf(g.taskId)).outcome).not.toBe('verified');
    // The review round records.
    const reviewer = token(teamA, wsA, g.reviewerId);
    expect(await recordSpecVerdict(reviewer, g.taskId, { criterionId: 'R-1', verdict: 'pass', headSha: HEAD1 })).toMatchObject({ ok: true });
    expect(await recordSpecVerdict(reviewer, g.taskId, { criterionId: 'AC-1', verdict: 'pass', headSha: HEAD1 })).toMatchObject({ ok: true });
    expect((await outcomeOf(g.taskId)).outcome).toBe('verified');
  });

  test('another workspace can neither record nor read a verdict', async () => {
    const g = await governedTask();
    expect(await recordSpecVerdict(user(outsider), g.taskId, { criterionId: 'R-1', verdict: 'pass', headSha: HEAD1 })).toMatchObject({ ok: false, status: 404 });
    expect(await readGovernedOutcome(user(outsider), g.taskId)).toMatchObject({ ok: false, status: 404 });
    // A token scoped to the other workspace, even one claiming the reviewer's task id.
    expect(await recordSpecVerdict(token(teamB, wsB, g.reviewerId), g.taskId, { criterionId: 'R-1', verdict: 'pass', headSha: HEAD1 })).toMatchObject({ ok: false, status: 404 });
    expect(await readGovernedOutcome(token(teamB, wsB, g.taskId), g.taskId)).toMatchObject({ ok: false, status: 404 });
    const [{ n }] = await q<{ n: number }>(sql`SELECT count(*)::int AS n FROM spec_outcome_verdicts WHERE task_id = ${g.taskId}::uuid`);
    expect(n).toBe(0);
  });

  test('a task with no Living Spec has no governed outcome', async () => {
    const [plain] = await q<{ id: string }>(sql`INSERT INTO tasks (workspace_id, title, status) VALUES (${wsA}::uuid, 'plain', 'completed') RETURNING id`);
    expect(await readGovernedOutcome(user(admin), plain.id)).toMatchObject({ ok: false, status: 409 });
  });
});

describe('conflicting criteria are advisory discrepancies', () => {
  test('two criteria of an approved revision are recorded once as a conflict naming that revision; repeats update the same row', async () => {
    const g = await governedTask();
    const first = await recordSpecConflict(user(admin), g.spec.id, { revision: 1, criterionIds: ['AC-1', 'R-1'], note: 'EUR vs shopper currency' });
    if (!first.ok) throw new Error(first.error);
    const again = await recordSpecConflict(token(teamA, wsA, g.reviewerId), g.spec.id, { revision: 1, criterionIds: ['R-1', 'AC-1'] });
    expect(again.ok && again.discrepancyId).toBe(first.discrepancyId);
    const [row] = await q<{ direction: string; status: string; spec_revision_id: string; assertion_id: string }>(sql`
      SELECT direction, status, spec_revision_id, assertion_id FROM spec_discrepancies WHERE id = ${first.discrepancyId}::uuid`);
    expect(row).toEqual({ direction: 'conflict', status: 'open', spec_revision_id: g.revision.id, assertion_id: 'conflict:AC-1+R-1' });
  });

  test('a criterion the revision lacks, an unapproved revision, or another workspace is refused', async () => {
    const g = await governedTask();
    expect(await recordSpecConflict(user(admin), g.spec.id, { revision: 1, criterionIds: ['R-1', 'R-7'] })).toMatchObject({ ok: false, status: 400 });
    expect(await recordSpecConflict(user(admin), g.spec.id, { revision: 1, criterionIds: ['R-1', 'R-1'] })).toMatchObject({ ok: false, status: 400 });
    expect(await recordSpecConflict(user(admin), g.spec.id, { revision: 5, criterionIds: ['R-1', 'AC-1'] })).toMatchObject({ ok: false, status: 409 });
    expect(await recordSpecConflict(user(outsider), g.spec.id, { revision: 1, criterionIds: ['R-1', 'AC-1'] })).toMatchObject({ ok: false, status: 404 });
  });
});
