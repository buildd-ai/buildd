/**
 * Start anyway end to end on real Postgres (Living Spec 36df686b r1,
 * docs/specs/force-start.md): the real `/start` route, the real claim route
 * and its SQL dependency gate, the context the agent is handed, the edit gate,
 * the real wait exit (park), the real dependency wake and the resumed claim.
 * `start-anyway-gate.test.ts` covers the gate predicate alone; this follows
 * one task through the whole lifecycle. Synthetic rows only.
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
const PATH = 'packages/web/use-parser.ts';

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
async function upstream(w: W, title = 'Export the parser interface'): Promise<string> {
  const id = await seedTask(w.workspaceId, { status: 'in_progress', title, pathManifest: ['packages/core/parser.ts'] });
  await q(sql`INSERT INTO workers (workspace_id, task_id, name, runner, branch, status)
    VALUES (${w.workspaceId}::uuid, ${id}::uuid, ${`up-${rand()}`}, 'other-runner', ${`buildd/${rand()}`}, 'running')`);
  return id;
}

async function start(w: W, taskId: string, body?: Record<string, unknown>) {
  const res = await startRoute.POST(new NextRequest(`http://localhost/api/tasks/${taskId}/start`, {
    method: 'POST',
    headers: { authorization: `Bearer ${w.key}`, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }) as never, { params: Promise.resolve({ id: taskId }) });
  return { status: res.status, body: await res.json() as Record<string, any> };
}

/** The person's two clicks: Start, then Start anyway on the refusal it showed. */
async function startAnyway(w: W, taskId: string) {
  const refused = await start(w, taskId);
  expect(refused.status).toBe(422);
  expect(refused.body.canForce).toBe(true);
  expect(refused.body.force.kinds).toContain('dep_declared');
  const accepted = await start(w, taskId, { force: { kinds: refused.body.force.kinds, reasonsDigest: refused.body.reasonsDigest } });
  expect(accepted.status).toBe(200);
  return { refused, accepted };
}

type Claimed = { id: string; taskId: string; task: { context?: Record<string, any> } };
async function claim(w: W): Promise<Claimed[]> {
  const res = await claimRoute.POST(new NextRequest('http://localhost/api/workers/claim', {
    method: 'POST',
    headers: { authorization: `Bearer ${w.key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ runner: `r-${rand()}`, workspaceId: w.workspaceId, environment: confinedRunnerEnvironment(), maxTasks: 5 }),
  }) as never);
  expect(res.status).toBe(200);
  return ((await res.json()) as { workers?: Claimed[] }).workers ?? [];
}

const row = async (id: string) => (await q<{ status: string; depends_on: string[]; context: Record<string, any> | null }>(
  sql`SELECT status, depends_on, context FROM tasks WHERE id = ${id}::uuid`))[0];
const passesDepsGate = async (id: string) =>
  (await db.select({ id: tasks.id }).from(tasks).where(sql`${tasks.id} = ${id}::uuid AND ${depsGate()}`)).length === 1;
const asWaitTask = (id: string, workspaceId: string, t: Awaited<ReturnType<typeof row>>) =>
  ({ id, workspaceId, status: t.status, dependsOn: t.depends_on, context: t.context, deliveryId: null, gitConfig: null });
const claimPath = (taskId: string) => checkPathClaim({ taskId, paths: [PATH], surface: 'test', callerOrigin: 'worker' });

describe('Start anyway, one task through the whole lifecycle', () => {
  test('AC-18: without a request the automatic claim waits on the unfinished declared dependency', async () => {
    const w = await world();
    const up = await upstream(w);
    const dependent = await seedTask(w.workspaceId, { dependsOn: [up] });
    expect((await claim(w)).map(x => x.taskId)).not.toContain(dependent);
  });

  test('AC-8 / R-4 / AC-9 / R-8 / AC-11 / AC-12 / AC-17: start, assess, gate edits, park, wake on the merge, resume the same task', async () => {
    const w = await world();
    const up = await upstream(w);
    const dependent = await seedTask(w.workspaceId, { dependsOn: [up], pathManifest: [PATH], title: 'Use the parser interface' });

    const { accepted } = await startAnyway(w, dependent);
    const intentId = (await row(dependent)).context!.forceStart.id;
    expect(accepted.body.forced.forceId).toBe(intentId);
    // AC-14: the request survives a missed wake; dispatch holds it.
    expect((await outboxFor(dependent)).length).toBeGreaterThan(0);

    // One ordinary claim admits it, consuming the request; the agent is handed the live upstream.
    const cw = (await claim(w)).find(x => x.taskId === dependent);
    expect(cw).toBeDefined();
    const brief = cw!.task.context?.startAnywayAssessment;
    expect(brief.text).toContain('Export the parser interface');
    expect(brief.facts.map((f: { id: string }) => f.id)).toEqual([up]);
    const claimed = await row(dependent);
    expect(claimed.context!.forceStart).toBeUndefined();
    expect(claimed.depends_on).toEqual([up]);
    expect((await row(up)).status).toBe('in_progress');
    const [{ upWorkers }] = await q<{ upWorkers: number }>(sql`SELECT count(*)::int AS "upWorkers" FROM workers WHERE task_id = ${up}::uuid`);
    expect(upWorkers).toBe(1);

    // AC-9: no file ownership until the assessment is recorded.
    const early = await claimPath(dependent);
    expect(early.kind).toBe('conflict');
    expect((early as { body: Record<string, unknown> }).body.code).toBe('assessment_required');
    expect((await saveStartAnywayAssessment({ taskId: dependent, raw: ASSESSMENT, workerId: cw!.id })).ok).toBe(true);
    expect((await claimPath(dependent)).kind).toBe('claimed');

    // R-8: park with the assessment; the worker ends, its file claims go, the condition is recorded.
    const parked = await applyWaitExit({
      task: asWaitTask(dependent, w.workspaceId, await row(dependent)),
      blockerTaskId: up, reason: 'needs the upstream interface', workerId: cw!.id, assessment: ASSESSMENT,
    });
    expect(parked.ok).toBe(true);
    expect(parked.ok && parked.park?.resumedOnRecheck).toBe(false);
    const p = await row(dependent);
    expect(p.status).toBe('pending');
    expect(p.depends_on).toEqual([up]);
    expect(p.context!.startAnywayPark).toMatchObject({ assessment: ASSESSMENT, wake: { event: 'task.completed+merged', taskId: up }, structured: true });
    expect(p.context!.waitExit.blockerTaskId).toBe(up);
    const [wk] = await q<{ status: string }>(sql`SELECT status FROM workers WHERE id = ${cw!.id}::uuid`);
    expect(wk.status).toBe('completed');
    const [{ leases }] = await q<{ leases: number }>(sql`SELECT count(*)::int AS leases FROM path_claims WHERE task_id = ${dependent}::uuid AND released_at IS NULL`);
    expect(leases).toBe(0);
    expect(await passesDepsGate(dependent)).toBe(false);
    expect((await claim(w)).map(x => x.taskId)).not.toContain(dependent);

    // The upstream merges: the existing dependency wake readies the same task once, and it resumes.
    await db.execute(sql`UPDATE tasks SET status = 'completed', updated_at = now() WHERE id = ${up}::uuid`);
    await db.execute(sql`UPDATE workers SET status = 'completed' WHERE task_id = ${up}::uuid`);
    expect(await enqueueReadyDependents(up, depsGate())).toEqual([dependent]);
    const resumed = (await claim(w)).filter(x => x.taskId === dependent);
    expect(resumed).toHaveLength(1);
    expect(resumed[0].id).not.toBe(cw!.id); // a new attempt, under the same task
    expect(resumed[0].task.context?.startAnywayPark.assessment).toEqual(ASSESSMENT);
    expect(resumed[0].task.context?.waitExit.blockerTaskId).toBe(up);
    // The resumed attempt edits without a second assessment: its park carried one.
    expect((await claimPath(dependent)).kind).toBe('claimed');
    const [{ n }] = await q<{ n: number }>(sql`SELECT count(*)::int AS n FROM tasks WHERE workspace_id = ${w.workspaceId}::uuid`);
    expect(n).toBe(2); // no replacement or recovery task
  });

  test('R-9: a park the gate already releases when it is written is woken by the recheck', async () => {
    const w = await world();
    const up = await upstream(w);
    const dependent = await seedTask(w.workspaceId, { dependsOn: [up] });
    await startAnyway(w, dependent);
    const cw = (await claim(w)).find(x => x.taskId === dependent)!;
    await settleOutbox();
    // The upstream is still running, so the park is accepted, but the edge was
    // released meanwhile (a person's early release): its wake fired while this
    // task was still running and found no pending dependent.
    await q(sql`INSERT INTO dependency_releases (dependent_task_id, upstream_task_id, upstream_pr_number, decision, source, reason_code)
      VALUES (${dependent}::uuid, ${up}::uuid, 1, 'start_now', 'rule', 'test')`);
    const out = await applyWaitExit({
      task: asWaitTask(dependent, w.workspaceId, await row(dependent)),
      blockerTaskId: up, reason: 'r', workerId: cw.id, assessment: ASSESSMENT,
    });
    expect(out.ok && out.park?.resumedOnRecheck).toBe(true);
    expect((await outboxFor(dependent)).some(o => o.status === 'pending' && o.causes.includes('dependency.satisfied'))).toBe(true);
  });

  test('R-9: a prerequisite that already landed refuses the park, so the agent carries on', async () => {
    const w = await world();
    const up = await upstream(w);
    const dependent = await seedTask(w.workspaceId, { dependsOn: [up] });
    await startAnyway(w, dependent);
    const cw = (await claim(w)).find(x => x.taskId === dependent)!;
    await db.execute(sql`UPDATE tasks SET status = 'completed', updated_at = now() WHERE id = ${up}::uuid`);
    const out = await applyWaitExit({
      task: asWaitTask(dependent, w.workspaceId, await row(dependent)),
      blockerTaskId: up, reason: 'r', workerId: cw.id, assessment: ASSESSMENT,
    });
    expect(!out.ok && out.code).toBe('blocker_merged');
    expect((await row(dependent)).status).not.toBe('pending');
  });

  test('a malformed assessment is refused and nothing moves', async () => {
    const w = await world();
    const up = await upstream(w);
    const dependent = await seedTask(w.workspaceId, { dependsOn: [up] });
    await startAnyway(w, dependent);
    const cw = (await claim(w)).find(x => x.taskId === dependent)!;
    const before = await row(dependent);
    const out = await applyWaitExit({
      task: asWaitTask(dependent, w.workspaceId, before),
      blockerTaskId: up, reason: 'r', workerId: cw.id, assessment: { needs: 'x' },
    });
    expect(!out.ok && out.code).toBe('invalid_assessment');
    expect((await row(dependent)).status).toBe(before.status);
    expect((await saveStartAnywayAssessment({ taskId: up, raw: ASSESSMENT, workerId: null })).ok).toBe(false);
  });
});
