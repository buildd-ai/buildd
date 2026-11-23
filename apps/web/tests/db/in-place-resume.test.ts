/**
 * Resume in place on real Postgres (docs/specs/in-place-resume.md).
 *
 * The guarantees that matter are WHERE clauses: the step from "pausing" to
 * "resuming" is taken once, the resume message is queued once on the SAME
 * worker row, and a task never ends up with two live workers. A mocked `db`
 * shows none of that.
 */
import { beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { assertDbConfigured, q, seedTask, seedWorkspace } from './harness';

const {
  buildInPlaceResumeIntent, loadLiveWorkerForResume, loadTaskForResume, resumeAfterPause, settleOnReactivation, sweepInPlaceResumes,
} = await import('../../src/lib/in-place-resume');

setDefaultTimeout(30_000);
beforeAll(() => assertDbConfigured());

const rand = () => crypto.randomUUID().replace(/-/g, '').slice(0, 10);
const PAUSE = { type: 'pause', prompt: 'Paused.' };

async function world(opts: { workerStatus: 'running' | 'waiting_input'; cause?: 'model_change' | 'requeue'; requestedAt?: number }) {
  const { teamId, workspaceId } = await seedWorkspace();
  const key = `k-${rand()}`;
  const [acct] = await q<{ id: string }>(sql`
    INSERT INTO accounts (type, name, api_key, team_id, auth_type, level, max_concurrent_workers)
    VALUES ('user', ${key}, ${key}, ${teamId}::uuid, 'api', 'worker', 5) RETURNING id`);
  const taskId = await seedTask(workspaceId, { status: 'in_progress', title: 'read a large codebase' });
  const [w] = await q<{ id: string }>(sql`
    INSERT INTO workers (workspace_id, task_id, account_id, name, runner, branch, status, waiting_for, supports_instruction_ack)
    VALUES (${workspaceId}::uuid, ${taskId}::uuid, ${acct.id}::uuid, 'w-live', 'test-runner', 'buildd/in-place',
      ${opts.workerStatus}, ${opts.workerStatus === 'waiting_input' ? JSON.stringify(PAUSE) : null}::jsonb, true)
    RETURNING id`);
  const intent = buildInPlaceResumeIntent({
    workerId: w.id, cause: opts.cause ?? 'model_change', phase: 'pausing',
    fromTier: 'standard', fromModel: 'model-a', toTier: 'premium', toModel: 'model-b', now: opts.requestedAt,
  });
  const context = { model: 'model-a', resolvedTier: { tier: 'standard', provider: 'anthropic' }, inPlaceResume: intent, pendingModelChange: { workerId: w.id, resolvedModel: 'model-b' } };
  await q(sql`UPDATE tasks SET claimed_by = ${acct.id}::uuid, claimed_at = now(), predicted_model = 'model-a', context = ${JSON.stringify(context)}::jsonb WHERE id = ${taskId}::uuid`);
  return { taskId, workerId: w.id };
}

const taskRow = async (taskId: string) =>
  (await q<{ status: string; claimed_by: string | null; predicted_model: string | null; context: Record<string, any> }>(
    sql`SELECT status, claimed_by, predicted_model, context FROM tasks WHERE id = ${taskId}::uuid`))[0];
const workerRows = (taskId: string) =>
  q<{ id: string; status: string; waiting_for: unknown; pending_instructions: string | null; error: string | null }>(
    sql`SELECT id, status, waiting_for, pending_instructions, error FROM workers WHERE task_id = ${taskId}::uuid`);

async function park(taskId: string) {
  const worker = (await loadLiveWorkerForResume(taskId))!;
  const task = (await loadTaskForResume(taskId))!;
  return resumeAfterPause({ worker, task });
}

describe('resume in place', () => {
  test('a worker that parked for a model change is resumed once, on its own row', async () => {
    const { taskId, workerId } = await world({ workerStatus: 'waiting_input' });

    // The worker PATCH and the sweep can both see the park: one of them resumes it.
    const results = await Promise.all([park(taskId), park(taskId), park(taskId)]);
    expect(results.filter(Boolean)).toHaveLength(1);

    const workers = await workerRows(taskId);
    expect(workers).toHaveLength(1);
    expect(workers[0].id).toBe(workerId);
    expect(workers[0].status).toBe('waiting_input');
    expect(workers[0].waiting_for).toBeNull();
    // One message, not three.
    expect(workers[0].pending_instructions!.match(/same session/g)).toHaveLength(1);
    expect(workers[0].pending_instructions).toContain('You now run on model-b');

    const task = await taskRow(taskId);
    expect(task.status).toBe('in_progress');
    expect(task.claimed_by).not.toBeNull();
    expect(task.context.inPlaceResume.phase).toBe('resuming');
    expect(task.context.answerDelivery).toMatchObject({ path: 'resume', workerId });
    expect(task.context.model).toBe('model-a');

    // A later park report finds the step taken and queues nothing more.
    expect(await park(taskId)).toBe(false);
  });

  test('the runner resume call settles it: new model on the task, one live worker, the outcome recorded', async () => {
    const { taskId, workerId } = await world({ workerStatus: 'waiting_input' });
    await park(taskId);

    const settled = await settleOnReactivation({ worker: { id: workerId }, task: (await loadTaskForResume(taskId))!, runnerTakesModel: true });
    expect(settled).toEqual({ sessionModel: 'model-b' });

    const task = await taskRow(taskId);
    expect(task.context.inPlaceResume).toBeUndefined();
    expect(task.context.pendingModelChange).toBeUndefined();
    expect(task.context.model).toBe('model-b');
    expect(task.context.resolvedTier).toEqual({ tier: 'premium', provider: 'anthropic' });
    expect(task.predicted_model).toBe('model-b');
    expect(task.context.resumeHistory.at(-1)).toMatchObject({ kind: 'resumed_in_place', workerId, fromModel: 'model-a', toModel: 'model-b' });
    expect(await workerRows(taskId)).toHaveLength(1);

    const notes = await q<{ title: string; body: string }>(sql`SELECT title, body FROM mission_notes WHERE task_id = ${taskId}::uuid`);
    expect(notes.map(n => n.title)).toContain('Resumed in place');
    expect(notes.find(n => n.title === 'Resumed in place')!.body).toContain('model-a → model-b');
  });

  test('a pause a person asked for is left paused', async () => {
    const { taskId } = await world({ workerStatus: 'waiting_input' });
    await q(sql`UPDATE tasks SET context = context - 'inPlaceResume' WHERE id = ${taskId}::uuid`);
    expect(await park(taskId)).toBe(false);
    const [w] = await workerRows(taskId);
    expect(w.waiting_for).toMatchObject({ type: 'pause' });
    expect(w.pending_instructions).toBeNull();
  });

  test('the sweep resumes a worker that parked before its intent was written', async () => {
    const { taskId } = await world({ workerStatus: 'waiting_input' });
    await sweepInPlaceResumes();
    const [w] = await workerRows(taskId);
    expect(w.pending_instructions).toContain('same session');
    expect((await taskRow(taskId)).context.inPlaceResume.phase).toBe('resuming');
  });

  test('a requeue whose pause is never reached takes the new attempt: worker ended, task back in the queue, reason kept', async () => {
    const { taskId, workerId } = await world({ workerStatus: 'running', cause: 'requeue', requestedAt: Date.now() - 24 * 60 * 60_000 });
    await sweepInPlaceResumes();

    const [w] = await workerRows(taskId);
    expect(w.status).toBe('failed');
    const task = await taskRow(taskId);
    expect(task.status).toBe('pending');
    expect(task.claimed_by).toBeNull();
    expect(task.context.inPlaceResume).toBeUndefined();
    expect(task.context.resumeHistory.at(-1)).toMatchObject({ kind: 'new_attempt', cause: 'requeue', workerId, reasonCode: 'pause_not_reached' });
  });

  test('a model change whose pause is never reached leaves the worker running and waits for the next attempt', async () => {
    const { taskId } = await world({ workerStatus: 'running', requestedAt: Date.now() - 24 * 60 * 60_000 });
    await sweepInPlaceResumes();
    const [w] = await workerRows(taskId);
    expect(w.status).toBe('running');
    const task = await taskRow(taskId);
    expect(task.status).toBe('in_progress');
    expect(task.context.inPlaceResume).toBeUndefined();
    expect(task.context.pendingModelChange).toBeDefined();
    expect(task.context.resumeHistory.at(-1)).toMatchObject({ kind: 'new_attempt', cause: 'model_change', reasonCode: 'pause_not_reached' });
  });
});
