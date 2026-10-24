/**
 * Start anyway, end to end on real Postgres (Living Spec 36df686b r1,
 * docs/specs/force-start.md): the real `/start` route, the real claim route
 * and its SQL dependency gate, the agent's context, the real wait exit (park),
 * the real dependency wake, and the resumed claim. Synthetic rows only.
 *
 * What it proves:
 *  - an automatic claim still waits on an unfinished declared dependency;
 *  - a person's Start anyway is accepted, the ordinary claim admits the task
 *    for assessment exactly once, its agent gets the assessment brief with
 *    the upstream's live state, and the upstream edge and status are
 *    untouched;
 *  - a dependency added after the person confirmed still holds;
 *  - the retired `bypassDepsGate` flag lifts nothing;
 *  - edits wait on a recorded assessment;
 *  - a park frees the worker, records the assessment and wake condition, and
 *    the prerequisite's merge resumes the same task, with the saved
 *    assessment, through the dependency wake;
 *  - a prerequisite that lands while the park is written resumes at once.
 */
import { beforeAll, describe, expect, mock, setDefaultTimeout, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { tasks } from '@buildd/core/db/schema';
import { enqueueReadyDependents } from '@buildd/core/dispatch-dependents';
import { assertDbConfigured, confinedRunnerEnvironment, outboxFor, q, seedTask, seedWorkspace, settleOutbox } from './harness';

const realAuthHelpers = await import('../../src/lib/auth-helpers');
mock.module('../../src/lib/auth-helpers', () => ({ ...realAuthHelpers, getCurrentUser: async () => null }));

const claimRoute = await import('../../src/app/api/workers/claim/route');
const startRoute = await import('../../src/app/api/tasks/[id]/start/route');
const { depsGate } = await import('../../src/app/api/workers/claim/deps-gate');
const { applyWaitExit } = await import('../../src/lib/task-wait-exit');
const { saveStartAnywayAssessment } = await import('../../src/lib/start-anyway-assessment');
const { checkPathClaim } = await import('../../src/lib/path-claim-check');

setDefaultTimeout(30_000);
beforeAll(() => assertDbConfigured());

const rand = () => crypto.randomUUID().replace(/-/g, '').slice(0, 10);
const ASSESSMENT = {
  needs: 'the exported interface from the upstream change',
  canProceed: 'the tests and the parts that do not call it',
  uncertainty: 'unknown whether its shape changes before merge',
  nextStep: 'wait for the upstream interface to merge',
};

async function world() {
  const ws = await seedWorkspace();
  await q(sql`UPDATE workspaces SET access_mode = 'open' WHERE id = ${ws.workspaceId}::uuid`);
  const key = `bld_${crypto.randomUUID().replace(/-/g, '')}`;
  const hashed = createHash('sha256').update(key).digest('hex');
  await q(sql`
    INSERT INTO accounts (type, name, api_key, team_id, level, max_concurrent_workers)
    VALUES ('service', ${`svc-${rand()}`}, ${hashed}, ${ws.teamId}::uuid, 'worker', 10)`);
  return { ...ws, key };
}
type W = Awaited<ReturnType<typeof world>>;

/** An upstream task with its agent running: the prerequisite. */
async function upstream(w: W, title = 'Export the parser interface'): Promise<{ id: string; workerId: string }> {
  const id = await seedTask(w.workspaceId, { status: 'in_progress', title, pathManifest: ['packages/core/parser.ts'] });
  const [wk] = await q<{ id: string }>(sql`INSERT INTO workers (workspace_id, task_id, name, runner, branch, status)
    VALUES (${w.workspaceId}::uuid, ${id}::uuid, ${`up-${rand()}`}, 'other-runner', ${`buildd/${rand()}`}, 'running') RETURNING id`);
  return { id, workerId: wk.id };
}

async function start(w: W, taskId: string, body?: Record<string, unknown>) {
  const res = await startRoute.POST(new NextRequest(`http://localhost/api/tasks/${taskId}/start`, {
    method: 'POST',
    headers: { authorization: `Bearer ${w.key}`, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }) as never, { params: Promise.resolve({ id: taskId }) });
  return { status: res.status, body: await res.json() as Record<string, any> };
}

async function claim(w: W, body: Record<string, unknown> = {}) {
  const res = await claimRoute.POST(new NextRequest('http://localhost/api/workers/claim', {
    method: 'POST',
    headers: { authorization: `Bearer ${w.key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ runner: `r-${rand()}`, workspaceId: w.workspaceId, environment: confinedRunnerEnvironment(), maxTasks: 5, ...body }),
  }) as never);
  expect(res.status).toBe(200);
  return (await res.json()) as { workers?: Array<{ id: string; taskId: string; task: { context?: Record<string, any> } }> };
}

const row = async (id: string) => (await q<{ status: string; depends_on: string[]; context: Record<string, any> | null }>(
  sql`SELECT status, depends_on, context FROM tasks WHERE id = ${id}::uuid`))[0];
const passesDepsGate = async (id: string) =>
  (await db.select({ id: tasks.id }).from(tasks).where(sql`${tasks.id} = ${id}::uuid AND ${depsGate()}`)).length === 1;
const providers = (cw: { task: { context?: Record<string, any> } }) => ((cw.task.context?.resolvedContextProviders ?? []) as string[]).join('\n');

describe('Start anyway on real Postgres', () => {
  test('AC-18 / R-16: without a person\'s request, an automatic claim waits on the unfinished declared dependency', async () => {
    const w = await world();
    const up = await upstream(w);
    const dependent = await seedTask(w.workspaceId, { dependsOn: [up.id], title: 'Use the parser interface' });
    expect(await passesDepsGate(dependent)).toBe(false);
    const body = await claim(w);
    expect((body.workers ?? []).map(x => x.taskId)).not.toContain(dependent);
  });

  test('R-3: the retired gate-wide bypass flag lifts nothing', async () => {
    const w = await world();
    const up = await upstream(w);
    const dependent = await seedTask(w.workspaceId, { dependsOn: [up.id] });
    await q(sql`UPDATE tasks SET context = '{"bypassDepsGate": true}'::jsonb WHERE id = ${dependent}::uuid`);
    expect(await passesDepsGate(dependent)).toBe(false);
  });

  test('AC-8 / R-2 / R-4 / AC-14: /start accepts, one claim admits it for assessment, the agent reads the live upstream, the upstream is untouched', async () => {
    const w = await world();
    const up = await upstream(w);
    const dependent = await seedTask(w.workspaceId, { dependsOn: [up.id], title: 'Use the parser interface' });

    const refused = await start(w, dependent);
    expect(refused.status).toBe(422);
    expect(refused.body.canForce).toBe(true);
    expect(refused.body.force.action).toBe('start_anyway');
    expect(refused.body.force.kinds).toEqual(['dep_declared']);

    const accepted = await start(w, dependent, { force: { kinds: refused.body.force.kinds, reasonsDigest: refused.body.reasonsDigest } });
    expect(accepted.status).toBe(200);
    expect(accepted.body.startAnyway.phase).toBe('requested');
    const intent = (await row(dependent)).context!.forceStart;
    expect(intent.assessDependsOn).toEqual([up.id]);

    // A repeat click (or a missed wake re-sent) keeps the one request.
    const again = await start(w, dependent, { force: { kinds: ['dep_declared'], reasonsDigest: refused.body.reasonsDigest } });
    expect(again.status).toBe(200);
    expect((await row(dependent)).context!.forceStart.id).toBe(intent.id);
    // The request is durable: dispatch holds a wake for it.
    expect((await outboxFor(dependent)).length).toBeGreaterThan(0);

    expect(await passesDepsGate(dependent)).toBe(true);
    const first = await claim(w);
    const cw = (first.workers ?? []).find(x => x.taskId === dependent);
    expect(cw).toBeDefined();
    const brief = providers(cw!);
    expect(brief).toContain('Started anyway: assess before you edit');
    expect(brief).toContain('Export the parser interface');
    expect(brief).toContain(up.id);

    const after = await row(dependent);
    expect(after.context!.forceStart).toBeUndefined();
    expect(after.context!.startAnyway).toMatchObject({ phase: 'assessing', prerequisiteIds: [up.id] });
    expect(after.context!.forceStartHistory.at(-1)).toMatchObject({ id: intent.id, assessDependsOn: [up.id] });
    expect(after.depends_on).toEqual([up.id]);
    expect((await row(up.id)).status).toBe('in_progress');
    const [{ n }] = await q<{ n: number }>(sql`SELECT count(*)::int AS n FROM workers WHERE task_id = ${up.id}::uuid`);
    expect(n).toBe(1);
    // Consumed: the gate no longer admits it.
    expect(await passesDepsGate(dependent)).toBe(false);
  });

  test('AC-3: an edge added after the person confirmed is refused as reasons_changed and still holds at claim', async () => {
    const w = await world();
    const up = await upstream(w);
    const dependent = await seedTask(w.workspaceId, { dependsOn: [up.id] });
    const refused = await start(w, dependent);
    const later = await upstream(w, 'A dependency added later');
    await q(sql`UPDATE tasks SET depends_on = ${JSON.stringify([up.id, later.id])}::jsonb WHERE id = ${dependent}::uuid`);
    const stale = await start(w, dependent, { force: { kinds: ['dep_declared'], reasonsDigest: refused.body.reasonsDigest } });
    expect(stale.status).toBe(409);
    expect(stale.body.gateReason).toBe('reasons_changed');
    expect(stale.body.waitingReasons.map((r: { blocker: { id: string } }) => r.blocker.id).sort()).toEqual([up.id, later.id].sort());
    // An intent naming only the first edge does not admit the second.
    const forceStart = { assessDependsOn: [up.id], expiresAt: new Date(Date.now() + 3_600_000).toISOString(), loopKeys: [] };
    await q(sql`UPDATE tasks SET context = ${JSON.stringify({ forceStart })}::jsonb WHERE id = ${dependent}::uuid`);
    expect(await passesDepsGate(dependent)).toBe(false);
    // Naming both admits it; once expired, neither does.
    await q(sql`UPDATE tasks SET context = ${JSON.stringify({ forceStart: { ...forceStart, assessDependsOn: [up.id, later.id] } })}::jsonb WHERE id = ${dependent}::uuid`);
    expect(await passesDepsGate(dependent)).toBe(true);
    await q(sql`UPDATE tasks SET context = ${JSON.stringify({ forceStart: { ...forceStart, assessDependsOn: [up.id, later.id], expiresAt: new Date(Date.now() - 1000).toISOString() } })}::jsonb WHERE id = ${dependent}::uuid`);
    expect(await passesDepsGate(dependent)).toBe(false);
  });

  test('R-8 / R-9 / AC-11 / AC-12 / AC-17: edits wait on the assessment; a park frees the worker; the upstream merge resumes the same task with its saved assessment', async () => {
    const w = await world();
    const up = await upstream(w);
    const dependent = await seedTask(w.workspaceId, { dependsOn: [up.id], pathManifest: ['packages/web/use-parser.ts'] });
    const refused = await start(w, dependent);
    await start(w, dependent, { force: { kinds: ['dep_declared'], reasonsDigest: refused.body.reasonsDigest } });
    const cw = (await claim(w)).workers!.find(x => x.taskId === dependent)!;

    // AC-9: no file ownership before the assessment is recorded.
    const early = await checkPathClaim({ taskId: dependent, paths: ['packages/web/use-parser.ts'], surface: 'test', callerOrigin: 'worker' as never });
    expect(early.kind).toBe('conflict');
    expect((early as { body: Record<string, unknown> }).body.code).toBe('assessment_required');
    expect((await saveStartAnywayAssessment({ taskId: dependent, raw: ASSESSMENT, workerId: cw.id })).ok).toBe(true);
    expect((await checkPathClaim({ taskId: dependent, paths: ['packages/web/use-parser.ts'], surface: 'test', callerOrigin: 'worker' as never })).kind).toBe('claimed');

    // Park: no useful work left until the upstream lands.
    const t = await row(dependent);
    const parked = await applyWaitExit({
      task: { id: dependent, workspaceId: w.workspaceId, status: t.status, dependsOn: t.depends_on, context: t.context, deliveryId: null, gitConfig: null },
      blockerTaskId: up.id, reason: 'needs the upstream interface', workerId: cw.id, assessment: ASSESSMENT,
    });
    expect(parked.ok).toBe(true);
    const p = await row(dependent);
    expect(p.status).toBe('pending');
    expect(p.depends_on).toEqual([up.id]);
    expect(p.context!.startAnyway).toMatchObject({ phase: 'parked', assessment: ASSESSMENT, wake: { event: 'task.completed+merged', taskId: up.id }, reparks: 1 });
    const [wk] = await q<{ status: string }>(sql`SELECT status FROM workers WHERE id = ${cw.id}::uuid`);
    expect(wk.status).toBe('completed');
    const [{ leases }] = await q<{ leases: number }>(sql`SELECT count(*)::int AS leases FROM path_claims WHERE task_id = ${dependent}::uuid AND released_at IS NULL`);
    expect(leases).toBe(0);
    // Parked and unfinished upstream: not claimable, no loop.
    expect(await passesDepsGate(dependent)).toBe(false);

    // The upstream merges: the existing dependency wake readies the same task, once.
    await db.execute(sql`UPDATE tasks SET status = 'completed', updated_at = now() WHERE id = ${up.id}::uuid`);
    await db.execute(sql`UPDATE workers SET status = 'completed' WHERE task_id = ${up.id}::uuid`);
    expect(await enqueueReadyDependents(up.id, depsGate())).toEqual([dependent]);
    const resumed = (await claim(w)).workers!.filter(x => x.taskId === dependent);
    expect(resumed).toHaveLength(1);
    expect(providers(resumed[0])).toContain('Your saved assessment');
    expect(providers(resumed[0])).toContain(ASSESSMENT.nextStep);
    const r = await row(dependent);
    expect(r.context!.startAnyway).toMatchObject({ phase: 'assessing', resumes: 1, assessment: ASSESSMENT });
    const [{ tasksNamed }] = await q<{ tasksNamed: number }>(sql`SELECT count(*)::int AS "tasksNamed" FROM tasks WHERE workspace_id = ${w.workspaceId}::uuid`);
    expect(tasksNamed).toBe(2); // no replacement or recovery task
  });

  test('R-9: a prerequisite that already landed refuses the park, so the agent carries on', async () => {
    const w = await world();
    const up = await upstream(w);
    const dependent = await seedTask(w.workspaceId, { dependsOn: [up.id] });
    const refused = await start(w, dependent);
    await start(w, dependent, { force: { kinds: ['dep_declared'], reasonsDigest: refused.body.reasonsDigest } });
    const cw = (await claim(w)).workers!.find(x => x.taskId === dependent)!;
    const t = await row(dependent);
    // The upstream reached completed (no PR) after the agent decided to park
    // but before the park is applied: its dependency wake saw no pending dependent.
    await db.execute(sql`UPDATE tasks SET status = 'completed', updated_at = now() WHERE id = ${up.id}::uuid`);
    expect(await enqueueReadyDependents(up.id, depsGate())).toEqual([]);
    await settleOutbox();
    // The wait exit refuses a park on a landed prerequisite outright: carry on.
    const out = await applyWaitExit({
      task: { id: dependent, workspaceId: w.workspaceId, status: t.status, dependsOn: t.depends_on, context: t.context, deliveryId: null, gitConfig: null },
      blockerTaskId: up.id, reason: 'r', workerId: cw.id, assessment: ASSESSMENT,
    });
    expect(!out.ok && out.code).toBe('blocker_merged');
    expect((await row(dependent)).status).not.toBe('pending');
  });

  test('R-9: a park the dependency gate already releases when it is written is woken by the recheck', async () => {
    const w = await world();
    const up = await upstream(w);
    const dependent = await seedTask(w.workspaceId, { dependsOn: [up.id] });
    const refused = await start(w, dependent);
    await start(w, dependent, { force: { kinds: ['dep_declared'], reasonsDigest: refused.body.reasonsDigest } });
    const cw = (await claim(w)).workers!.find(x => x.taskId === dependent)!;
    const t = await row(dependent);
    await settleOutbox();
    // The upstream is still running, so the park is accepted, but the edge was
    // released meanwhile (a person's early release): the wake for it fired while
    // this task was still running. The recheck after the write catches it.
    await q(sql`INSERT INTO dependency_releases (dependent_task_id, upstream_task_id, upstream_pr_number, decision, source, reason_code)
      VALUES (${dependent}::uuid, ${up.id}::uuid, 1, 'start_now', 'rule', 'test')`);
    const out = await applyWaitExit({
      task: { id: dependent, workspaceId: w.workspaceId, status: t.status, dependsOn: t.depends_on, context: t.context, deliveryId: null, gitConfig: null },
      blockerTaskId: up.id, reason: 'r', workerId: cw.id, assessment: ASSESSMENT,
    });
    expect(out.ok).toBe(true);
    expect(out.ok && out.park?.resumedOnRecheck).toBe(true);
    expect((await outboxFor(dependent)).some(o => o.status === 'pending' && o.causes.includes('dependency.satisfied'))).toBe(true);
  });

  test('R-11: a park refused after the repark limit asks a person instead of looping', async () => {
    const w = await world();
    const up = await upstream(w);
    const dependent = await seedTask(w.workspaceId, { dependsOn: [up.id], status: 'in_progress' });
    const record = { intentId: 'i', requestedBy: null, requestedAt: new Date().toISOString(), prerequisiteIds: [up.id], phase: 'assessing', reparks: 3, resumes: 3, facts: [] };
    await q(sql`UPDATE tasks SET context = ${JSON.stringify({ startAnyway: record })}::jsonb WHERE id = ${dependent}::uuid`);
    const t = await row(dependent);
    const out = await applyWaitExit({
      task: { id: dependent, workspaceId: w.workspaceId, status: t.status, dependsOn: t.depends_on, context: t.context, deliveryId: null, gitConfig: null },
      blockerTaskId: up.id, reason: 'r', assessment: ASSESSMENT,
    });
    expect(!out.ok && out.code).toBe('repark_limit');
    expect((await row(dependent)).status).toBe('in_progress');
  });
});
