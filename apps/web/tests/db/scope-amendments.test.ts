/**
 * Mission scope amendments on real Postgres (docs/specs/workflow-kernel-library.md
 * §6 "Scope amendments"; task f3bda4e1 scenarios 5–7): the decision is a
 * recorded fact a replay reads, and what it means is written in one
 * statement: nothing, an amendment that moves the mission's contract and its
 * scope version, or a hold on the task with one question for a person.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { q, seedMission, seedTask, seedWorkspace } from './harness';

const { decideTaskScope, resolveTaskScope } = await import('../../src/lib/workflow/scope-amendments');
const { postgresStore } = await import('../../src/lib/workflow/postgres-store');
type Decide = NonNullable<NonNullable<Parameters<typeof decideTaskScope>[1]>['decide']>;

const exec = (query: ReturnType<typeof sql>) => db.execute(query) as unknown as Promise<{ rows?: unknown[] }>;
const store = postgresStore(exec);

let missionId: string;
let workspaceId: string;
let calls = 0;
const answering = (verdict: string, confidence = 0.95): Decide => ({
  id: 'test-decider@1',
  decide: async (point) => { calls++; expect(point).toBe('mission_scope'); return { verdict, confidence, reason: `said ${verdict}` }; },
});

const CRITERIA = [{ type: 'command', command: 'bun run test', label: 'tests pass' }, { type: 'all_prs_merged' }];

async function mission() {
  return (await q<{ description: string | null; goal_criteria: unknown; scope_version: number }>(
    sql`SELECT description, goal_criteria, scope_version FROM missions WHERE id = ${missionId}::uuid`))[0]!;
}
async function addTask(title: string, context: Record<string, unknown> = {}) {
  const id = await seedTask(workspaceId, { missionId, title });
  await q(sql`UPDATE tasks SET task_class = 'work', mode = 'execution', creation_source = 'mcp', context = ${JSON.stringify(context)}::jsonb WHERE id = ${id}::uuid`);
  return id;
}

beforeEach(async () => {
  calls = 0;
  const ws = await seedWorkspace();
  workspaceId = ws.workspaceId;
  missionId = await seedMission(ws.teamId, ws.workspaceId);
  await q(sql`UPDATE missions SET description = 'Ship the checkout redesign.', goal_criteria = ${JSON.stringify(CRITERIA)}::jsonb WHERE id = ${missionId}::uuid`);
});

describe('scenario 5: a task that fits the scope', () => {
  test('recorded once; no description churn, no hold, and a replay never asks again', async () => {
    const taskId = await addTask('Fix the coupon rounding in checkout');
    const r = await decideTaskScope({ taskId, actor: 'test' }, { store, decide: answering('in_scope') });
    expect(r).toMatchObject({ decided: true, replayed: false, decision: 'in_scope', status: 'recorded', scopeVersion: 1 });
    expect(await mission()).toMatchObject({ description: 'Ship the checkout redesign.', scope_version: 1 });
    const again = await decideTaskScope({ taskId, actor: 'test' }, { store, decide: answering('amend_scope') });
    expect(again).toMatchObject({ replayed: true, decision: 'in_scope' });
    expect(calls).toBe(1);
    const [t] = await q<{ held: unknown }>(sql`SELECT context->'heldBy' AS held FROM tasks WHERE id = ${taskId}::uuid`);
    expect(t!.held).toBeNull();
    // The decision is a recorded fact on the kernel's ledger.
    const facts = await q(sql`SELECT 1 FROM workflow_facts WHERE fact_key = ${`decide:mission_scope:mission:${missionId}:${taskId}`}`);
    expect(facts).toHaveLength(1);
  });
});

describe('scenario 6: a task that changes the intended outcome after a delivery merged', () => {
  test('the amendment is recorded with before and after, the version moves, and the open delivery carries it', async () => {
    await q(sql`INSERT INTO workflow_mission_epochs (mission_id, epoch, branch, state, origin) VALUES (${missionId}::uuid, 1, 'mission/x', 'merged', 'adopted')`);
    await q(sql`INSERT INTO workflow_mission_epochs (mission_id, epoch, branch, state, origin) VALUES (${missionId}::uuid, 2, 'mission/x-delivery-2', 'open', 'cut')`);
    const taskId = await addTask('Add Apple Pay to checkout');
    const r = await decideTaskScope({ taskId, actor: 'test' }, { store, decide: answering('amend_scope') });
    expect(r).toMatchObject({ decision: 'amend_scope', status: 'applied', scopeVersion: 2 });
    const m = await mission();
    expect(m.scope_version).toBe(2);
    expect(m.description).toContain('Scope update (version 2): Add Apple Pay to checkout.');
    const [a] = await q<{ before: { description: string }; after: { description: string }; scope_version_before: number; scope_version_after: number }>(
      sql`SELECT before, after, scope_version_before, scope_version_after FROM workflow_scope_amendments WHERE source_task_id = ${taskId}::uuid`);
    expect(a!.before.description).toBe('Ship the checkout redesign.');
    expect(a!.scope_version_after).toBe(2);
    const [open] = await q<{ scope_version: number }>(sql`SELECT scope_version FROM workflow_mission_epochs WHERE mission_id = ${missionId}::uuid AND state = 'open'`);
    expect(open!.scope_version).toBe(2);
  });

  test('two amendments at once: both land, one version each, neither overwrites the other', async () => {
    const t1 = await addTask('Add Apple Pay');
    const t2 = await addTask('Add Google Pay');
    await Promise.all([
      decideTaskScope({ taskId: t1, actor: 'test' }, { store, decide: answering('amend_scope') }),
      decideTaskScope({ taskId: t2, actor: 'test' }, { store, decide: answering('amend_scope') }),
    ]);
    const m = await mission();
    expect(m.scope_version).toBe(3);
    expect(m.description).toContain('Add Apple Pay');
    expect(m.description).toContain('Add Google Pay');
    const rows = await q<{ scope_version_after: number }>(sql`SELECT scope_version_after FROM workflow_scope_amendments WHERE mission_id = ${missionId}::uuid ORDER BY scope_version_after`);
    expect(rows.map((r) => r.scope_version_after)).toEqual([2, 3]);
  });
});

describe('scenario 7: an amendment that would weaken a safety criterion', () => {
  test('held for a person whatever the decider said: the task waits, one question is asked, the contract is unchanged', async () => {
    const taskId = await addTask('Drop the slow test gate', { missionScope: { goalCriteria: [{ type: 'all_prs_merged' }], reason: 'tests are slow' } });
    const r = await decideTaskScope({ taskId, actor: 'test' }, { store, decide: answering('amend_scope', 0.99) });
    expect(r).toMatchObject({ decision: 'amend_scope', status: 'held', scopeVersion: 1 });
    expect(await mission()).toMatchObject({ scope_version: 1, goal_criteria: CRITERIA });
    const [t] = await q<{ reason: string | null }>(sql`SELECT context->'heldBy'->>'reason' AS reason FROM tasks WHERE id = ${taskId}::uuid`);
    expect(t!.reason).toBe('mission_scope_decision');
    const notes = await q<{ title: string; type: string }>(sql`SELECT title, type FROM mission_notes WHERE mission_id = ${missionId}::uuid AND task_id = ${taskId}::uuid`);
    expect(notes).toEqual([{ title: 'Does "Drop the slow test gate" change what this mission delivers?', type: 'question' }]);
    // A replay asks nothing and posts nothing more.
    await decideTaskScope({ taskId, actor: 'test' }, { store, decide: answering('amend_scope') });
    expect(await q(sql`SELECT 1 FROM mission_notes WHERE task_id = ${taskId}::uuid`)).toHaveLength(1);
  });

  test('an unusable answer is the default: the task is filed as filed, recorded with why', async () => {
    const taskId = await addTask('Polish the receipt page');
    const r = await decideTaskScope({ taskId, actor: 'test' }, { store, decide: { id: 'down', decide: async () => { throw new Error('provider down'); } } });
    expect(r).toMatchObject({ decision: 'in_scope', status: 'recorded' });
    const [a] = await q<{ fallback: string }>(sql`SELECT fallback FROM workflow_scope_amendments WHERE source_task_id = ${taskId}::uuid`);
    expect(a!.fallback).toBe('error');
  });

  test("the organizer's own decomposition is not a scope change and is not asked about", async () => {
    const taskId = await addTask('Step 1 of the plan');
    await q(sql`UPDATE tasks SET creation_source = 'orchestrator' WHERE id = ${taskId}::uuid`);
    expect(await decideTaskScope({ taskId, actor: 'test' }, { store, decide: answering('ask') })).toEqual({ decided: false, reason: 'organizer_decomposition' });
    expect(calls).toBe(0);
  });
});

async function heldTask(title: string, context: Record<string, unknown> = {}) {
  const taskId = await addTask(title, context);
  const r = await decideTaskScope({ taskId, actor: 'test' }, { store, decide: answering('ask') });
  expect(r).toMatchObject({ status: 'held' });
  return taskId;
}
async function taskState(taskId: string) {
  return (await q<{ status: string; held: Record<string, unknown> | null }>(
    sql`SELECT status, context->'heldBy' AS held FROM tasks WHERE id = ${taskId}::uuid`))[0]!;
}
async function amendment(taskId: string) {
  return (await q<{ status: string; resolution: string | null; resolved_by: string | null; scope_version_after: number | null }>(
    sql`SELECT status, resolution, resolved_by, scope_version_after FROM workflow_scope_amendments WHERE source_task_id = ${taskId}::uuid`))[0]!;
}
async function noteStatus(taskId: string) {
  return (await q<{ status: string }>(sql`SELECT status FROM mission_notes WHERE task_id = ${taskId}::uuid`)).map((n) => n.status);
}

describe('a task linked to a mission gets the same decision', () => {
  test('work the organizer planned for another mission, moved here, is decided, not exempt', async () => {
    const taskId = await addTask('Add Apple Pay');
    await q(sql`UPDATE tasks SET creation_source = 'orchestrator' WHERE id = ${taskId}::uuid`);
    expect(await decideTaskScope({ taskId, actor: 'test' }, { store, decide: answering('amend_scope') })).toMatchObject({ reason: 'organizer_decomposition' });
    const r = await decideTaskScope({ taskId, actor: 'system:task_linked', origin: 'linked' }, { store, decide: answering('amend_scope') });
    expect(r).toMatchObject({ decided: true, decision: 'amend_scope', status: 'applied', scopeVersion: 2 });
    expect((await mission()).scope_version).toBe(2);
  });

  test('a link and a filing at once: the compare-and-set gives each its own version', async () => {
    const linked = await addTask('Add Apple Pay');
    const filed = await addTask('Add Google Pay');
    await Promise.all([
      decideTaskScope({ taskId: linked, actor: 'system:task_linked', origin: 'linked' }, { store, decide: answering('amend_scope') }),
      decideTaskScope({ taskId: filed, actor: 'system:task_filed' }, { store, decide: answering('amend_scope') }),
    ]);
    const m = await mission();
    expect(m.scope_version).toBe(3);
    expect(m.description).toContain('Add Apple Pay');
    expect(m.description).toContain('Add Google Pay');
  });

  test('a held link names its mission on the hold', async () => {
    const taskId = await addTask('Rebuild the cart');
    await decideTaskScope({ taskId, actor: 'system:task_linked', origin: 'linked' }, { store, decide: answering('ask') });
    expect((await taskState(taskId)).held).toMatchObject({ reason: 'mission_scope_decision', missionId });
  });
});

describe("a person's answer to a held decision", () => {
  test('it fits: recorded once, the hold released, the question answered, the contract unchanged', async () => {
    const taskId = await heldTask('Rebuild the cart');
    expect(await noteStatus(taskId)).toEqual(['open']);
    const r = await resolveTaskScope({ missionId, taskId, answer: 'in_scope', actor: 'human:u-1' });
    expect(r).toEqual({ resolved: true, replayed: false, resolution: 'in_scope', scopeVersion: 1, cancelled: false });
    expect(await taskState(taskId)).toEqual({ status: 'pending', held: null });
    expect(await amendment(taskId)).toMatchObject({ status: 'resolved', resolution: 'in_scope', resolved_by: 'human:u-1' });
    expect(await noteStatus(taskId)).toEqual(['answered']);
    expect(await mission()).toMatchObject({ description: 'Ship the checkout redesign.', scope_version: 1 });
    // Answered once: a second answer reads the first back and changes nothing.
    expect(await resolveTaskScope({ missionId, taskId, answer: 'amend_scope', actor: 'human:u-2' })).toMatchObject({ replayed: true, resolution: 'in_scope' });
    expect((await mission()).scope_version).toBe(1);
  });

  test('it changes the mission: a weakening amendment the person accepted applies, on the version read now', async () => {
    await q(sql`INSERT INTO workflow_mission_epochs (mission_id, epoch, branch, state, origin) VALUES (${missionId}::uuid, 1, 'mission/x', 'open', 'adopted')`);
    const taskId = await addTask('Drop the slow test gate', { missionScope: { goalCriteria: [{ type: 'all_prs_merged' }], reason: 'tests are slow' } });
    expect(await decideTaskScope({ taskId, actor: 'test' }, { store, decide: answering('amend_scope') })).toMatchObject({ status: 'held' });
    // Another amendment lands while this one waits.
    const other = await addTask('Add Apple Pay');
    await decideTaskScope({ taskId: other, actor: 'test' }, { store, decide: answering('amend_scope') });
    expect((await mission()).scope_version).toBe(2);

    const r = await resolveTaskScope({ missionId, taskId, answer: 'amend_scope', actor: 'human:u-1' });
    expect(r).toMatchObject({ resolved: true, resolution: 'amend_scope', scopeVersion: 3 });
    const m = await mission();
    expect(m).toMatchObject({ scope_version: 3, goal_criteria: [{ type: 'all_prs_merged' }] });
    expect(m.description).toContain('Add Apple Pay');
    expect(await amendment(taskId)).toMatchObject({ status: 'resolved', resolution: 'amend_scope', scope_version_after: 3 });
    expect((await taskState(taskId)).held).toBeNull();
    const [open] = await q<{ scope_version: number }>(sql`SELECT scope_version FROM workflow_mission_epochs WHERE mission_id = ${missionId}::uuid AND state = 'open'`);
    expect(open!.scope_version).toBe(3);
  });

  test('two people accept two held amendments at once: both apply, one version each', async () => {
    const t1 = await heldTask('Add Apple Pay');
    const t2 = await heldTask('Add Google Pay');
    await Promise.all([
      resolveTaskScope({ missionId, taskId: t1, answer: 'amend_scope', actor: 'human:u-1' }),
      resolveTaskScope({ missionId, taskId: t2, answer: 'amend_scope', actor: 'human:u-2' }),
    ]);
    const m = await mission();
    expect(m.scope_version).toBe(3);
    expect(m.description).toContain('Add Apple Pay');
    expect(m.description).toContain('Add Google Pay');
  });

  test('it belongs elsewhere: the task is cancelled and the question answered', async () => {
    const taskId = await heldTask('Rewrite the warehouse app');
    const r = await resolveTaskScope({ missionId, taskId, answer: 'out_of_scope', actor: 'human:u-1' });
    expect(r).toMatchObject({ resolved: true, resolution: 'out_of_scope', cancelled: true });
    expect(await taskState(taskId)).toEqual({ status: 'cancelled', held: null });
    expect(await noteStatus(taskId)).toEqual(['answered']);
  });

  test("a person's own hold is never released by a scope answer", async () => {
    const taskId = await heldTask('Rebuild the cart');
    await q(sql`UPDATE tasks SET context = context || '{"heldBy":{"reason":"waiting on design","userId":null}}'::jsonb WHERE id = ${taskId}::uuid`);
    await resolveTaskScope({ missionId, taskId, answer: 'in_scope', actor: 'human:u-1' });
    expect((await taskState(taskId)).held).toMatchObject({ reason: 'waiting on design' });
    expect((await amendment(taskId)).status).toBe('resolved');
  });

  test('a task with no held decision, or out of the mission, is refused', async () => {
    const fits = await addTask('Fix rounding');
    await decideTaskScope({ taskId: fits, actor: 'test' }, { store, decide: answering('in_scope') });
    expect(await resolveTaskScope({ missionId, taskId: fits, answer: 'in_scope', actor: 'human:u-1' })).toEqual({ resolved: false, reason: 'no_decision' });
    const taskId = await heldTask('Rebuild the cart');
    await q(sql`UPDATE tasks SET mission_id = NULL WHERE id = ${taskId}::uuid`);
    expect(await resolveTaskScope({ missionId, taskId, answer: 'in_scope', actor: 'human:u-1' })).toEqual({ resolved: false, reason: 'not_in_mission' });
  });
});

describe('a held task that left the mission', () => {
  test("withdrawn: this mission's hold is released; a hold another mission's decision placed is not", async () => {
    const taskId = await heldTask('Rebuild the cart');
    const ws = await seedWorkspace();
    const otherMission = await seedMission(ws.teamId, workspaceId);
    // Moved to another mission, whose own decision holds it before this one is withdrawn.
    await q(sql`UPDATE tasks SET mission_id = ${otherMission}::uuid WHERE id = ${taskId}::uuid`);
    const otherDecision = await decideTaskScope({ taskId, actor: 'system:task_linked', origin: 'linked' }, { store, decide: answering('ask') });
    expect(otherDecision).toMatchObject({ status: 'held' });
    const r = await resolveTaskScope({ missionId, taskId, answer: 'withdrawn', actor: 'system:task_left_mission' });
    expect(r).toMatchObject({ resolved: true, resolution: 'withdrawn' });
    expect((await taskState(taskId)).held).toMatchObject({ reason: 'mission_scope_decision', missionId: otherMission });

    // Unlinked from the other mission too: its hold goes as well.
    await q(sql`UPDATE tasks SET mission_id = NULL WHERE id = ${taskId}::uuid`);
    await resolveTaskScope({ missionId: otherMission, taskId, answer: 'withdrawn', actor: 'system:task_left_mission' });
    expect((await taskState(taskId)).held).toBeNull();
  });
});
