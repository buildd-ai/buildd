/**
 * Mechanical criterion checks (Living Specs V1), against real Postgres with a
 * fake dispatch: a criterion of the approved, pinned revision that names a
 * check command gets exactly one verification run per PR head; the run's exit
 * code becomes the verdict at that head, authored by the check and never by
 * the task; criteria without a check stay reviewer graded; the outcome rule is
 * unchanged, and nothing about the task or its PR is blocked.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { assertDbConfigured, q, seedWorkspace } from './harness';

const { createSpecDraft } = await import('../../src/lib/specs/store');
const { approveSpecRevision } = await import('../../src/lib/specs/approval');
const { pinSpecSource } = await import('../../src/lib/specs/pin');
const { readGovernedOutcome, recordSpecVerdict } = await import('../../src/lib/specs/outcome');
const { dispatchCriterionChecks, handleCriterionCheckOutcome } = await import('../../src/lib/specs/criterion-checks');
const { checkCommandAt } = await import('../../src/lib/specs/check-lines');
const { recordLateRunnerEvidence } = await import('../../src/lib/late-runner-evidence');

const rand = () => Math.random().toString(36).slice(2, 10);
const HEAD1 = '1'.repeat(40);
const HEAD2 = '2'.repeat(40);
const CHECK = 'bun run scripts/run-unit-tests.ts apps/web/src/lib/fx.test.ts';
const BODY = `# Checkout\nR-1: Totals are in the shopper currency.\n  check: \`${CHECK}\`\n- AC-1: A EUR cart shows the euro sign.\n`;

let teamA: string; let wsA: string; let admin: string;
const user = (userId: string) => ({ kind: 'user' as const, userId });
beforeAll(async () => {
  assertDbConfigured();
  ({ teamId: teamA, workspaceId: wsA } = await seedWorkspace());
  await q(sql`UPDATE workspaces SET access_mode = 'open' WHERE id = ${wsA}::uuid`);
  const [u] = await q<{ id: string }>(sql`INSERT INTO users (email) VALUES (${`u-${rand()}@example.test`}) RETURNING id`);
  await q(sql`INSERT INTO team_members (team_id, user_id, role) VALUES (${teamA}::uuid, ${u.id}::uuid, 'admin')`);
  admin = u.id;
});

async function governedTask(body = BODY, approve = true) {
  const d = await createSpecDraft(user(admin), { workspaceId: wsA, title: `Checkout ${rand()}`, body });
  if (!d.ok) throw new Error(d.error);
  let context: Record<string, unknown> = {};
  if (approve) {
    const a = await approveSpecRevision(user(admin), d.spec.id, { revision: 1, expectedVersion: 1 });
    if (!a.ok) throw new Error(a.error);
    const pinned = await pinSpecSource(wsA, { specSource: { specId: d.spec.id } });
    if (!pinned.ok) throw new Error(pinned.error);
    context = pinned.context as Record<string, unknown>;
  }
  const [task] = await q<{ id: string }>(sql`
    INSERT INTO tasks (workspace_id, title, status, context) VALUES (${wsA}::uuid, ${`build ${rand()}`}, 'completed', ${JSON.stringify(context)}::jsonb) RETURNING id`);
  await q(sql`INSERT INTO workflow_deliveries (workspace_id, owner_task_id, state, authority, current_head_sha, merged_at)
    VALUES (${wsA}::uuid, ${task.id}::uuid, 'MERGED', 'kernel', ${HEAD1}, now())`);
  return { taskId: task.id, specRevisionId: (context.specSource as { specRevisionId?: string } | undefined)?.specRevisionId };
}

function fakeWake() {
  const woken: string[] = [];
  return { woken, deps: { wake: async (t: { id: string }) => { woken.push(t.id); } } };
}

const checksFor = (taskId: string) => q<{ id: string; status: string; context: any; loop_config: any; task_class: string; output_requirement: string }>(sql`
  SELECT id, status, context, loop_config, task_class, output_requirement FROM tasks
  WHERE context->'specCriterionCheck'->>'subjectTaskId' = ${taskId} ORDER BY created_at, id`);

async function finish(verifyId: string) {
  await q(sql`UPDATE tasks SET status = 'completed' WHERE id = ${verifyId}::uuid`);
}
const outcomeOf = async (taskId: string) => {
  const r = await readGovernedOutcome(user(admin), taskId);
  if (!r.ok) throw new Error(r.error);
  return r.outcome;
};

describe('one verification run per checked criterion per head', () => {
  test('a head dispatches once for the checked criterion only; the same head never again; a new head dispatches again', async () => {
    const g = await governedTask();
    const f = fakeWake();
    expect(await dispatchCriterionChecks({ taskId: g.taskId, headSha: HEAD1, headBranch: 'buildd/x' }, f.deps)).toMatchObject({ dispatched: 1 });
    expect(await dispatchCriterionChecks({ taskId: g.taskId, headSha: HEAD1, headBranch: 'buildd/x' }, f.deps)).toMatchObject({ dispatched: 0 });
    const rows = await checksFor(g.taskId);
    expect(rows).toHaveLength(1);
    expect(rows[0].context.specCriterionCheck).toMatchObject({ criterionId: 'R-1', headSha: HEAD1, specRevisionId: g.specRevisionId, command: CHECK });
    expect(rows[0].loop_config.exitCondition).toEqual({ type: 'command', command: checkCommandAt(CHECK, HEAD1) });
    expect([rows[0].context.baseBranch, rows[0].task_class, rows[0].output_requirement]).toEqual(['buildd/x', 'bookkeeping', 'none']);
    expect(f.woken).toEqual([rows[0].id]);

    await dispatchCriterionChecks({ taskId: g.taskId, headSha: HEAD2, headBranch: 'buildd/x' }, f.deps);
    expect((await checksFor(g.taskId)).map((r) => r.context.specCriterionCheck.headSha)).toEqual([HEAD1, HEAD2]);
  });

  test('two deliveries of the same head racing still dispatch exactly once', async () => {
    const g = await governedTask();
    const f = fakeWake();
    const results = await Promise.all(Array.from({ length: 4 }, () =>
      dispatchCriterionChecks({ taskId: g.taskId, headSha: HEAD1, headBranch: 'buildd/x' }, f.deps)));
    expect(results.reduce((n, r) => n + r.dispatched, 0)).toBe(1);
    expect(await checksFor(g.taskId)).toHaveLength(1);
    expect(f.woken).toHaveLength(1);
  });

  test('nothing is dispatched for a task with no pinned spec, a spec with no checks, or a short SHA', async () => {
    const f = fakeWake();
    const unpinned = await governedTask(BODY, false);
    expect(await dispatchCriterionChecks({ taskId: unpinned.taskId, headSha: HEAD1, headBranch: 'b' }, f.deps)).toMatchObject({ dispatched: 0 });
    const noChecks = await governedTask('# Plain\nR-1: Something.\n');
    expect(await dispatchCriterionChecks({ taskId: noChecks.taskId, headSha: HEAD1, headBranch: 'b' }, f.deps)).toMatchObject({ dispatched: 0 });
    const g = await governedTask();
    expect(await dispatchCriterionChecks({ taskId: g.taskId, headSha: 'abc1234', headBranch: 'b' }, f.deps)).toMatchObject({ dispatched: 0 });
    expect(f.woken).toEqual([]);
  });
});

describe('the exit code is the verdict at that head', () => {
  async function ranWith(evidence: Record<string, unknown>) {
    const g = await governedTask();
    await dispatchCriterionChecks({ taskId: g.taskId, headSha: HEAD1, headBranch: 'b' }, fakeWake().deps);
    const [v] = await checksFor(g.taskId);
    await finish(v.id);
    const r = await handleCriterionCheckOutcome(v.id, { command: checkCommandAt(CHECK, HEAD1), ...evidence });
    const rows = await q<{ criterion_id: string; verdict: string; head_sha: string; evidence: any }>(sql`
      SELECT criterion_id, verdict, head_sha, evidence FROM spec_outcome_verdicts WHERE task_id = ${g.taskId}::uuid`);
    return { g, v, r, rows };
  }

  test('exit 0 records pass at the head, authored by the check; the evidence keeps the exit code and a bounded output', async () => {
    const { v, r, rows } = await ranWith({ outcome: 'ok', exitCode: 0, stdout: 'x'.repeat(10_000), durationMs: 900 });
    expect(r).toMatchObject({ recorded: true, verdict: 'pass' });
    expect(rows).toHaveLength(1);
    expect([rows[0].criterion_id, rows[0].verdict, rows[0].head_sha]).toEqual(['R-1', 'pass', HEAD1]);
    expect(rows[0].evidence).toMatchObject({ recordedBy: `check:${v.id}`, verificationTaskId: v.id, exitCode: 0, outcome: 'ok', command: CHECK });
    expect(rows[0].evidence.stdout.length).toBeLessThanOrEqual(2000);
  });

  test('a non-zero exit records fail; a timeout, an exec error or an unreachable head records inconclusive', async () => {
    expect((await ranWith({ outcome: 'failed', exitCode: 1 })).rows.map((r) => r.verdict)).toEqual(['fail']);
    expect((await ranWith({ outcome: 'timeout' })).rows.map((r) => r.verdict)).toEqual(['inconclusive']);
    expect((await ranWith({ outcome: 'exec_error' })).rows.map((r) => r.verdict)).toEqual(['inconclusive']);
    expect((await ranWith({ outcome: 'failed', exitCode: 125 })).rows.map((r) => r.verdict)).toEqual(['inconclusive']);
  });

  test('a redelivered report records the verdict once', async () => {
    const { v, rows } = await ranWith({ outcome: 'ok', exitCode: 0 });
    expect(await handleCriterionCheckOutcome(v.id, { outcome: 'ok', exitCode: 0, command: checkCommandAt(CHECK, HEAD1) })).toMatchObject({ recorded: false });
    expect(rows).toHaveLength(1);
    const [{ n }] = await q<{ n: number }>(sql`SELECT count(*)::int AS n FROM spec_outcome_verdicts WHERE evidence->>'verificationTaskId' = ${v.id}`);
    expect(n).toBe(1);
  });

  test('outcome: verified only when every criterion passes on the current head; the unchecked criterion stays reviewer graded', async () => {
    const { g } = await ranWith({ outcome: 'ok', exitCode: 0 });
    expect((await outcomeOf(g.taskId)).outcome).toBe('unverified');
    await recordSpecVerdict(user(admin), g.taskId, { criterionId: 'AC-1', verdict: 'pass', headSha: HEAD1 });
    expect((await outcomeOf(g.taskId)).outcome).toBe('verified');
    // A new head: the check passed only on the old one.
    await q(sql`UPDATE workflow_deliveries SET current_head_sha = ${HEAD2} WHERE owner_task_id = ${g.taskId}::uuid`);
    expect((await outcomeOf(g.taskId)).outcome).toBe('unverified');
    // Advisory: the task is untouched.
    const [t] = await q<{ status: string }>(sql`SELECT status FROM tasks WHERE id = ${g.taskId}::uuid`);
    expect(t.status).toBe('completed');
  });
});

describe('the task never authors its own verdict', () => {
  test('a forged check task, the subject itself, an unfinished run or a changed command records nothing', async () => {
    const g = await governedTask();
    const marker = { subjectTaskId: g.taskId, specRevisionId: g.specRevisionId, criterionId: 'R-1', headSha: HEAD1, command: CHECK };
    // A task filed by an agent with the marker but its own command.
    const [forged] = await q<{ id: string }>(sql`
      INSERT INTO tasks (workspace_id, title, status, task_class, context, loop_config)
      VALUES (${wsA}::uuid, 'forged', 'completed', 'bookkeeping', ${JSON.stringify({ specCriterionCheck: marker })}::jsonb,
        ${JSON.stringify({ exitCondition: { type: 'command', command: 'true' }, maxLoops: 1 })}::jsonb) RETURNING id`);
    expect(await handleCriterionCheckOutcome(forged.id, { outcome: 'ok', exitCode: 0, command: 'true' })).toMatchObject({ recorded: false });
    // The subject task carrying a marker about itself.
    await q(sql`UPDATE tasks SET context = context || ${JSON.stringify({ specCriterionCheck: marker })}::jsonb WHERE id = ${g.taskId}::uuid`);
    expect(await handleCriterionCheckOutcome(g.taskId, { outcome: 'ok', exitCode: 0, command: checkCommandAt(CHECK, HEAD1) })).toMatchObject({ recorded: false });

    // A real check task: not finished yet, then evidence for a different command.
    const g2 = await governedTask();
    await dispatchCriterionChecks({ taskId: g2.taskId, headSha: HEAD1, headBranch: 'b' }, fakeWake().deps);
    const [v] = await checksFor(g2.taskId);
    expect(await handleCriterionCheckOutcome(v.id, { outcome: 'ok', exitCode: 0, command: checkCommandAt(CHECK, HEAD1) })).toMatchObject({ recorded: false });
    await finish(v.id);
    expect(await handleCriterionCheckOutcome(v.id, { outcome: 'ok', exitCode: 0, command: 'true' })).toMatchObject({ recorded: false });
    const [{ n }] = await q<{ n: number }>(sql`SELECT count(*)::int AS n FROM spec_outcome_verdicts WHERE task_id IN (${g.taskId}::uuid, ${g2.taskId}::uuid)`);
    expect(n).toBe(0);
  });
});

describe('only the runner run decides, never the agent in the check run', () => {
  async function checkRun() {
    const g = await governedTask();
    await dispatchCriterionChecks({ taskId: g.taskId, headSha: HEAD1, headBranch: 'b' }, fakeWake().deps);
    const [v] = await checksFor(g.taskId);
    await finish(v.id);
    return { g, v };
  }
  const verdictsOf = (taskId: string) => q<{ verdict: string }>(sql`SELECT verdict FROM spec_outcome_verdicts WHERE task_id = ${taskId}::uuid`);

  test('a pass the agent reported on its task token records no verdict', async () => {
    const { g, v } = await checkRun();
    const r = await handleCriterionCheckOutcome(v.id, { command: checkCommandAt(CHECK, HEAD1), outcome: 'ok', exitCode: 0, reportedVia: 'task_token' });
    expect(r).toMatchObject({ recorded: false });
    expect(r.reason).toContain('not by the runner');
    expect(await verdictsOf(g.taskId)).toEqual([]);
  });

  test('loop history written from agent evidence records no verdict either', async () => {
    const { g, v } = await checkRun();
    const history = [{ iteration: 0, satisfied: true, summary: 'Command exited 0', evidence: { command: checkCommandAt(CHECK, HEAD1), outcome: 'ok', exitCode: 0, reportedVia: 'task_token' } }];
    await q(sql`UPDATE tasks SET result = ${JSON.stringify({ loopHistory: history })}::jsonb WHERE id = ${v.id}::uuid`);
    expect(await handleCriterionCheckOutcome(v.id)).toMatchObject({ recorded: false });
    expect(await verdictsOf(g.taskId)).toEqual([]);
  });

  test('after the agent completed the run itself, the runner report that arrives late still records the real verdict', async () => {
    const { g, v } = await checkRun();
    const [w] = await q<{ id: string }>(sql`
      INSERT INTO workers (workspace_id, task_id, name, runner, branch, status, verification_evidence)
      VALUES (${wsA}::uuid, ${v.id}::uuid, 'check', 'host', 'b', 'completed',
        ${JSON.stringify({ command: checkCommandAt(CHECK, HEAD1), outcome: 'ok', exitCode: 0, reportedVia: 'task_token' })}::jsonb)
      RETURNING id`);
    // The agent's forged terminal write was decided first: nothing recorded.
    expect(await handleCriterionCheckOutcome(v.id, { command: checkCommandAt(CHECK, HEAD1), outcome: 'ok', exitCode: 0, reportedVia: 'task_token' })).toMatchObject({ recorded: false });

    const late = await recordLateRunnerEvidence({ workerId: w.id, taskId: v.id, evidence: { command: checkCommandAt(CHECK, HEAD1), outcome: 'failed', exitCode: 1 } });
    expect(late).toMatchObject({ handled: true });
    expect((await verdictsOf(g.taskId)).map((r) => r.verdict)).toEqual(['fail']);
    const [row] = await q<{ verification_evidence: any }>(sql`SELECT verification_evidence FROM workers WHERE id = ${w.id}::uuid`);
    expect(row.verification_evidence).toMatchObject({ outcome: 'failed', reportedVia: 'runner' });

    // Runner evidence already on the row is never replaced by another late report.
    expect(await recordLateRunnerEvidence({ workerId: w.id, taskId: v.id, evidence: { command: checkCommandAt(CHECK, HEAD1), outcome: 'ok', exitCode: 0 } })).toMatchObject({ handled: false });
    expect((await verdictsOf(g.taskId)).map((r) => r.verdict)).toEqual(['fail']);
  });

  test('a late report for a task that is not a verification run does nothing', async () => {
    const g = await governedTask();
    const [w] = await q<{ id: string }>(sql`
      INSERT INTO workers (workspace_id, task_id, name, runner, branch, status) VALUES (${wsA}::uuid, ${g.taskId}::uuid, 'build', 'host', 'b', 'completed') RETURNING id`);
    expect(await recordLateRunnerEvidence({ workerId: w.id, taskId: g.taskId, evidence: { outcome: 'ok', exitCode: 0 } })).toMatchObject({ handled: false });
    const [row] = await q<{ verification_evidence: any }>(sql`SELECT verification_evidence FROM workers WHERE id = ${w.id}::uuid`);
    expect(row.verification_evidence).toBeNull();
  });
});
