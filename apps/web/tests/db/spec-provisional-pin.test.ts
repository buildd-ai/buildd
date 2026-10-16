/**
 * Living Specs §20: building ahead of approval. Work filed against a draft is
 * pinned provisionally to the exact revision it was built against; a person's
 * approval of M re-pins every provisional pin to M and re-grades it (checks
 * rerun at the PR head, a verdict carries over only on unchanged text, a note
 * with the diff, the PR text updated), idempotently; merged provisional work
 * nobody approved shows in Needs You; and a person (never an agent run) can
 * attach finished work to the revision it was built against.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'crypto';
import { sql } from 'drizzle-orm';
import { assertDbConfigured, q, seedWorkspace } from './harness';

const { createSpecDraft, reviseSpecDraft } = await import('../../src/lib/specs/store');
const { approveSpecRevision, specApprovalDeps } = await import('../../src/lib/specs/approval');
const { pinSpecSource } = await import('../../src/lib/specs/pin');
const { repinSpecAtClaim } = await import('../../src/lib/specs/claim-pin');
const { readGovernedOutcome, recordSpecVerdict } = await import('../../src/lib/specs/outcome');
const { regradeProvisionalPins, attachProvisional, loadProvisionalNeedsYou, provisionalDeps } = await import('../../src/lib/specs/provisional');

const rand = () => Math.random().toString(36).slice(2, 10);
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const HEAD = 'a'.repeat(40);
const CHECK = 'bun run scripts/run-unit-tests.ts apps/web/src/lib/fx.test.ts';
const BODY_1 = `# Checkout\nR-1: Totals are in the shopper currency.\n  check: \`${CHECK}\`\nR-2: Rates are cached for 15 minutes.\n`;
// Revision 2 keeps R-1 word for word and rewords R-2.
const BODY_2 = `# Checkout\nR-1: Totals are in the shopper currency.\n  check: \`${CHECK}\`\nR-2: Rates are cached for 10 minutes.\n`;

let teamA: string; let wsA: string; let admin: string; let member: string;
const user = (userId: string) => ({ kind: 'user' as const, userId });
const ACCOUNT = '00000000-0000-4000-8000-0000000000a2';
const agentToken = () => ({ kind: 'account' as const, account: { id: ACCOUNT, teamId: teamA, workspaceIds: null, level: 'admin', taskScope: { taskId: '00000000-0000-4000-8000-0000000000f2', workspaceId: wsA } } as any });
const apiKey = () => ({ kind: 'account' as const, account: { id: ACCOUNT, teamId: teamA, workspaceIds: null, level: 'worker' } as any });
const adminKey = () => ({ kind: 'account' as const, account: { id: ACCOUNT, teamId: teamA, workspaceIds: null, level: 'admin' } as any });

const woken: string[] = [];
const prEdits: Array<{ taskId: string; body: string }> = [];

beforeAll(async () => {
  assertDbConfigured();
  ({ teamId: teamA, workspaceId: wsA } = await seedWorkspace());
  await q(sql`UPDATE workspaces SET access_mode = 'open' WHERE id = ${wsA}::uuid`);
  for (const role of ['admin', 'member'] as const) {
    const [u] = await q<{ id: string }>(sql`INSERT INTO users (email) VALUES (${`u-${rand()}@example.test`}) RETURNING id`);
    await q(sql`INSERT INTO team_members (team_id, user_id, role) VALUES (${teamA}::uuid, ${u.id}::uuid, ${role})`);
    if (role === 'admin') admin = u.id; else member = u.id;
  }
  // No dispatch and no GitHub in this suite: record what would have happened.
  provisionalDeps.wake = async (t) => { woken.push(t.id); };
  provisionalDeps.rewritePrBody = async (taskId, rewrite) => {
    prEdits.push({ taskId, body: rewrite('<!-- buildd-lede -->\nLede.\n<!-- /buildd-lede -->\n\nBody.') });
    return 'updated';
  };
});

async function draftSpec(body = BODY_1) {
  const d = await createSpecDraft(user(member), { workspaceId: wsA, title: `Checkout ${rand()}`, body });
  if (!d.ok) throw new Error(d.error);
  return d.spec;
}

async function insertTask(context: unknown, status = 'pending') {
  const [t] = await q<{ id: string }>(sql`
    INSERT INTO tasks (workspace_id, title, status, context)
    VALUES (${wsA}::uuid, ${`task-${rand()}`}, ${status}, ${JSON.stringify(context)}::jsonb) RETURNING id`);
  return t.id;
}

/** A task filed provisionally against the spec, completed, with a merged PR at HEAD. */
async function shippedProvisional(specId: string, opts: { mergedDaysAgo?: number; criteria?: string[] } = {}) {
  const pinned = await pinSpecSource(wsA, { specSource: { specId, ...(opts.criteria ? { criteria: opts.criteria } : {}) } });
  if (!pinned.ok) throw new Error(pinned.error);
  const taskId = await insertTask(pinned.context, 'completed');
  await merged(taskId, opts.mergedDaysAgo ?? 0);
  return taskId;
}

async function merged(taskId: string, daysAgo: number) {
  await q(sql`INSERT INTO workflow_deliveries (workspace_id, owner_task_id, state, authority, current_head_sha, merged_at)
    VALUES (${wsA}::uuid, ${taskId}::uuid, 'MERGED', 'kernel', ${HEAD}, now() - ${`${daysAgo} days`}::interval)`);
  await q(sql`INSERT INTO workers (workspace_id, task_id, name, runner, branch, status, pr_number, merged_at)
    VALUES (${wsA}::uuid, ${taskId}::uuid, ${`w-${rand()}`}, 'test', ${`buildd/${rand()}`}, 'completed', 4242, now() - ${`${daysAgo} days`}::interval)`);
}

const pinOf = async (taskId: string) => {
  const [r] = await q<{ src: any }>(sql`SELECT context->'specSource' AS src FROM tasks WHERE id = ${taskId}::uuid`);
  return r.src;
};

async function reviseTo(specId: string, body: string) {
  const [s] = await q<{ version: number }>(sql`SELECT version FROM specs WHERE id = ${specId}::uuid`);
  const r = await reviseSpecDraft(user(member), specId, { expectedVersion: s.version, body });
  if (!r.ok) throw new Error(r.error);
  return r.spec;
}

/** Approve the head as a person and run the after-response work to the end. */
async function approveHead(specId: string) {
  const [s] = await q<{ version: number; head_revision: number }>(sql`SELECT version, head_revision FROM specs WHERE id = ${specId}::uuid`);
  const queued: Array<() => Promise<unknown>> = [];
  const real = specApprovalDeps.afterResponse;
  specApprovalDeps.afterResponse = (t) => { queued.push(t); };
  try {
    const a = await approveSpecRevision(user(admin), specId, { revision: s.head_revision, expectedVersion: s.version });
    if (!a.ok || 'pending' in a) throw new Error('approval did not commit');
    for (const t of queued) await t();
    return a.revision;
  } finally {
    specApprovalDeps.afterResponse = real;
  }
}

describe('R-36: filing against a draft pins it provisionally', () => {
  test('no approved revision, no revision named: the head is pinned with its hash, provisional', async () => {
    const spec = await draftSpec();
    const p = await pinSpecSource(wsA, { specSource: { specId: spec.id } });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.context.specSource).toMatchObject({ specId: spec.id, revision: 1, contentHash: sha(BODY_1), provisional: true });
    expect(typeof (p.context.specSource as any).specRevisionId).toBe('string');
  });

  test('a draft revision named by number is pinned exactly, even with an older approved revision', async () => {
    const spec = await draftSpec();
    await approveHead(spec.id);
    await reviseTo(spec.id, BODY_2);
    const p = await pinSpecSource(wsA, { specSource: { specId: spec.id, revision: 2 } });
    expect(p.ok && p.context.specSource).toMatchObject({ revision: 2, contentHash: sha(BODY_2), provisional: true });
    // No revision named on an approved spec: the approved one, as in §6.
    const q2 = await pinSpecSource(wsA, { specSource: { specId: spec.id } });
    expect(q2.ok && q2.context.specSource).toMatchObject({ revision: 1 });
    expect(q2.ok && (q2.context.specSource as any).provisional).toBeUndefined();
  });

  test('a revision that does not exist is refused', async () => {
    const spec = await draftSpec();
    expect(await pinSpecSource(wsA, { specSource: { specId: spec.id, revision: 9 } })).toMatchObject({ ok: false, status: 409 });
  });

  test('a filer cannot mark an approved pin provisional', async () => {
    const spec = await draftSpec();
    await approveHead(spec.id);
    const p = await pinSpecSource(wsA, { specSource: { specId: spec.id, provisional: true } });
    expect(p.ok && (p.context.specSource as any).provisional).toBeUndefined();
  });
});

describe('R-37: at first claim a provisional pin moves only to a newer approved revision', () => {
  test('still unapproved: it stays; approved since: it moves and stops being provisional', async () => {
    const spec = await draftSpec();
    const p = await pinSpecSource(wsA, { specSource: { specId: spec.id } });
    if (!p.ok) throw new Error(p.error);
    const id = await insertTask(p.context);
    const stay = await repinSpecAtClaim({ id, workspaceId: wsA, context: p.context, taskClass: 'work' });
    expect(stay.specSource).toBeNull();

    await reviseTo(spec.id, BODY_2);
    const rev2 = await approveHead(spec.id);
    // The approval already re-pinned the stored task; a claim reading the
    // filed context (stale) moves it the same way.
    const moved = await repinSpecAtClaim({ id: await insertTask(p.context), workspaceId: wsA, context: p.context, taskClass: 'work' });
    expect(moved.specSource).toMatchObject({ specRevisionId: rev2.id, revision: 2, pinnedAt: 'claim', repinnedFrom: 1 });
    expect(moved.specSource?.provisional).toBeUndefined();
  });

  test('built against draft 2 while revision 1 is approved: the claim keeps revision 2', async () => {
    const spec = await draftSpec();
    await approveHead(spec.id);
    await reviseTo(spec.id, BODY_2);
    const p = await pinSpecSource(wsA, { specSource: { specId: spec.id, revision: 2 } });
    if (!p.ok) throw new Error(p.error);
    const r = await repinSpecAtClaim({ id: await insertTask(p.context), workspaceId: wsA, context: p.context, taskClass: 'work' });
    expect(r.specSource).toBeNull();
    expect(r.reason).toMatch(/not newer/);
  });
});

describe('R-39/R-40/R-41: approval re-pins and re-grades provisional work', () => {
  test('both tasks move to M, get a check run at their head, a note with the diff and new PR text; a second run does nothing', async () => {
    const spec = await draftSpec();
    const t1 = await shippedProvisional(spec.id);
    const t2 = await shippedProvisional(spec.id);
    await reviseTo(spec.id, BODY_2);
    const before = woken.length;
    const rev2 = await approveHead(spec.id);

    for (const t of [t1, t2]) {
      const src = await pinOf(t);
      expect(src).toMatchObject({ specRevisionId: rev2.id, revision: 2, contentHash: sha(BODY_2), regradedFrom: { revision: 1, contentHash: sha(BODY_1) } });
      expect(src.provisional).toBeUndefined();
      const notes = await q<{ title: string; body: string }>(sql`SELECT title, body FROM mission_notes WHERE task_id = ${t}::uuid`);
      expect(notes).toHaveLength(1);
      expect(notes[0].title).toContain('revision 2');
      expect(notes[0].body).toContain('-R-2: Rates are cached for 15 minutes.');
      expect(notes[0].body).toContain('+R-2: Rates are cached for 10 minutes.');
      const runs = await q<{ id: string }>(sql`SELECT id FROM tasks WHERE context->'specCriterionCheck'->>'subjectTaskId' = ${t}
        AND context->'specCriterionCheck'->>'specRevisionId' = ${rev2.id} AND context->'specCriterionCheck'->>'headSha' = ${HEAD}`);
      expect(runs).toHaveLength(1);
      expect(prEdits.find((e) => e.taskId === t)?.body).toContain('re-graded against approved revision 2');
    }
    expect(woken.length - before).toBe(2);

    // Idempotent: running the re-grade again moves nothing and posts nothing.
    const again = await regradeProvisionalPins(spec.id, 2);
    expect(again.regraded).toHaveLength(0);
    const notes = await q(sql`SELECT id FROM mission_notes WHERE task_id IN (${t1}::uuid, ${t2}::uuid)`);
    expect(notes).toHaveLength(2);
  });

  test('two re-grades racing move each pin once and post one note', async () => {
    const spec = await draftSpec();
    const t = await shippedProvisional(spec.id);
    await reviseTo(spec.id, BODY_2);
    // Approve without running the after-response work, then race two re-grades.
    const [s] = await q<{ version: number }>(sql`SELECT version FROM specs WHERE id = ${spec.id}::uuid`);
    const real = specApprovalDeps.afterResponse;
    specApprovalDeps.afterResponse = () => {};
    try {
      const a = await approveSpecRevision(user(admin), spec.id, { revision: 2, expectedVersion: s.version });
      if (!a.ok) throw new Error(a.error);
    } finally {
      specApprovalDeps.afterResponse = real;
    }
    const [r1, r2] = await Promise.all([regradeProvisionalPins(spec.id, 2), regradeProvisionalPins(spec.id, 2)]);
    expect(r1.regraded.length + r2.regraded.length).toBe(1);
    expect(await q(sql`SELECT id FROM mission_notes WHERE task_id = ${t}::uuid`)).toHaveLength(1);
  });

  test('a verdict carries over only when the criterion text is unchanged', async () => {
    const spec = await draftSpec();
    const t = await shippedProvisional(spec.id);
    for (const criterionId of ['R-1', 'R-2']) {
      const v = await recordSpecVerdict(user(admin), t, { criterionId, verdict: 'pass', headSha: HEAD });
      if (!v.ok) throw new Error(v.error);
    }
    await reviseTo(spec.id, BODY_2);
    await approveHead(spec.id);

    const o = await readGovernedOutcome(user(admin), t);
    if (!o.ok) throw new Error(o.error);
    expect(o.outcome.revision).toBe(2);
    const byId = new Map(o.outcome.criteria.map((c) => [c.criterionId, c.verdict]));
    expect(byId.get('R-1')).toBe('pass');
    expect(byId.get('R-2')).toBeNull();
    const [carried] = await q<{ evidence: any }>(sql`SELECT evidence FROM spec_outcome_verdicts
      WHERE task_id = ${t}::uuid AND criterion_id = 'R-1' AND spec_revision_id = ${o.outcome.specRevisionId}::uuid`);
    expect(carried.evidence.carriedFrom).toMatchObject({ revision: 1 });
  });

  test('a scope keeps only the ids M still has', async () => {
    const spec = await draftSpec();
    const t = await shippedProvisional(spec.id, { criteria: ['R-1', 'R-2'] });
    await reviseTo(spec.id, `# Checkout\nR-1: Totals are in the shopper currency.\n  check: \`${CHECK}\`\n`);
    await approveHead(spec.id);
    expect((await pinOf(t)).criteria).toEqual(['R-1']);
  });
});

describe('R-42: merged provisional work nobody approved needs a person', () => {
  test('an approver sees one item after 3 days; a plain member none; approving clears it', async () => {
    const { workspaceId: ws } = { workspaceId: wsA };
    const spec = await draftSpec();
    await shippedProvisional(spec.id, { mergedDaysAgo: 4 });
    await shippedProvisional(spec.id, { mergedDaysAgo: 5 });
    const items = (await loadProvisionalNeedsYou(admin, [ws])).filter((i) => i.specId === spec.id);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'spec_provisional', fixHref: `/app/specs/${spec.id}` });
    expect(items[0].failureMessage).toContain('2 merged tasks');
    expect(items[0].failureMessage).toContain('revision 1');
    expect((await loadProvisionalNeedsYou(member, [ws])).filter((i) => i.specId === spec.id)).toHaveLength(0);

    await approveHead(spec.id);
    expect((await loadProvisionalNeedsYou(admin, [ws])).filter((i) => i.specId === spec.id)).toHaveLength(0);
  });

  test('merged one day ago: not yet', async () => {
    const spec = await draftSpec();
    await shippedProvisional(spec.id, { mergedDaysAgo: 1 });
    expect((await loadProvisionalNeedsYou(admin, [wsA])).filter((i) => i.specId === spec.id)).toHaveLength(0);
  });
});

describe('R-43: attach_provisional is a person\'s or an admin\'s act', () => {
  test('an agent run and a plain API key are refused and the task is untouched', async () => {
    const spec = await draftSpec();
    const t = await insertTask({}, 'completed');
    for (const caller of [agentToken(), apiKey()]) {
      expect(await attachProvisional(caller, spec.id, { revision: 1, taskIds: [t] })).toMatchObject({ ok: false, status: 403 });
    }
    expect(await pinOf(t)).toBeNull();
  });

  test('a person attaches finished work; a pending or already-pinned task is not attached; a later approval re-grades it', async () => {
    const spec = await draftSpec();
    const done = await insertTask({ baseBranch: 'dev' }, 'completed');
    await merged(done, 0);
    const pending = await insertTask({}, 'pending');
    const r = await attachProvisional(user(admin), spec.id, { revision: 1, taskIds: [done, pending] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.results.find((x) => x.taskId === done)).toMatchObject({ attached: true });
    expect(r.results.find((x) => x.taskId === pending)).toMatchObject({ attached: false });
    expect(await pinOf(done)).toMatchObject({ specId: spec.id, revision: 1, provisional: true, attachedBy: `user:${admin}` });
    expect(await pinOf(pending)).toBeNull();

    const again = await attachProvisional(user(admin), spec.id, { revision: 1, taskIds: [done] });
    expect(again.ok && again.results[0]).toMatchObject({ attached: false });

    await reviseTo(spec.id, BODY_2);
    await approveHead(spec.id);
    expect(await pinOf(done)).toMatchObject({ revision: 2, regradedFrom: { revision: 1 } });
  });

  test('an admin token may attach', async () => {
    const spec = await draftSpec();
    const t = await insertTask({}, 'completed');
    const r = await attachProvisional(adminKey(), spec.id, { revision: 1, taskIds: [t] });
    expect(r.ok && r.results[0]).toMatchObject({ attached: true });
  });
});
