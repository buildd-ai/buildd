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

const { decideTaskScope } = await import('../../src/lib/workflow/scope-amendments');
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
