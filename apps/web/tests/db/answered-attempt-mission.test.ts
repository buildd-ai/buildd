/**
 * An answered question that cannot resume stays the SAME task, on real
 * Postgres (docs/specs/answered-question-resume.md, "The cold fallback",
 * AC-49 / AC-50 / AC-52 / AC-56 / AC-16).
 *
 * The case an owner reported: a mission of three tasks, task 03 depending on
 * task 02. Task 02's worker parked on a question and could not be resumed, and
 * answering it used to insert a fourth, `Continue:` task — the mission grew a
 * card nobody planned, and task 02 stayed open forever with task 03 waiting on
 * it. Now the answer reopens task 02 itself for a new attempt. The SQL guards
 * (open status, not kernel-merged, not a delivery owner, no other live attempt)
 * and the dependency gate are only observable on real rows.
 */
import { beforeAll, describe, expect, mock, setDefaultTimeout, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import { assertDbConfigured, q, seedMission, seedTask, seedWorkspace } from './harness';

let currentUserId: string | null = null;
const realAuthHelpers = await import('../../src/lib/auth-helpers');
mock.module('../../src/lib/auth-helpers', () => ({
  ...realAuthHelpers,
  getCurrentUser: async () => (currentUserId ? { id: currentUserId, email: 'owner@example.test' } : null),
}));

const respondRoute = await import('../../src/app/api/workers/[id]/respond/route');
const { cleanupUnresumedAnswers } = await import('../../src/lib/stale-workers');
const { enqueueReadyDependents } = await import('@buildd/core/dispatch-dependents');
const { depsGate } = await import('../../src/app/api/workers/claim/deps-gate');

setDefaultTimeout(30_000);
beforeAll(() => assertDbConfigured());

const rand = () => crypto.randomUUID().replace(/-/g, '').slice(0, 10);
const QUESTION = { type: 'question', prompt: 'Which output format should the parser emit?', options: ['JSON lines', 'CSV'] };

/** The screenshot case: tasks 01 (done), 02 (its worker parked on a question), 03 (depends on 02). */
async function world(opts: { workerStatus?: string; task02Status?: string } = {}) {
  const { teamId, workspaceId } = await seedWorkspace();
  const [u] = await q<{ id: string }>(sql`INSERT INTO users (email) VALUES (${`u-${rand()}@example.test`}) RETURNING id`);
  await q(sql`INSERT INTO team_members (team_id, user_id, role) VALUES (${teamId}::uuid, ${u.id}::uuid, 'owner')`);
  currentUserId = u.id;
  const key = `k-${rand()}`;
  const [acct] = await q<{ id: string }>(sql`
    INSERT INTO accounts (type, name, api_key, team_id, auth_type, level, max_concurrent_workers)
    VALUES ('user', ${key}, ${key}, ${teamId}::uuid, 'api', 'worker', 5) RETURNING id`);
  const missionId = await seedMission(teamId, workspaceId);
  const t01 = await seedTask(workspaceId, { missionId, status: 'completed', title: '01 · read the feed' });
  const t02 = await seedTask(workspaceId, { missionId, status: opts.task02Status ?? 'in_progress', title: '02 · build the parser', dependsOn: [t01] });
  const t03 = await seedTask(workspaceId, { missionId, status: 'pending', title: '03 · wire the parser in', dependsOn: [t02] });
  await q(sql`UPDATE tasks SET claimed_by = ${acct.id}::uuid, claimed_at = now(), context = '{"iteration":1}'::jsonb WHERE id = ${t02}::uuid`);
  // An AskUserQuestion abort leaves the worker `error` with its question open:
  // the answer fails G1 (worker_not_parked) and goes cold.
  const [w] = await q<{ id: string }>(sql`
    INSERT INTO workers (workspace_id, task_id, account_id, name, runner, branch, status, waiting_for, milestones, turns)
    VALUES (${workspaceId}::uuid, ${t02}::uuid, ${acct.id}::uuid, 'w-02', 'test-runner', 'buildd/02-build-the-parser',
      ${opts.workerStatus ?? 'error'}, ${JSON.stringify(QUESTION)}::jsonb,
      ${JSON.stringify([{ label: 'Wrote the reader', timestamp: 1 }])}::jsonb, 30)
    RETURNING id`);
  return { teamId, workspaceId, accountId: acct.id, missionId, t01, t02, t03, workerId: w.id };
}

function answer(workerId: string, message: string) {
  return respondRoute.POST(
    new NextRequest(`http://localhost/api/workers/${workerId}/respond`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message }),
    }),
    { params: Promise.resolve({ id: workerId }) },
  );
}

const missionTaskCount = async (missionId: string) =>
  Number((await q<{ n: string }>(sql`SELECT count(*)::text AS n FROM tasks WHERE mission_id = ${missionId}::uuid`))[0].n);
const taskRow = async (id: string) =>
  (await q<{ status: string; claimed_by: string | null; context: any; title: string }>(sql`SELECT status, claimed_by, context, title FROM tasks WHERE id = ${id}::uuid`))[0];
const workerRow = async (id: string) =>
  (await q<{ status: string; waiting_for: unknown; continuation_task_id: string | null; completed_at: string | null }>(sql`SELECT status, waiting_for, continuation_task_id, completed_at FROM workers WHERE id = ${id}::uuid`))[0];

describe('a cold answer on a mission task stays that task (the screenshot case)', () => {
  test('the mission keeps three tasks; task 02 is reopened with the answer; task 03 stays blocked until 02 completes', async () => {
    const s = await world();
    expect(await missionTaskCount(s.missionId)).toBe(3);

    const res = await answer(s.workerId, 'JSON lines, one object per row');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ path: 'cold_continuation', reasonCode: 'worker_not_parked', taskId: s.t02, newAttempt: true });

    // AC-50: no task inserted, no `Continue:` card.
    expect(await missionTaskCount(s.missionId)).toBe(3);
    expect((await q(sql`SELECT 1 FROM tasks WHERE mission_id = ${s.missionId}::uuid AND title LIKE 'Continue:%'`)).length).toBe(0);

    // AC-49: the same row, back in the queue, carrying the answer.
    const t02 = await taskRow(s.t02);
    expect(t02.status).toBe('pending');
    expect(t02.claimed_by).toBeNull();
    expect(t02.context.answeredQuestions).toHaveLength(1);
    expect(t02.context.answeredQuestions[0]).toMatchObject({
      workerId: s.workerId,
      question: QUESTION.prompt,
      answer: 'JSON lines, one object per row',
      reasonCode: 'worker_not_parked',
      milestones: ['Wrote the reader'],
    });
    expect(t02.context.resumeBranch).toBe('buildd/02-build-the-parser');
    expect(t02.context.iteration).toBe(2);
    expect(t02.context.answerDelivery).toMatchObject({ path: 'cold_continuation', continuation: 'same_task' });

    // The answered attempt ended as superseded, pointing at no other task.
    const w = await workerRow(s.workerId);
    expect(w.status).toBe('superseded');
    expect(w.waiting_for).toBeNull();
    expect(w.continuation_task_id).toBeNull();
    expect(w.completed_at).not.toBeNull();

    // Attempt history is this task's workers, nothing anywhere else.
    expect((await q(sql`SELECT id FROM workers WHERE task_id = ${s.t02}::uuid`)).length).toBe(1);

    // The new attempt is woken as a requeue of task 02.
    const wakes = await q<{ causes: string[] }>(sql`SELECT causes FROM task_dispatch_outbox WHERE task_id = ${s.t02}::uuid`);
    expect(wakes.some((r) => r.causes.includes('task.requeued'))).toBe(true);

    // One feed note on task 02 naming the path and why (AC-15).
    const notes = await q<{ body: string }>(sql`SELECT body FROM mission_notes WHERE task_id = ${s.t02}::uuid`);
    expect(notes).toHaveLength(1);
    expect(notes[0].body).toContain('new attempt of this task');

    // Task 03 is not unblocked by the answer: 02 is not done.
    expect(await enqueueReadyDependents(s.t02, depsGate())).toEqual([]);
    expect((await taskRow(s.t03)).status).toBe('pending');
    // Only a completed attempt of 02 releases it.
    await q(sql`UPDATE tasks SET status = 'completed', updated_at = now() WHERE id = ${s.t02}::uuid`);
    expect(await enqueueReadyDependents(s.t02, depsGate())).toEqual([s.t03]);
  });

  test('a second answer is told what was recorded and changes nothing (AC-56)', async () => {
    const s = await world();
    expect((await answer(s.workerId, 'JSON lines')).status).toBe(200);
    const before = await taskRow(s.t02);

    const res = await answer(s.workerId, 'CSV');
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toMatchObject({ reasonCode: 'already_answered', nextAction: { kind: 'refresh' }, taskId: s.t02, recordedAnswer: 'JSON lines' });

    expect(await missionTaskCount(s.missionId)).toBe(3);
    const after = await taskRow(s.t02);
    expect(after.context.answeredQuestions).toHaveLength(1);
    expect(after.context.iteration).toBe(before.context.iteration);
  });

  test('an answer never reopens a cancelled task, and leaves the question open (AC-52)', async () => {
    const s = await world({ task02Status: 'cancelled' });
    const res = await answer(s.workerId, 'JSON lines');
    expect(res.status).toBe(409);
    expect((await res.json()).reasonCode).toBe('task_closed');
    expect((await taskRow(s.t02)).status).toBe('cancelled');
    const w = await workerRow(s.workerId);
    expect(w.status).toBe('error');
    expect(w.waiting_for).not.toBeNull();
    expect(await missionTaskCount(s.missionId)).toBe(3);
  });

  test('another live attempt on the task keeps it: the answer is refused and the question restored', async () => {
    const s = await world();
    await q(sql`
      INSERT INTO workers (workspace_id, task_id, account_id, name, runner, branch, status)
      VALUES (${s.workspaceId}::uuid, ${s.t02}::uuid, ${s.accountId}::uuid, 'w-02b', 'test-runner', 'buildd/02-build-the-parser', 'running')`);
    const res = await answer(s.workerId, 'JSON lines');
    expect(res.status).toBe(409);
    expect((await res.json()).reasonCode).toBe('not_reopenable');
    const w = await workerRow(s.workerId);
    expect(w.status).toBe('error');
    expect(w.waiting_for).not.toBeNull();
    expect((await taskRow(s.t02)).status).toBe('in_progress');
  });
});

describe('the unacknowledged-resume sweep stays on the same task (AC-16)', () => {
  test('a queued answer past its deadline reopens task 02, not a new task', async () => {
    const s = await world({ workerStatus: 'waiting_input' });
    const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await q(sql`UPDATE workers SET waiting_for = NULL, pending_instructions = 'JSON lines' WHERE id = ${s.workerId}::uuid`);
    await q(sql`UPDATE tasks SET context = ${JSON.stringify({
      iteration: 1,
      answerDelivery: { path: 'resume', reasonCode: 'resume_eligible', reason: 'r', workerId: s.workerId, decidedAt: past, ackDeadlineAt: past, question: QUESTION.prompt },
    })}::jsonb WHERE id = ${s.t02}::uuid`);

    const r = await cleanupUnresumedAnswers(s.accountId);
    expect(r.degraded).toBe(1);

    expect(await missionTaskCount(s.missionId)).toBe(3);
    const t02 = await taskRow(s.t02);
    expect(t02.status).toBe('pending');
    expect(t02.context.answeredQuestions[0]).toMatchObject({ answer: 'JSON lines', question: QUESTION.prompt, reasonCode: 'resume_not_acknowledged' });
    expect(t02.context.answerDelivery.ackDeadlineAt).toBeUndefined();
    expect((await workerRow(s.workerId)).status).toBe('superseded');

    // Idempotent: a second pass finds nothing to degrade.
    expect((await cleanupUnresumedAnswers(s.accountId)).degraded).toBe(0);
    expect((await taskRow(s.t02)).context.answeredQuestions).toHaveLength(1);
    expect(await enqueueReadyDependents(s.t02, depsGate())).toEqual([]);
  });
});
