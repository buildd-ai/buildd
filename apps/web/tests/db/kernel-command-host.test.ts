/**
 * The single host (docs/specs/workflow-kernel-library.md §3, AC-9 to AC-12) on
 * real Postgres against the stateful fake GitHub: in own mode a web-host door
 * submits a command, the control plane applies it and drains its effects, and
 * every transition says which host wrote it.
 *
 * The control plane runs in this process: `installControlPlane` answers
 * requests to its URL with the real endpoint (command-api.ts), with the kernel
 * host set to `control-plane` while it runs. The door side is the real client
 * (kernel-client.ts) with the web host's own-mode setting.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { q } from './harness';
import { seam, world, type OpenedPr, type World } from './workflow-scenarios-world';

const { handleCommandRequest } = await import('../../src/lib/workflow/command-api');
const { submitKernelCommand, ControlPlaneUnavailableError, resetKernelModeCache, CONTROL_PLANE_URL, observeCiGreen, attemptEnded, systemPrincipal } = await import('../../src/lib/workflow/kernel-client');
const { drainParkedCommands, postgresCommandOutbox } = await import('../../src/lib/workflow/command-outbox');
const { setKernelHost } = await import('../../src/lib/workflow/kernel-host');
const { runScheduledKernelFloor, lastControlPlaneFloorAt, controlPlaneFloorStale } = await import('../../src/lib/workflow/kernel-floor');
const { postgresCommandLedger, COMMAND_LEASE_MS, COMMAND_HEARTBEAT_MS } = await import('../../src/lib/workflow/command-ledger');
const { applyCommand } = await import('../../src/lib/workflow/kernel');

const ENV_KEYS = ['EXECUTION_MODE', 'CRON_SECRET', 'KERNEL_COMMAND_SECRET', 'VERCEL', 'BUILDD_CRON_RUN_RECORD_IN_TESTS', 'KERNEL_DOOR_BUDGET_MS'] as const;
const savedEnv: Record<string, string | undefined> = {};

interface ControlPlane {
  calls: Array<{ path: string; op: string | null }>;
  /** The idempotency key of each request, in order. */
  keys: Array<string | null>;
  down: boolean;
  /** It applies the command, and the answer is lost on the way back (a reset after the body was sent). */
  losesAnswers: boolean;
  restore(): void;
}

/** The control plane in-process: its URL is answered by the real command endpoint, as the control-plane host. */
function installControlPlane(): ControlPlane {
  const original = globalThis.fetch;
  let depth = 0;
  const cp: ControlPlane = { calls: [], keys: [], down: false, losesAnswers: false, restore: () => { globalThis.fetch = original; } };
  const wrapped = (async (input: string | URL | Request, init?: RequestInit) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!href.startsWith(CONTROL_PLANE_URL)) return original(input, init);
    let op: string | null = null;
    let key: string | null = null;
    try { ({ op = null, idempotencyKey: key = null } = JSON.parse(String(init?.body ?? '{}'))); } catch { /* not JSON */ }
    cp.calls.push({ path: new URL(href).pathname, op });
    cp.keys.push(key);
    // Unreachable: the connection is refused, so nothing was sent.
    if (cp.down) throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
    depth++;
    setKernelHost('control-plane');
    try {
      const res = await handleCommandRequest(new Request(href, init));
      if (cp.losesAnswers) throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) });
      return res;
    } finally {
      if (--depth === 0) setKernelHost('web');
    }
  }) as typeof fetch;
  globalThis.fetch = Object.assign(wrapped, { preconnect: (original as { preconnect?: unknown }).preconnect }) as typeof fetch;
  return cp;
}

let w: World | undefined;
let cp: ControlPlane | undefined;

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  // Switched over: the web host in own mode (explicit, as on a local e2e), and the command key on both sides.
  process.env.EXECUTION_MODE = 'own';
  process.env.KERNEL_COMMAND_SECRET = 'k1:db-test-command-secret';
  delete process.env.CRON_SECRET;
  delete process.env.VERCEL;
  resetKernelModeCache();
  setKernelHost('web');
});

afterEach(() => {
  cp?.restore();
  cp = undefined;
  w?.dispose();
  w = undefined;
  setKernelHost('web');
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

/** A person on the workspace's team: the principal the door vouches for. */
async function teamMember(workspaceId: string): Promise<string> {
  const [ws] = await q<{ team_id: string }>(sql`SELECT team_id FROM workspaces WHERE id = ${workspaceId}::uuid`);
  const [u] = await q<{ id: string }>(sql`INSERT INTO users (email) VALUES (${`u-${crypto.randomUUID()}@example.test`}) RETURNING id`);
  await q(sql`INSERT INTO team_members (team_id, user_id, role) VALUES (${ws.team_id}::uuid, ${u.id}::uuid, 'member')`);
  return u.id;
}

/** Shadow-mode setup on the web host (the world's helpers run the seam here), then own mode for the act. */
async function approvedPr(branch: string): Promise<{ pr: OpenedPr; head: string; userId: string }> {
  process.env.EXECUTION_MODE = 'shadow';
  w = await world();
  const pr = await w.openPr({ branch, files: { 'src/a.ts': 'export const a = 2;\n' } });
  await w.approve(pr);
  const head = w.gh.pr(w.repo, pr.prNumber).headSha;
  const userId = await teamMember(w.workspaceId);
  process.env.EXECUTION_MODE = 'own';
  resetKernelModeCache();
  return { pr, head, userId };
}

const hostsSince = async (deliveryId: string, afterVersion: number) =>
  q<{ command: string; host: string | null }>(sql`SELECT command, host FROM workflow_transitions WHERE delivery_id = ${deliveryId}::uuid AND to_version > ${afterVersion} ORDER BY to_version`);

function landInput(pr: OpenedPr, head: string, userId: string) {
  return { workspaceId: w!.workspaceId, installationId: w!.installationId, repoFullName: w!.repo, prNumber: pr.prNumber, headSha: head, door: 'dashboard', actor: `human:${userId}` };
}

describe('AC-9: in own mode the web host submits and the control plane applies', () => {
  test('a person\'s merge from the web host → one command to the control plane, T15 applied and the merge drained there; every transition it wrote is tagged control-plane, none web', async () => {
    const { pr, head, userId } = await approvedPr('feat/own-merge');
    const before = (await w!.delivery(pr)).version;
    cp = installControlPlane();

    const answer = await submitKernelCommand('land', landInput(pr, head, userId), { principal: { kind: 'user', id: userId } });

    expect(answer.host).toBe('control-plane');
    expect(answer.result).toMatchObject({ merged: true, outcome: 'merged' });
    expect(cp.calls).toEqual([{ path: '/v1/commands', op: 'land' }]);
    expect(w!.mergeCalls(pr).map((c) => c.status)).toEqual([200]);
    const d = await w!.delivery(pr);
    expect(d.state).toBe('MERGED');
    expect(answer.delivery).toEqual({ id: pr.deliveryId, version: d.version });
    const written = await hostsSince(pr.deliveryId, before);
    expect(written.map((t) => t.command)).toEqual(expect.arrayContaining(['LandingRequested', 'PrMerged']));
    expect(written.filter((t) => t.host !== 'control-plane')).toEqual([]);
  });

  test('a web-host caller that would drain inline asks the control plane to drain instead: the effect runs there', async () => {
    const { pr, head } = await approvedPr('feat/own-inline-drain');
    const before = (await w!.delivery(pr)).version;
    // A command applied without its drain (the shape of any web-host caller that is not yet a door).
    const live = { state: 'open' as const, merged: false, headSha: head, headRepoFullName: w!.repo, baseRef: 'dev' };
    const landed = await applyCommand({ type: 'LandingRequested', actor: 'system:test', door: 'auto', headSha: head, live, rails: { passed: true } }, { ref: { deliveryId: pr.deliveryId } });
    expect(landed.result).toBe('applied');
    cp = installControlPlane();

    await seam.drainDelivery(pr.deliveryId);

    expect(cp.calls).toEqual([{ path: '/v1/commands', op: 'drain' }]);
    expect(w!.mergeCalls(pr).map((c) => c.status)).toEqual([200]);
    const written = await hostsSince(pr.deliveryId, before + 1);
    expect(written.map((t) => t.command)).toContain('PrMerged');
    expect(written.filter((t) => t.host !== 'control-plane')).toEqual([]);
  });

  test('a green head from the check_suite webhook → one observe_ci_green command; the control plane reads the live checks and records the CI reading, tagged control-plane', async () => {
    process.env.EXECUTION_MODE = 'shadow';
    w = await world();
    const pr = await w.openPr({ branch: 'feat/own-ci-green', files: { 'src/a.ts': 'export const a = 3;\n' } });
    await w.handOn(pr);
    const head = w.gh.pr(w.repo, pr.prNumber).headSha;
    // Green on GitHub, its webhook not delivered: the door below is the only report of it.
    w.gh.greenCi(w.repo, head, ['build', 'test']);
    process.env.EXECUTION_MODE = 'own';
    resetKernelModeCache();
    const before = (await w.delivery(pr)).version;
    cp = installControlPlane();

    const seen = await observeCiGreen(
      { workspaceId: w.workspaceId, repoFullName: w.repo, prNumber: pr.prNumber, installationId: w.installationId, headSha: head, source: 'webhook:check_suite' },
      { principal: systemPrincipal('system:webhook:check_suite') },
    );

    expect(seen).toMatchObject({ handled: true, result: { result: 'applied' } });
    expect(cp.calls.filter((c) => c.op !== 'drain')).toEqual([{ path: '/v1/commands', op: 'observe_ci_green' }]);
    const written = await hostsSince(pr.deliveryId, before);
    expect(written.map((t) => t.command)).toContain('CiObserved');
    expect(written.filter((t) => t.host !== 'control-plane')).toEqual([]);
  });

  test('in shadow nothing is submitted: the web host applies, and its rows say web', async () => {
    const { pr, head, userId } = await approvedPr('feat/shadow-merge');
    process.env.EXECUTION_MODE = 'shadow';
    resetKernelModeCache();
    const before = (await w!.delivery(pr)).version;
    cp = installControlPlane();
    const answer = await submitKernelCommand('land', landInput(pr, head, userId), { principal: { kind: 'user', id: userId } });
    expect(answer).toMatchObject({ host: 'web', result: { merged: true } });
    expect(cp.calls).toEqual([]);
    const written = await hostsSince(pr.deliveryId, before);
    expect(written.length).toBeGreaterThan(0);
    expect(written.every((t) => t.host === 'web')).toBe(true);
  });
});

describe('AC-11: one idempotency key, one transition', () => {
  test('the same landing submitted twice at once with one key → one LandingRequested, one merge call, and both callers get the same result and version', async () => {
    const { pr, head, userId } = await approvedPr('feat/double-submit');
    const before = (await w!.delivery(pr)).version;
    cp = installControlPlane();
    const opts = { principal: { kind: 'user' as const, id: userId }, idempotencyKey: `land:${crypto.randomUUID()}` };

    const [a, b] = await Promise.all([submitKernelCommand('land', landInput(pr, head, userId), opts), submitKernelCommand('land', landInput(pr, head, userId), opts)]);

    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
    expect(a.result).toEqual(b.result);
    expect(a.delivery).toEqual(b.delivery);
    expect(w!.mergeCalls(pr)).toHaveLength(1);
    const written = await hostsSince(pr.deliveryId, before);
    expect(written.filter((t) => t.command === 'LandingRequested')).toHaveLength(1);
    const rows = await q<{ status: string; delivery_version: number; host: string }>(sql`SELECT status, delivery_version, host FROM workflow_commands WHERE idempotency_key = ${opts.idempotencyKey}`);
    expect(rows.map((r) => ({ ...r, delivery_version: Number(r.delivery_version) }))).toEqual([{ status: 'done', delivery_version: a.delivery!.version, host: 'control-plane' }]);
  });
});

describe('AC-12: the control plane unreachable', () => {
  test('the door gets a retryable error naming the control plane, and nothing is applied anywhere', async () => {
    const { pr, head, userId } = await approvedPr('feat/cp-down');
    const before = await w!.delivery(pr);
    cp = installControlPlane();
    cp.down = true;

    const err = await submitKernelCommand('land', landInput(pr, head, userId), { principal: { kind: 'user', id: userId }, budgetMs: 1_500 }).catch((e) => e);

    expect(err).toBeInstanceOf(ControlPlaneUnavailableError);
    expect(err.message).toContain('control plane');
    expect(cp.calls.length).toBeGreaterThan(0);
    expect(w!.mergeCalls(pr)).toEqual([]);
    expect(await w!.delivery(pr)).toMatchObject({ state: 'APPROVED', version: before.version });
  });
});

/** Each test waits out real door budgets (the control plane down), more than once: slow CI runners need room. */
const AC35_TIMEOUT_MS = 30_000;

describe('AC-35: a door command the control plane never answered lands once it recovers, exactly once', () => {
  /** A PR whose owner is still working, set up in shadow; then own mode for the act, with a short door budget. */
  async function working(branch: string) {
    process.env.EXECUTION_MODE = 'shadow';
    w = await world();
    const pr = await w.openPr({ branch, files: { 'src/a.ts': 'export const a = 5;\n' } });
    process.env.EXECUTION_MODE = 'own';
    process.env.KERNEL_DOOR_BUDGET_MS = '800';
    resetKernelModeCache();
    return pr;
  }
  const runner = systemPrincipal('system:test-runner');
  const ownerEnd = (pr: OpenedPr) => ({
    task: { id: pr.ownerTaskId, workspaceId: w!.workspaceId, deliveryId: pr.deliveryId, deliveryRole: 'owner', context: null },
    workerId: pr.workerId, status: 'completed' as const, localHeadSha: w!.gh.pr(w!.repo, pr.prNumber).headSha, commitCount: 1, source: 'runner',
  });
  const parked = async (key: string) =>
    (await q<{ status: string; outcome: string | null; prior_unknown: boolean; attempt_count: number }>(sql`SELECT status, outcome, prior_unknown, attempt_count FROM workflow_command_outbox WHERE idempotency_key = ${key}`))[0];
  const ledgerRows = async (key: string) => q<{ status: string; host: string }>(sql`SELECT status, host FROM workflow_commands WHERE idempotency_key = ${key}`);
  const countOf = async (pr: OpenedPr, command: string) => (await w!.commands(pr)).filter((c) => c === command).length;
  /** The floor's pass, scoped to this test's keys: the shared database holds other files' rows. */
  const floorPass = (keys: string[], host: 'control-plane' | 'web') => {
    const outbox = postgresCommandOutbox();
    return drainParkedCommands({ host: () => host, outbox: { ...outbox, claimDue: async (n) => (await outbox.claimDue(n)).filter((r) => keys.includes(r.key)) } });
  };
  async function onControlPlane<T>(fn: () => Promise<T>): Promise<T> {
    setKernelHost('control-plane');
    try { return await fn(); } finally { setKernelHost('web'); }
  }

  test('an attempt end while the control plane is down is parked under its key; after it recovers the control plane\'s floor applies it once, and a repeat is answered from the ledger', async () => {
    const pr = await working('feat/park-end');
    cp = installControlPlane();
    cp.down = true;
    const key = `attempt_ended:${crypto.randomUUID()}`;

    const err = await attemptEnded(ownerEnd(pr), { principal: runner, idempotencyKey: key }).catch((e) => e);

    expect(err).toBeInstanceOf(ControlPlaneUnavailableError);
    expect(err.parked).toBe(true);
    expect((await w!.delivery(pr)).state).toBe('WORKING');
    expect(await parked(key)).toMatchObject({ status: 'pending', prior_unknown: false });
    expect(await ledgerRows(key)).toEqual([]);

    // Recovered. The control plane's floor applies the row itself: the same reach check and ledger, no request.
    cp.down = false;
    cp.calls.length = 0;
    const before = (await w!.delivery(pr)).version;
    const s = await onControlPlane(() => floorPass([key], 'control-plane'));

    expect(s).toMatchObject({ claimed: 1, done: 1, dead: 0 });
    expect(cp.calls.filter((c) => c.op === 'attempt_ended')).toEqual([]);
    expect((await w!.delivery(pr)).state).toBe('AWAITING_REVIEW');
    expect(await countOf(pr, 'AttemptEnded')).toBe(1);
    expect((await hostsSince(pr.deliveryId, before)).filter((t) => t.host !== 'control-plane')).toEqual([]);
    expect(await parked(key)).toMatchObject({ status: 'done', outcome: 'applied' });
    expect(await ledgerRows(key)).toEqual([{ status: 'done', host: 'control-plane' }]);

    // Exactly once: another floor pass has nothing to do, and the door's own retry with the key is replayed.
    expect(await onControlPlane(() => floorPass([key], 'control-plane'))).toMatchObject({ claimed: 0 });
    const again = await submitKernelCommand('attempt_ended', { ...ownerEnd(pr), workspaceId: w!.workspaceId }, { principal: runner, idempotencyKey: key });
    expect(again.replayed).toBe(true);
    expect(await countOf(pr, 'AttemptEnded')).toBe(1);
  }, AC35_TIMEOUT_MS);

  test('GitHub\'s one green while the control plane is down: the web host\'s floor re-submits it with the same key once it answers, and it is recorded once', async () => {
    const pr = await working('feat/park-green');
    await w!.handOn(pr);
    const head = w!.gh.pr(w!.repo, pr.prNumber).headSha;
    w!.gh.greenCi(w!.repo, head, ['build', 'test']);
    cp = installControlPlane();
    cp.down = true;
    const green = { workspaceId: w!.workspaceId, repoFullName: w!.repo, prNumber: pr.prNumber, installationId: w!.installationId, headSha: head, source: 'webhook:check_suite' };
    const key = `observe_ci_green:${crypto.randomUUID()}`;

    const err = await observeCiGreen(green, { principal: systemPrincipal('system:webhook:check_suite'), idempotencyKey: key }).catch((e) => e);
    expect(err.parked).toBe(true);

    // Still down at the next pass: nothing lands, the row waits (its retry delay passes before the next one).
    expect(await floorPass([key], 'web')).toMatchObject({ claimed: 1, retried: 1, done: 0 });
    expect(await countOf(pr, 'CiObserved')).toBe(0);
    await q(sql`UPDATE workflow_command_outbox SET not_before = now() WHERE idempotency_key = ${key}`);

    cp.down = false;
    cp.keys.length = 0;
    cp.calls.length = 0;
    expect(await floorPass([key], 'web')).toMatchObject({ claimed: 1, done: 1 });
    expect(cp.calls.filter((c) => c.op !== 'drain')).toEqual([{ path: '/v1/commands', op: 'observe_ci_green' }]);
    expect(cp.keys.filter((k) => k?.startsWith('observe_ci_green'))).toEqual([key]);
    expect(await countOf(pr, 'CiObserved')).toBe(1);
    expect(await parked(key)).toMatchObject({ status: 'done', outcome: 'applied', attempt_count: 2 });
    expect(await floorPass([key], 'web')).toMatchObject({ claimed: 0 });
    expect(await countOf(pr, 'CiObserved')).toBe(1);
  }, AC35_TIMEOUT_MS);

  test('applied there but the answer was lost (unknown): parked as unknown, and the ledger\'s word settles it without applying it twice', async () => {
    const pr = await working('feat/park-unknown');
    cp = installControlPlane();
    cp.losesAnswers = true;
    const key = `attempt_ended:${crypto.randomUUID()}`;

    const err = await attemptEnded(ownerEnd(pr), { principal: runner, idempotencyKey: key }).catch((e) => e);

    expect(err).toBeInstanceOf(ControlPlaneUnavailableError);
    expect(err.outcome).toBe('unknown');
    expect(await parked(key)).toMatchObject({ status: 'pending', prior_unknown: true });
    expect(await countOf(pr, 'AttemptEnded')).toBe(1);

    cp.losesAnswers = false;
    cp.calls.length = 0;
    expect(await floorPass([key], 'web')).toMatchObject({ done: 1 });
    // Settled from the ledger: nothing sent, nothing run here.
    expect(cp.calls.filter((c) => c.op === 'attempt_ended')).toEqual([]);
    expect(await parked(key)).toMatchObject({ status: 'done', outcome: 'replayed:applied' });
    expect(await countOf(pr, 'AttemptEnded')).toBe(1);
  }, AC35_TIMEOUT_MS);

  test('an old green re-sent after a newer head is answered as for another head and settled, never recorded for the new one', async () => {
    const pr = await working('feat/park-stale-green');
    await w!.handOn(pr);
    const oldHead = w!.gh.pr(w!.repo, pr.prNumber).headSha;
    w!.gh.greenCi(w!.repo, oldHead, ['build', 'test']);
    cp = installControlPlane();
    cp.down = true;
    const key = `observe_ci_green:${crypto.randomUUID()}`;
    await observeCiGreen({ workspaceId: w!.workspaceId, repoFullName: w!.repo, prNumber: pr.prNumber, installationId: w!.installationId, headSha: oldHead, source: 'webhook:check_suite' },
      { principal: systemPrincipal('system:webhook:check_suite'), idempotencyKey: key }).catch(() => null);
    expect(await parked(key)).toMatchObject({ status: 'pending' });

    // A newer head arrives while it waits.
    w!.gh.push(w!.repo, pr.branch, { 'src/a.ts': 'export const a = 6;\n' }, { message: 'newer' });
    process.env.EXECUTION_MODE = 'shadow';
    await w!.deliver();
    process.env.EXECUTION_MODE = 'own';
    resetKernelModeCache();
    const newHead = w!.gh.pr(w!.repo, pr.prNumber).headSha;
    expect((await w!.delivery(pr)).currentHeadSha).toBe(newHead);
    const before = await countOf(pr, 'CiObserved');

    cp.down = false;
    expect(await onControlPlane(() => floorPass([key], 'control-plane'))).toMatchObject({ done: 1, dead: 0 });
    expect(await countOf(pr, 'CiObserved')).toBe(before);
    expect(await parked(key)).toMatchObject({ status: 'done', outcome: 'answered' });
  }, AC35_TIMEOUT_MS);
});

describe('AC-10: the drain and the floor on the control plane, with the web app absent', () => {
  test('the cron tick drains a due merge and runs the floor; no request goes to the web app; its run is recorded as the control plane\'s', async () => {
    // Record the run as production does (cron-run.ts skips recording in tests unless asked).
    process.env.BUILDD_CRON_RUN_RECORD_IN_TESTS = '1';
    const cronSecret = 'db-test-cron-secret';
    process.env.CRON_SECRET = cronSecret;
    const priorFloor = await lastControlPlaneFloorAt();
    const { pr, head } = await approvedPr('feat/cron-drain');
    const live = { state: 'open' as const, merged: false, headSha: head, headRepoFullName: w!.repo, baseRef: 'dev' };
    setKernelHost('control-plane');
    const landed = await applyCommand({ type: 'LandingRequested', actor: 'system:test', door: 'auto', headSha: head, live, rails: { passed: true } }, { ref: { deliveryId: pr.deliveryId } });
    expect(landed.result).toBe('applied');
    const before = (await w!.delivery(pr)).version;

    // The web app paused: anything addressed to it fails, and is recorded.
    const toWeb: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (/^https:\/\/(www\.)?buildd\.dev\//.test(href)) { toWeb.push(href); throw new TypeError('the web app is paused'); }
      return original(input, init);
    }) as typeof fetch;
    let floorRan = false;
    try {
      const r = await runScheduledKernelFloor({
        env: { EXECUTION_MODE: 'own', KERNEL_COMMAND_SECRET: 'k1:db-test-command-secret', CRON_SECRET: cronSecret },
        // Scoped to this world's delivery: the shared test database holds other files' rows.
        deps: {
          drainDueEffects: async () => (await seam.drainDelivery(pr.deliveryId))!,
          reconcileKernelDeliveries: async () => { floorRan = true; return seam.reconcileKernelDeliveries({}, { only: [pr.deliveryId], minQuietMs: 0 }); },
          reconcileTrunkIncidents: async () => ({ checked: 0, resolved: 0, recovered: 0, stillRed: 0, errors: 0 }),
          restartTreadmillCycles: async () => ({ checked: 0, restarted: 0, refused: 0, errors: 0 }),
        },
      });
      expect(r.ran).toBe(true);
    } finally {
      globalThis.fetch = original;
    }

    expect(toWeb).toEqual([]);
    expect(floorRan).toBe(true);
    expect(w!.mergeCalls(pr).map((c) => c.status)).toEqual([200]);
    expect((await w!.delivery(pr)).state).toBe('MERGED');
    const written = await hostsSince(pr.deliveryId, before);
    expect(written.map((t) => t.command)).toContain('PrMerged');
    expect(written.filter((t) => t.host !== 'control-plane')).toEqual([]);

    // The run record the web host's liveness fallback reads: this host, just now, so not stale.
    const [run] = await q<{ ok: boolean; host: string }>(sql`SELECT ok, result->>'host' AS host FROM cron_runs WHERE job = 'kernel-floor' ORDER BY started_at DESC LIMIT 1`);
    expect(run).toEqual({ ok: true, host: 'control-plane' });
    const last = await lastControlPlaneFloorAt();
    expect(last).not.toBeNull();
    if (priorFloor) expect(last!.getTime()).toBeGreaterThanOrEqual(priorFloor.getTime());
    expect(controlPlaneFloorStale(last)).toBe(false);
    expect(controlPlaneFloorStale(last, last!.getTime() + 2 * 60 * 60_000 + 1)).toBe(true);
  });
});

describe('open_delivery names a workspace and its own task', () => {
  test('an owner task from another workspace opens nothing', async () => {
    const { seedTask, seedWorkspace } = await import('./harness');
    process.env.EXECUTION_MODE = 'shadow';
    w = await world();
    const other = await seedWorkspace();
    const foreignTask = await seedTask(other.workspaceId, { status: 'in_progress' });
    const r = await seam.openKernelDelivery({ workspaceId: w.workspaceId, ownerTaskId: foreignTask, repoFullName: w.repo, prNumber: 9, installationId: w.installationId, source: 'test' });
    expect(r).toEqual({ owned: false, reason: 'no_task' });
    const [{ n }] = await q<{ n: string }>(sql`SELECT count(*) AS n FROM workflow_deliveries WHERE owner_task_id = ${foreignTask}::uuid`);
    expect(Number(n)).toBe(0);
  });
});

describe('the ledger on Postgres', () => {
  test('a completed key past the lease is never taken over: its stored answer stands and nothing runs again', async () => {
    const ledger = postgresCommandLedger();
    const key = `test:${crypto.randomUUID()}`;
    const base = { key, op: 'land', principal: 'system:test', requestHash: 'h1', host: 'control-plane' };
    expect(await ledger.claim({ ...base, token: 't1' })).toBe(true);
    expect(await ledger.complete({ key, token: 't1', response: { status: 200, body: { first: true } }, deliveryId: null, deliveryVersion: 1 })).toBe(true);
    await q(sql`UPDATE workflow_commands SET claimed_at = now() - make_interval(secs => ${COMMAND_LEASE_MS / 1000 + 60}::double precision) WHERE idempotency_key = ${key}`);
    expect(await ledger.claim({ ...base, token: 't2' })).toBe(false);
    expect(await ledger.read(key)).toMatchObject({ status: 'done', response: { status: 200, body: { first: true } } });
  });

  test('a running claim renews its lease: a renewed claim is never taken over; a dead one is, promptly; only the holder renews', async () => {
    const ledger = postgresCommandLedger();
    const key = `test:${crypto.randomUUID()}`;
    const base = { key, op: 'drain', principal: 'system:inline-drain', requestHash: 'h1', host: 'control-plane' };
    const age = (secs: number) => q(sql`UPDATE workflow_commands SET claimed_at = clock_timestamp() - make_interval(secs => ${secs}::double precision) WHERE idempotency_key = ${key}`);
    expect(await ledger.claim({ ...base, token: 'live' })).toBe(true);
    // Long running, but renewed on its heartbeat: past the lease since it was claimed, never since renewed.
    await age(COMMAND_LEASE_MS / 1000 + 30);
    expect(await ledger.renew({ key, token: 'live' })).toBe(true);
    expect(await ledger.claim({ ...base, token: 'intruder' })).toBe(false);
    expect(await ledger.renew({ key, token: 'intruder' })).toBe(false);
    // The request was cancelled mid-command: no renewals, and one lease later the key is taken over.
    await age(COMMAND_LEASE_MS / 1000 + 1);
    expect(await ledger.claim({ ...base, token: 'takeover' })).toBe(true);
    // The dead claim can neither renew nor complete.
    expect(await ledger.renew({ key, token: 'live' })).toBe(false);
    expect(await ledger.complete({ key, token: 'live', response: { status: 200, body: {} }, deliveryId: null, deliveryVersion: null })).toBe(false);
    expect(await ledger.complete({ key, token: 'takeover', response: { status: 200, body: { ok: true } }, deliveryId: null, deliveryVersion: null })).toBe(true);
    // A completed key is not renewable.
    expect(await ledger.renew({ key, token: 'takeover' })).toBe(false);
    expect(COMMAND_HEARTBEAT_MS * 3).toBeLessThanOrEqual(COMMAND_LEASE_MS);
  });

  test('claim once per key; completion and release only by the current claim; a dead claim is taken over after the lease; prune keeps recent keys', async () => {
    const ledger = postgresCommandLedger();
    const key = `test:${crypto.randomUUID()}`;
    const base = { key, op: 'land', principal: 'system:test', requestHash: 'h1', host: 'control-plane' };
    expect(await ledger.claim({ ...base, token: 't1' })).toBe(true);
    expect(await ledger.claim({ ...base, token: 't2' })).toBe(false);
    expect(await ledger.complete({ key, token: 't2', response: { status: 200, body: {} }, deliveryId: null, deliveryVersion: null })).toBe(false);
    await ledger.release({ key, token: 't2' });
    expect((await ledger.read(key))?.status).toBe('running');

    // The isolate holding t1 died: past the lease the key is claimable again, by the same request only.
    await q(sql`UPDATE workflow_commands SET claimed_at = now() - make_interval(secs => ${COMMAND_LEASE_MS / 1000 + 5}::double precision) WHERE idempotency_key = ${key}`);
    expect(await ledger.claim({ ...base, requestHash: 'another-request', token: 't3' })).toBe(false);
    expect(await ledger.claim({ ...base, token: 't4' })).toBe(true);
    expect(await ledger.complete({ key, token: 't1', response: { status: 200, body: { stale: true } }, deliveryId: null, deliveryVersion: null })).toBe(false);
    expect(await ledger.complete({ key, token: 't4', response: { status: 200, body: { ok: true } }, deliveryId: null, deliveryVersion: 3 })).toBe(true);
    expect(await ledger.read(key)).toMatchObject({ status: 'done', response: { status: 200, body: { ok: true } } });

    const old = `test:${crypto.randomUUID()}`;
    expect(await ledger.claim({ ...base, key: old, token: 't5' })).toBe(true);
    await q(sql`UPDATE workflow_commands SET created_at = now() - interval '8 days' WHERE idempotency_key = ${old}`);
    expect(await ledger.prune()).toBeGreaterThanOrEqual(1);
    expect(await ledger.read(old)).toBeNull();
    expect(await ledger.read(key)).not.toBeNull();
  });
});
