/**
 * Specify → Build, end to end against real Postgres (living-specs.md §20,
 * R-81 to R-84; lib/specs/task-handoff.ts). Task A drafts a Living Spec from
 * its own task token; Task B, filed beforehand with dependsOn on A and no
 * spec, inherits A's spec at claim as a provisional pin, gets a brief that
 * says build and do not ask, and asks the approvers exactly once. A person's
 * approval then re-grades B on the approved revision. Nothing here approves
 * on an agent's behalf.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { assertDbConfigured, q, seedWorkspace } from './harness';

const { createSpecDraft, reviseSpecDraft } = await import('../../src/lib/specs/store');
const { approveSpecRevision, submitSpecRevision, specApprovalDeps } = await import('../../src/lib/specs/approval');
const { settleSpecPinAtClaim, SPEC_AUTHORED_KEY, SPEC_APPROVAL_ASKED_KEY } = await import('../../src/lib/specs/task-handoff');
const { regradeProvisionalPins, provisionalDeps } = await import('../../src/lib/specs/provisional');

const rand = () => Math.random().toString(36).slice(2, 10);
const BODY_1 = '# Exports\nR-1: A person downloads their tasks as CSV.\nAC-1: GIVEN a workspace with tasks WHEN a person presses Export THEN a CSV with one row per task downloads.\n';
const BODY_2 = BODY_1 + 'R-2: The CSV names each column in the header row.\n';

let teamA: string; let wsA: string; let admin: string;
const user = (userId: string) => ({ kind: 'user' as const, userId });
const ACCOUNT = '00000000-0000-4000-8000-0000000000a7';
const taskToken = (taskId: string) => ({ kind: 'account' as const, account: { id: ACCOUNT, teamId: teamA, workspaceIds: null, level: 'admin', taskScope: { taskId, workspaceId: wsA } } as any });

beforeAll(async () => {
  assertDbConfigured();
  ({ teamId: teamA, workspaceId: wsA } = await seedWorkspace());
  await q(sql`UPDATE workspaces SET access_mode = 'open' WHERE id = ${wsA}::uuid`);
  const [u] = await q<{ id: string }>(sql`INSERT INTO users (email) VALUES (${`u-${rand()}@example.test`}) RETURNING id`);
  await q(sql`INSERT INTO team_members (team_id, user_id, role) VALUES (${teamA}::uuid, ${u.id}::uuid, 'admin')`);
  admin = u.id;
  // No dispatch, no GitHub, no push in this suite.
  provisionalDeps.wake = async () => {};
  provisionalDeps.rewritePrBody = async () => 'updated';
  specApprovalDeps.notify = async () => {};
  specApprovalDeps.afterResponse = () => {};
});

async function insertTask(opts: { role: string; dependsOn?: string[]; context?: unknown }) {
  const [t] = await q<{ id: string }>(sql`
    INSERT INTO tasks (workspace_id, title, status, role_slug, depends_on, context)
    VALUES (${wsA}::uuid, ${`task-${rand()}`}, 'pending', ${opts.role}, ${JSON.stringify(opts.dependsOn ?? [])}::jsonb, ${JSON.stringify(opts.context ?? {})}::jsonb)
    RETURNING id`);
  return t.id;
}
async function taskRow(id: string) {
  const [row] = await q<{ id: string; workspace_id: string; context: Record<string, any>; depends_on: string[] }>(sql`SELECT id, workspace_id, context, depends_on FROM tasks WHERE id = ${id}::uuid`);
  return row;
}
/** What the claim route does with the settle result: write it with its own context update. */
async function claim(taskId: string) {
  const t = await taskRow(taskId);
  const r = await settleSpecPinAtClaim({ id: t.id, workspaceId: t.workspace_id, context: t.context, dependsOn: t.depends_on });
  const next = { ...t.context };
  if (r.specSource) next.specSource = r.specSource;
  if (r.ask) next[SPEC_APPROVAL_ASKED_KEY] = { specId: r.ask.specId, revision: r.ask.revision };
  await q(sql`UPDATE tasks SET context = ${JSON.stringify(next)}::jsonb WHERE id = ${taskId}::uuid`);
  return r;
}

describe('Specify → Build', () => {
  test('Task B inherits the spec Task A drafted, builds ahead, asks once, and is re-graded on approval', async () => {
    const taskA = await insertTask({ role: 'organizer' });
    const taskB = await insertTask({ role: 'builder', dependsOn: [taskA] });

    // Task A drafts from its own task token; an agent cannot submit or approve.
    const d = await createSpecDraft(taskToken(taskA), { workspaceId: wsA, title: `Exports ${rand()}`, body: BODY_1 }, { duplicates: false });
    if (!d.ok) throw new Error(d.error);
    expect(await submitSpecRevision(taskToken(taskA), d.spec.id, { expectedVersion: d.spec.version })).toMatchObject({ ok: false, status: 403 });
    expect((await taskRow(taskA)).context[SPEC_AUTHORED_KEY]).toMatchObject({ specId: d.spec.id, revision: 1 });

    // Task B's first claim: provisional pin to revision 1, a brief that says build, one ask.
    const first = await claim(taskB);
    expect(first.specSource).toMatchObject({ specId: d.spec.id, revision: 1, provisional: true, inheritedFrom: taskA });
    expect(first.brief).toContain('Built ahead of approval, against revision 1');
    expect(first.brief).toMatch(/Do not ask a person to approve/);
    expect(first.ask).toMatchObject({ specId: d.spec.id, revision: 1 });

    // A second claim of the same task (a resume or requeue) asks nobody again and keeps the pin.
    const second = await claim(taskB);
    expect(second.ask).toBeNull();
    expect(second.specSource).toBeNull();
    expect((await taskRow(taskB)).context.specSource).toMatchObject({ revision: 1, provisional: true });

    // A person approves revision 1: the provisional pin moves to it and is re-graded.
    const a = await approveSpecRevision(user(admin), d.spec.id, { revision: 1, expectedVersion: d.spec.version });
    if (!a.ok) throw new Error(a.error);
    const regrade = await regradeProvisionalPins(d.spec.id, 1);
    expect(regrade.regraded.map((r) => r.taskId)).toContain(taskB);
    const pin = (await taskRow(taskB)).context.specSource;
    expect(pin.provisional).toBeUndefined();
    expect(pin).toMatchObject({ specId: d.spec.id, revision: 1, regradedFrom: { revision: 1 } });
  });

  test('a build task filed after the spec was approved inherits the approved revision and asks nobody', async () => {
    const taskA = await insertTask({ role: 'organizer' });
    const d = await createSpecDraft(taskToken(taskA), { workspaceId: wsA, title: `Exports ${rand()}`, body: BODY_1 }, { duplicates: false });
    if (!d.ok) throw new Error(d.error);
    const a = await approveSpecRevision(user(admin), d.spec.id, { revision: 1, expectedVersion: d.spec.version });
    if (!a.ok) throw new Error(a.error);
    const taskB = await insertTask({ role: 'builder', dependsOn: [taskA] });
    const r = await claim(taskB);
    expect(r.specSource).toMatchObject({ specId: d.spec.id, revision: 1 });
    expect(r.specSource?.provisional).toBeUndefined();
    expect(r.ask).toBeNull();
    expect(r.brief).toContain('approved revision 1');
  });

  test('Task A revising its spec moves what Task B inherits to the newest head', async () => {
    const taskA = await insertTask({ role: 'organizer' });
    const d = await createSpecDraft(taskToken(taskA), { workspaceId: wsA, title: `Exports ${rand()}`, body: BODY_1 }, { duplicates: false });
    if (!d.ok) throw new Error(d.error);
    const r2 = await reviseSpecDraft(taskToken(taskA), d.spec.id, { expectedVersion: d.spec.version, body: BODY_2 }, { duplicates: false, autoApprove: false });
    if (!r2.ok) throw new Error(r2.error);
    expect((await taskRow(taskA)).context[SPEC_AUTHORED_KEY]).toMatchObject({ specId: d.spec.id, revision: 2 });
    const taskB = await insertTask({ role: 'builder', dependsOn: [taskA] });
    const r = await claim(taskB);
    expect(r.specSource).toMatchObject({ specId: d.spec.id, revision: 2, provisional: true });
  });

  test('a build task that already names a spec keeps it; a builder cannot draft one', async () => {
    const taskA = await insertTask({ role: 'organizer' });
    const d = await createSpecDraft(taskToken(taskA), { workspaceId: wsA, title: `Exports ${rand()}`, body: BODY_1 }, { duplicates: false });
    if (!d.ok) throw new Error(d.error);
    const own = await createSpecDraft(user(admin), { workspaceId: wsA, title: `Other ${rand()}`, body: BODY_1 }, { duplicates: false });
    if (!own.ok) throw new Error(own.error);
    const taskB = await insertTask({ role: 'builder', dependsOn: [taskA], context: { specSource: { specId: own.spec.id } } });
    const r = await claim(taskB);
    expect(r.reasons.join(' ')).not.toContain('inherited');
    expect((await taskRow(taskB)).context.specSource.specId).toBe(own.spec.id);

    const builderTask = await insertTask({ role: 'builder' });
    expect(await createSpecDraft(taskToken(builderTask), { workspaceId: wsA, title: `Nope ${rand()}`, body: BODY_1 }, { duplicates: false }))
      .toMatchObject({ ok: false, status: 403, code: 'acceptance_role_forbidden' });
  });
});
