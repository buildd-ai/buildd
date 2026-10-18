/**
 * AC-1 slice 7 (docs/specs/workflow-kernel-library.md §9): a claim of a kernel delivery's owner
 * task is started by the kernel (AttemptStarted), never by the claim route's own status write.
 *
 *  - The claim's compare-and-set still decides the race in one statement (WHERE pending, no other
 *    claim in flight): it stamps claimed_by / claimed_at and leaves the status `pending`.
 *  - AttemptStarted moves the task to `assigned` in the transition's own statement (`t_start`),
 *    only while the task still carries that exact claim, so a loser, a late start or a re-send
 *    never assigns anything.
 *  - The route projects the start itself (`projectAttemptStart`) when the control plane does not
 *    answer, so a claim never fails or parks on an outage, for a runner or an interactive session.
 *  - A task with no delivery keeps the claim's own status write.
 *
 * Real kernel, real Postgres, stateful fake GitHub, the real claim route with API-key auth.
 */
import { seam, world, type OpenedPr, type World } from './workflow-scenarios-world';
import { afterEach, beforeEach, describe, expect, mock, setDefaultTimeout, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import { confinedRunnerEnvironment, q, seedTask } from './harness';

const realAuthHelpers = await import('../../src/lib/auth-helpers');
mock.module('../../src/lib/auth-helpers', () => ({ ...realAuthHelpers, getCurrentUser: async () => null }));

const claimRoute = await import('../../src/app/api/workers/claim/route');
const { CONTROL_PLANE_URL, resetKernelModeCache, resetAttemptStartBreaker } = await import('../../src/lib/workflow/kernel-client');
const { setKernelHost } = await import('../../src/lib/workflow/kernel-host');
const { signInteractiveSession, INTERACTIVE_SESSION_HEADER } = await import('../../src/lib/interactive-session');

setDefaultTimeout(30_000);

const ENV_KEYS = ['EXECUTION_MODE', 'KERNEL_COMMAND_SECRET', 'KERNEL_CLAIM_BUDGET_MS', 'KERNEL_START_BUDGET_MS', 'KERNEL_DOOR_BUDGET_MS', 'AUTH_SECRET'] as const;
const savedEnv: Record<string, string | undefined> = {};
let w: World | undefined;
let restoreFetch: (() => void) | null = null;

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
});
afterEach(() => {
  restoreFetch?.();
  restoreFetch = null;
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
  }
  resetKernelModeCache();
  resetAttemptStartBreaker();
  setKernelHost('web');
  w?.dispose();
});

type TaskRow = { status: string; claimed_by: string | null; claimed_at: string | null; delivery_role: string | null };
const taskRow = async (id: string) =>
  (await q<TaskRow>(sql`SELECT status, claimed_by, claimed_at::text AS claimed_at, delivery_role FROM tasks WHERE id = ${id}::uuid`))[0];
const starts = async (pr: OpenedPr) =>
  q<{ host: string; key: string }>(sql`SELECT host, idempotency_key AS key FROM workflow_transitions WHERE delivery_id = ${pr.deliveryId}::uuid AND command = 'AttemptStarted' ORDER BY to_version`);
const liveWorkers = async (taskId: string) =>
  (await q<{ n: number }>(sql`SELECT count(*)::int AS n FROM workers WHERE task_id = ${taskId}::uuid AND status IN ('idle', 'running', 'starting', 'waiting_input')`))[0].n;

/** The start a claim parked after its response (detached in a test): polled until it is there. */
async function parkedStarts(pr: OpenedPr): Promise<Array<{ key: string; status: string; claimed_by: string }>> {
  const read = () => q<{ key: string; status: string; claimed_by: string }>(sql`SELECT idempotency_key AS key, status, command_input->>'claimedBy' AS claimed_by FROM workflow_command_outbox WHERE op = 'attempt_started' AND command_input->'task'->>'id' = ${pr.ownerTaskId}`);
  for (let i = 0; i < 50; i++) {
    const rows = await read();
    if (rows.length > 0) return rows;
    await new Promise((r) => setTimeout(r, 40));
  }
  return read();
}
/** The floor's pass on the control plane, scoped to these keys (the shared database holds other files' rows). */
async function floorPass(keys: string[]) {
  const { drainParkedCommands, postgresCommandOutbox } = await import('../../src/lib/workflow/command-outbox');
  const outbox = postgresCommandOutbox();
  // The control plane applies commands only in own mode.
  process.env.EXECUTION_MODE = 'own';
  process.env.KERNEL_COMMAND_SECRET = 'k1:db-test-command-secret';
  resetKernelModeCache();
  setKernelHost('control-plane');
  try {
    return await drainParkedCommands({ host: () => 'control-plane', outbox: { ...outbox, claimDue: async (n) => (await outbox.claimDue(n)).filter((r) => keys.includes(r.key)) } });
  } finally {
    setKernelHost('web');
  }
}
const outboxRow = async (key: string) =>
  (await q<{ status: string; outcome: string | null }>(sql`SELECT status, outcome FROM workflow_command_outbox WHERE idempotency_key = ${key}`))[0];

async function serviceKey(teamId: string): Promise<{ id: string; key: string }> {
  const key = `bld_${crypto.randomUUID().replace(/-/g, '')}`;
  const hashed = createHash('sha256').update(key).digest('hex');
  const [a] = await q<{ id: string }>(sql`
    INSERT INTO accounts (type, name, api_key, team_id, level, max_concurrent_workers)
    VALUES ('service', ${`svc-${key.slice(4, 12)}`}, ${hashed}, ${teamId}::uuid, 'worker', 10) RETURNING id`);
  return { id: a.id, key };
}

async function teamOf(): Promise<string> {
  const [ws] = await q<{ team_id: string }>(sql`SELECT team_id FROM workspaces WHERE id = ${w!.workspaceId}::uuid`);
  await q(sql`UPDATE workspaces SET access_mode = 'open' WHERE id = ${w!.workspaceId}::uuid`);
  return ws.team_id;
}

/**
 * The owner task as a retry leaves it: its attempt failed and the kernel kept the delivery WORKING,
 * the task back to `pending` with its claim released.
 */
async function requeuedOwner(branch: string): Promise<OpenedPr> {
  const pr = await w!.openPr({ branch, files: { [`src/${branch.replace(/\W/g, '_')}.ts`]: 'export const a = 1;\n' } });
  await q(sql`UPDATE workers SET status = 'failed', created_at = now() - interval '10 minutes', updated_at = now() - interval '10 minutes' WHERE id = ${pr.workerId}::uuid`);
  await q(sql`UPDATE tasks SET status = 'pending', claimed_by = NULL, claimed_at = NULL, expires_at = NULL WHERE id = ${pr.ownerTaskId}::uuid`);
  return pr;
}

function claim(account: { key: string }, taskId: string, o: { runner?: string; headers?: Record<string, string> } = {}) {
  return claimRoute.POST(new NextRequest('http://localhost/api/workers/claim', {
    method: 'POST',
    headers: { authorization: `Bearer ${account.key}`, 'content-type': 'application/json', ...(o.headers ?? {}) },
    body: JSON.stringify({ runner: o.runner ?? `r-${crypto.randomUUID().slice(0, 8)}`, maxTasks: 1, workspaceId: w!.workspaceId, taskId, environment: confinedRunnerEnvironment() }),
  }) as never);
}
const claimedCount = async (res: Response) => ((await res.json()) as { workers?: unknown[] }).workers?.length ?? 0;

type Outage = 'refused' | '503' | 'hang';
/** Own mode with a control plane that refuses every connection, answers 503, or accepts and never answers. */
/** `calls` counts the AttemptStarted requests it was sent. */
function controlPlaneDown(how: Outage = 'refused'): { calls: () => number } {
  process.env.EXECUTION_MODE = 'own';
  process.env.KERNEL_COMMAND_SECRET = 'k1:db-test-command-secret';
  resetKernelModeCache();
  resetAttemptStartBreaker();
  setKernelHost('web');
  const original = globalThis.fetch;
  let n = 0;
  const wrapped = (async (input: string | URL | Request, init?: RequestInit) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!href.startsWith(CONTROL_PLANE_URL)) return original(input, init);
    if (String(init?.body ?? '').includes('"op":"attempt_started"')) n++;
    if (how === '503') return Response.json({ v: 1, code: 'unavailable', error: 'down' }, { status: 503 });
    if (how === 'hang') return new Promise<Response>((_res, rej) => { init?.signal?.addEventListener('abort', () => rej(init.signal!.reason)); });
    throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
  }) as typeof fetch;
  globalThis.fetch = Object.assign(wrapped, { preconnect: (original as { preconnect?: unknown }).preconnect }) as typeof fetch;
  restoreFetch = () => { globalThis.fetch = original; };
  return { calls: () => n };
}

describe('a claim of a kernel owner task is started by the kernel', () => {
  test('the real claim: the kernel records the start and moves the task to assigned; the delivery stays WORKING', async () => {
    w = await world();
    const account = await serviceKey(await teamOf());
    const pr = await requeuedOwner('feat/start-real');
    expect((await taskRow(pr.ownerTaskId)).delivery_role).toBe('owner');
    const res = await claim(account, pr.ownerTaskId);
    expect(res.status).toBe(200);
    expect(await claimedCount(res)).toBe(1);
    const t = await taskRow(pr.ownerTaskId);
    expect({ status: t.status, claimedBy: t.claimed_by }).toEqual({ status: 'assigned', claimedBy: account.id });
    const s = await starts(pr);
    expect(s).toHaveLength(1);
    expect(s[0].key).toBe(`start:${pr.ownerTaskId}:${t.claimed_at}`);
    expect((await w.delivery(pr)).state).toBe('WORKING');
    // The claim is still on the database clock: the new worker row is not older than the claim.
    const [row] = await q<{ ok: boolean }>(sql`SELECT bool_and(t.claimed_at <= wk.created_at) AS ok FROM tasks t JOIN workers wk ON wk.task_id = t.id AND wk.status = 'idle' WHERE t.id = ${pr.ownerTaskId}::uuid`);
    expect(row.ok).toBe(true);
  });

  test('concurrent claims: exactly one wins, one worker, one start, and the task is the winner\'s', async () => {
    w = await world();
    const team = await teamOf();
    const accounts = await Promise.all([0, 1, 2, 3, 4].map(() => serviceKey(team)));
    const pr = await requeuedOwner('feat/start-race');
    const results = await Promise.all(accounts.map((a) => claim(a, pr.ownerTaskId).then(claimedCount)));
    expect(results.reduce((a, b) => a + b, 0)).toBe(1);
    const winner = accounts[results.indexOf(1)];
    const t = await taskRow(pr.ownerTaskId);
    expect({ status: t.status, claimedBy: t.claimed_by }).toEqual({ status: 'assigned', claimedBy: winner.id });
    expect(await liveWorkers(pr.ownerTaskId)).toBe(1);
    expect(await starts(pr)).toHaveLength(1);
  });

  test('a claim in flight (stamped, not started yet) holds off a second claimer; one a request left behind when it died expires', async () => {
    w = await world();
    const team = await teamOf();
    const [first, second] = await Promise.all([serviceKey(team), serviceKey(team)]);
    const pr = await requeuedOwner('feat/start-inflight');
    await q(sql`UPDATE tasks SET claimed_by = ${first.id}::uuid, claimed_at = now(), expires_at = now() + interval '15 minutes' WHERE id = ${pr.ownerTaskId}::uuid`);
    expect(await claimedCount(await claim(second, pr.ownerTaskId))).toBe(0);
    expect((await taskRow(pr.ownerTaskId)).status).toBe('pending');
    await q(sql`UPDATE tasks SET claimed_at = now() - interval '20 minutes', expires_at = now() - interval '5 minutes' WHERE id = ${pr.ownerTaskId}::uuid`);
    const res2 = await claim(second, pr.ownerTaskId);
    const body2 = await res2.json() as { workers?: unknown[] };
    expect(body2.workers?.length ? 'claimed' : JSON.stringify(body2)).toBe('claimed');
    expect((await taskRow(pr.ownerTaskId)).claimed_by).toBe(second.id);
    // The dead request's start, landing now, finds a claim that moved on.
    const late = await seam.attemptStarted({ task: { id: pr.ownerTaskId, workspaceId: w.workspaceId, deliveryId: pr.deliveryId, deliveryRole: 'owner', context: null }, claimedBy: first.id, claimedAt: '2026-01-01 00:00:00+00', source: 'claim' });
    expect(late.started).toBe(false);
    expect((await taskRow(pr.ownerTaskId)).claimed_by).toBe(second.id);
  });

  test('a task with no delivery keeps the claim\'s own status write, with no start', async () => {
    w = await world();
    const account = await serviceKey(await teamOf());
    const taskId = await seedTask(w.workspaceId, { title: 'plain claim' });
    expect(await claimedCount(await claim(account, taskId))).toBe(1);
    expect((await taskRow(taskId)).status).toBe('assigned');
    expect((await q<{ n: number }>(sql`SELECT count(*)::int AS n FROM workflow_transitions WHERE command = 'AttemptStarted' AND evidence->>'taskId' = ${taskId}`))[0].n).toBe(0);
  });
});

describe('the control plane down: the claim still starts, on the web host, and parks the start for a replay', () => {
  const interactiveHeaders = (accountId: string) => ({ [INTERACTIVE_SESSION_HEADER]: signInteractiveSession({ accountId, userId: null, sessionKey: 's-1' })! });

  /** One claim of a fresh requeued owner task under `how`, at the default budgets; its elapsed ms. */
  async function claimDuring(account: { id: string; key: string }, pr: OpenedPr, kind: 'runner' | 'interactive') {
    const t0 = Date.now();
    const res = await claim(account, pr.ownerTaskId, kind === 'interactive' ? { runner: 'mcp', headers: interactiveHeaders(account.id) } : {});
    const elapsed = Date.now() - t0;
    expect(res.status).toBe(200);
    expect(await claimedCount(res)).toBe(1);
    const t = await taskRow(pr.ownerTaskId);
    expect({ status: t.status, claimedBy: t.claimed_by }).toEqual({ status: 'assigned', claimedBy: account.id });
    // Projected, not recorded: the kernel's log gets it from the replay of the parked start.
    expect(await starts(pr)).toHaveLength(0);
    expect(await parkedStarts(pr)).toHaveLength(1);
    return elapsed;
  }

  for (const how of ['503', 'hang', 'refused'] as const) {
    test(`a control plane that ${how === 'hang' ? 'hangs' : how === '503' ? 'answers 503' : 'refuses connections'}, at the default budgets: a runner's first claim waits at most the start's own budget, the next skip the door, and an interactive claim never asks`, async () => {
      w = await world();
      const account = await serviceKey(await teamOf());
      process.env.AUTH_SECRET = 'db-test-interactive-secret';
      for (const k of ['KERNEL_CLAIM_BUDGET_MS', 'KERNEL_START_BUDGET_MS', 'KERNEL_DOOR_BUDGET_MS'] as const) delete process.env[k];
      const [a, b, c, d] = await Promise.all(['a', 'b', 'c', 'd'].map((tag) => requeuedOwner(`feat/start-${how}-${tag}`)));
      const cp = controlPlaneDown(how);

      const interactiveFirst = await claimDuring(account, a, 'interactive');
      expect(cp.calls()).toBe(0);
      const runnerFirst = await claimDuring(account, b, 'runner');
      const sentByFirst = cp.calls();
      expect(sentByFirst).toBeGreaterThan(0);
      const runnerNext = await claimDuring(account, c, 'runner');
      expect(cp.calls()).toBe(sentByFirst);
      const interactiveNext = await claimDuring(account, d, 'interactive');
      expect(cp.calls()).toBe(sentByFirst);

      process.stderr.write(`[claim-attempt-start] outage=${how}: runner first ${runnerFirst}ms, runner next ${runnerNext}ms, interactive ${interactiveFirst}ms / ${interactiveNext}ms\n`);
      // The start budget is 750 ms; the claim's own work rides on top. Before the fix: about 5-6 s each.
      expect(runnerFirst).toBeLessThan(2_000);
      expect(runnerNext).toBeLessThan(1_250);
      expect(interactiveFirst).toBeLessThan(1_250);
      expect(interactiveNext).toBeLessThan(1_250);
    });
  }
});

describe('a start projected without a kernel answer is replayed into the kernel\'s log', () => {
  const interactiveHeaders = (accountId: string) => ({ [INTERACTIVE_SESSION_HEADER]: signInteractiveSession({ accountId, userId: null, sessionKey: 's-replay' })! });

  async function claimAndPark(kind: 'interactive' | 'breaker-open') {
    w = await world();
    const account = await serviceKey(await teamOf());
    process.env.AUTH_SECRET = 'db-test-interactive-secret';
    const pr = await requeuedOwner(`feat/start-replay-${kind}`);
    if (kind === 'breaker-open') {
      const opening = await requeuedOwner('feat/start-replay-opening');
      controlPlaneDown('refused');
      expect(await claimedCount(await claim(account, opening.ownerTaskId))).toBe(1);
    }
    const res = kind === 'interactive'
      ? await claim(account, pr.ownerTaskId, { runner: 'mcp', headers: interactiveHeaders(account.id) })
      : await claim(account, pr.ownerTaskId);
    expect(await claimedCount(res)).toBe(1);
    const t = await taskRow(pr.ownerTaskId);
    expect(t.status).toBe('assigned');
    expect(await starts(pr)).toHaveLength(0);
    const parked = await parkedStarts(pr);
    expect(parked).toHaveLength(1);
    expect(parked[0]).toMatchObject({ status: 'pending', claimed_by: account.id });
    return { account, pr, key: parked[0].key, claimedAt: t.claimed_at! };
  }

  for (const kind of ['interactive', 'breaker-open'] as const) {
    test(`${kind}: the start is parked once, and the replay records the transition once without moving the assigned task`, async () => {
      const { pr, key, claimedAt } = await claimAndPark(kind);
      restoreFetch?.(); restoreFetch = null;
      const before = await taskRow(pr.ownerTaskId);
      expect(await floorPass([key])).toMatchObject({ claimed: 1, done: 1 });
      expect(await outboxRow(key)).toMatchObject({ status: 'done' });
      const s = await starts(pr);
      expect(s).toHaveLength(1);
      expect(s[0].key).toBe(`start:${pr.ownerTaskId}:${claimedAt}`);
      expect(await taskRow(pr.ownerTaskId)).toEqual(before);
      expect(await liveWorkers(pr.ownerTaskId)).toBe(1);
    });
  }

  test('a duplicate replay (the parked row put back) answers from the ledger and records nothing more', async () => {
    const { pr, key } = await claimAndPark('interactive');
    expect(await floorPass([key])).toMatchObject({ done: 1 });
    await q(sql`UPDATE workflow_command_outbox SET status = 'pending', outcome = NULL, not_before = now(), lease_until = NULL, completed_at = NULL WHERE idempotency_key = ${key}`);
    expect(await floorPass([key])).toMatchObject({ done: 1 });
    expect((await outboxRow(key)).outcome).toStartWith('replayed:');
    expect(await starts(pr)).toHaveLength(1);
  });

  test('a replay after the task moved on (requeued, claimed by someone else) records nothing harmful', async () => {
    const { account, pr, key } = await claimAndPark('interactive');
    const other = await serviceKey(await teamOf());
    await q(sql`UPDATE tasks SET status = 'pending', claimed_by = NULL, claimed_at = NULL, expires_at = NULL WHERE id = ${pr.ownerTaskId}::uuid`);
    await q(sql`UPDATE tasks SET claimed_by = ${other.id}::uuid, claimed_at = now() WHERE id = ${pr.ownerTaskId}::uuid`);
    const before = await taskRow(pr.ownerTaskId);
    expect(await floorPass([key])).toMatchObject({ claimed: 1 });
    expect(await taskRow(pr.ownerTaskId)).toEqual(before);
    expect(before.claimed_by).toBe(other.id);
    expect(before.claimed_by).not.toBe(account.id);
    expect(await q(sql`SELECT 1 FROM workflow_command_outbox WHERE idempotency_key = ${key} AND status = 'dead'`)).toEqual([]);
  });

  test('a start the kernel answered is not parked', async () => {
    w = await world();
    const account = await serviceKey(await teamOf());
    const pr = await requeuedOwner('feat/start-answered');
    expect(await claimedCount(await claim(account, pr.ownerTaskId))).toBe(1);
    expect(await starts(pr)).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 200));
    expect(await q(sql`SELECT 1 FROM workflow_command_outbox WHERE op = 'attempt_started' AND command_input->'task'->>'id' = ${pr.ownerTaskId}`)).toEqual([]);
  });
});

describe('a late or repeated start moves nothing', () => {
  const task = (pr: OpenedPr) => ({ id: pr.ownerTaskId, workspaceId: w!.workspaceId, deliveryId: pr.deliveryId, deliveryRole: 'owner', context: null });
  async function stamped(pr: OpenedPr, accountId: string): Promise<string> {
    const [r] = await q<{ at: string }>(sql`UPDATE tasks SET claimed_by = ${accountId}::uuid, claimed_at = now() WHERE id = ${pr.ownerTaskId}::uuid RETURNING claimed_at::text AS at`);
    return r.at;
  }

  test('a re-sent start is a duplicate; a start for a claim that was requeued and claimed again keeps the new claim', async () => {
    w = await world();
    const team = await teamOf();
    const [a, b] = await Promise.all([serviceKey(team), serviceKey(team)]);
    const pr = await requeuedOwner('feat/start-late');
    const stampA = await stamped(pr, a.id);
    const first = await seam.attemptStarted({ task: task(pr), claimedBy: a.id, claimedAt: stampA, source: 'claim' });
    expect(first).toMatchObject({ handled: true, started: true, result: { result: 'applied' } });
    const again = await seam.attemptStarted({ task: task(pr), claimedBy: a.id, claimedAt: stampA, source: 'claim' });
    expect(again.result?.result).toBe('duplicate');
    expect(again.started).toBe(true);
    expect(await starts(pr)).toHaveLength(1);
    // Requeued, then claimed by b: a's start re-sent now assigns nothing to a.
    await q(sql`UPDATE tasks SET status = 'pending', claimed_by = NULL, claimed_at = NULL WHERE id = ${pr.ownerTaskId}::uuid`);
    const stampB = await stamped(pr, b.id);
    const late = await seam.attemptStarted({ task: task(pr), claimedBy: a.id, claimedAt: stampA, source: 'claim' });
    expect(late.started).toBe(false);
    const t = await taskRow(pr.ownerTaskId);
    expect({ status: t.status, claimedBy: t.claimed_by, claimedAt: t.claimed_at }).toEqual({ status: 'pending', claimedBy: b.id, claimedAt: stampB });
  });

  test('the same account claims, the task is requeued, the same account claims again: the first claim\'s late start does not assign it and leaves the new claim alone', async () => {
    w = await world();
    const account = await serviceKey(await teamOf());
    const pr = await requeuedOwner('feat/start-same-account');
    const first = await stamped(pr, account.id);
    // Requeued before the first start arrived, then claimed again by the same account (its start not sent yet).
    await q(sql`UPDATE tasks SET claimed_by = NULL, claimed_at = NULL, expires_at = NULL WHERE id = ${pr.ownerTaskId}::uuid`);
    await q(sql`SELECT pg_sleep(0.01)`);
    const second = await stamped(pr, account.id);
    expect(second).not.toBe(first);
    const late = await seam.attemptStarted({ task: task(pr), claimedBy: account.id, claimedAt: first, source: 'claim' });
    expect(late.started).toBe(false);
    let t = await taskRow(pr.ownerTaskId);
    expect({ status: t.status, claimedBy: t.claimed_by, claimedAt: t.claimed_at }).toEqual({ status: 'pending', claimedBy: account.id, claimedAt: second });
    // The second claim's own start is the one that assigns it.
    const own = await seam.attemptStarted({ task: task(pr), claimedBy: account.id, claimedAt: second, source: 'claim' });
    expect(own.started).toBe(true);
    t = await taskRow(pr.ownerTaskId);
    expect({ status: t.status, claimedAt: t.claimed_at }).toEqual({ status: 'assigned', claimedAt: second });
  });

  test('a cancel between the compare-and-set and the start: the start moves nothing, the task stays cancelled', async () => {
    w = await world();
    const account = await serviceKey(await teamOf());
    const pr = await requeuedOwner('feat/start-cancelled');
    const stamp = await stamped(pr, account.id);
    await q(sql`UPDATE tasks SET status = 'cancelled' WHERE id = ${pr.ownerTaskId}::uuid`);
    const r = await seam.attemptStarted({ task: task(pr), claimedBy: account.id, claimedAt: stamp, source: 'claim' });
    expect(r.started).toBe(false);
    expect((await taskRow(pr.ownerTaskId)).status).toBe('cancelled');
  });

  test('past WORKING (a loop task\'s next iteration): not bound, still started by the guarded projection', async () => {
    w = await world();
    const account = await serviceKey(await teamOf());
    const pr = await w.openPr({ branch: 'feat/start-next-iteration', files: { 'src/n.ts': 'export const n = 1;\n' } });
    await w.handOn(pr);
    expect((await w.delivery(pr)).state).toBe('AWAITING_REVIEW');
    await q(sql`UPDATE tasks SET status = 'pending', claimed_by = NULL, claimed_at = NULL WHERE id = ${pr.ownerTaskId}::uuid`);
    const stamp = await stamped(pr, account.id);
    const r = await seam.attemptStarted({ task: task(pr), claimedBy: account.id, claimedAt: stamp, source: 'claim' });
    expect(r.result).toMatchObject({ result: 'stale', reason: 'attempt_not_bound' });
    expect(r.started).toBe(true);
    expect((await taskRow(pr.ownerTaskId)).status).toBe('assigned');
    expect((await w.delivery(pr)).state).toBe('AWAITING_REVIEW');
  });

  test('hot path: what the start adds on the web host (shadow), measured', async () => {
    w = await world();
    const account = await serviceKey(await teamOf());
    const samples: number[] = [];
    for (let i = 0; i < 8; i++) {
      const pr = await requeuedOwner(`feat/start-latency-${i}`);
      const stamp = await stamped(pr, account.id);
      const t0 = performance.now();
      const r = await seam.attemptStarted({ task: task(pr), claimedBy: account.id, claimedAt: stamp, source: 'claim' });
      samples.push(performance.now() - t0);
      expect(r.started).toBe(true);
    }
    samples.sort((x, y) => x - y);
    process.stderr.write(`[claim-attempt-start] AttemptStarted on the web host: median ${samples[4].toFixed(1)}ms, max ${samples[7].toFixed(1)}ms over ${samples.length} starts (local Postgres via the neon-http shim)\n`);
    expect(samples[4]).toBeLessThan(2_000);
  });
});
