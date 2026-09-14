import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

/**
 * The delivery half of the memory-digest readout.
 *
 * The arithmetic is tested against literal rows in
 * `packages/core/__tests__/memory-digest-readout.test.ts`. This file is about
 * the three things only the route can get wrong:
 *
 *  1. A quiet run is genuinely quiet. A daily job that pushes on every run is
 *     a job whose notifications get muted, which is indistinguishable from not
 *     having built it.
 *  2. A terminal verdict pushes exactly once, ever — the claim is atomic and
 *     taken before the send.
 *  3. The route reports a VERDICT to `withCronRun`, not just a heartbeat.
 *     `evaluateCronHealth` discards any run reporting neither `changed` nor
 *     `errors`, so a route that reports nothing is unalarmable by
 *     construction: it would run green over an empty cohort for ever.
 */

// ── withCronRun's own dependencies ──────────────────────────────────────────

// `__table` is a marker this file adds so the db stub can tell which table an
// insert went to — the cleanup-task filing and the cron_runs bookkeeping share
// one stubbed client.
mock.module('@buildd/core/db/schema', () => ({
  cronRuns: { __table: 'cron_runs', id: 'id', job: 'job', startedAt: 'startedAt', alertedAt: 'alertedAt' },
  tasks: { __table: 'tasks', id: 'id' },
  workspaces: {
    __table: 'workspaces',
    id: 'id',
    name: 'name',
    repo: 'repo',
    webhookConfig: 'webhookConfig',
    githubInstallationId: 'githubInstallationId',
    githubRepoId: 'githubRepoId',
  },
}));

mock.module('drizzle-orm', () => ({
  desc: (a: any) => ({ a, op: 'desc' }),
  gt: (a: any, b: any) => ({ a, b, op: 'gt' }),
  lt: (a: any, b: any) => ({ a, b, op: 'lt' }),
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  and: (...c: any[]) => ({ c, type: 'and' }),
}));

const insertedRuns: any[] = [];
/**
 * Task inserts, in order, as the real filer built them.
 *
 * The cleanup filer is NOT mocked out in this file. Asserting on the values it
 * actually inserts is what ties "the route files a cleanup task" to "that task
 * carries the prohibitions" — a stub of the filer would let the two drift and
 * both tests would still pass.
 */
const insertedTasks: any[] = [];
/** Side-effect order, for the ordering proof (claim before filing before push). */
const sideEffects: string[] = [];
let taskInsertThrows: Error | null = null;

mock.module('@buildd/core/db', () => ({
  db: {
    insert: (table: any) => ({
      values: (v: any) => {
        const isTask = table?.__table === 'tasks';
        if (isTask) {
          sideEffects.push('task-insert');
          if (taskInsertThrows) throw taskInsertThrows;
          insertedTasks.push(v);
          return { returning: async () => [{ id: 'cleanup-task-1' }] };
        }
        insertedRuns.push(v);
        return { returning: async () => [{ id: 'run-1' }] };
      },
    }),
    select: () => ({
      from: () => ({
        where: () => ({ orderBy: async () => [], limit: async () => [] }),
      }),
    }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
    delete: () => ({ where: async () => undefined }),
  },
}));

// Realtime fan-out for a filed task. Best-effort in the filer, stubbed here so
// the test does not reach Pusher or the GitHub App.
const dispatchCalls: any[] = [];
mock.module('@/lib/task-dispatch', () => ({
  dispatchNewTask: async (task: any, workspace: any) => {
    dispatchCalls.push({ task, workspace });
  },
}));

// ── The notifier ────────────────────────────────────────────────────────────

const notifyCalls: any[] = [];
mock.module('@/lib/pushover', () => ({
  notify: (opts: any) => {
    sideEffects.push('notify');
    notifyCalls.push(opts);
  },
}));

// ── The readout itself ──────────────────────────────────────────────────────

const persisted: any[] = [];
const claimCalls: { key: string; details: any }[] = [];
const artifactCalls: any[] = [];

let readoutToReturn: any;
let claimResult = true;
let readoutThrows: Error | null = null;
/** How many times the EXPENSIVE half ran. The retirement proof reads this. */
let readoutRuns = 0;
let deliveredVerdict: any = null;
let artifactToReturn: any = { id: 'artifact-1', workspaceId: 'ws-1', key: 'k', type: 'analysis' };
let artifactThrows: Error | null = null;

mock.module('@buildd/core/memory-digest-readout-source', () => ({
  runMemoryDigestReadout: async () => {
    readoutRuns += 1;
    if (readoutThrows) throw readoutThrows;
    return readoutToReturn;
  },
  persistReadout: async (r: any) => {
    persisted.push(r);
  },
  claimVerdictNotification: async (key: string, details: any = {}) => {
    sideEffects.push('claim');
    claimCalls.push({ key, details });
    return claimResult;
  },
  findDeliveredVerdict: async () => deliveredVerdict,
  upsertReadoutArtifact: async (r: any) => {
    artifactCalls.push(r);
    if (artifactThrows) throw artifactThrows;
    return artifactToReturn;
  },
  readoutArtifactKey: (policyVersion: string) => `memory-digest-readout:${policyVersion}`,
  READOUT_ARTIFACT_TYPE: 'analysis',
}));

import {
  computeReadout,
  requiredNPerArm,
  DESIGN_MDE,
  READOUT_POLICY_VERSION,
  terminalNotificationKeys,
} from '@buildd/core/memory-digest-readout';
import { experimentCleanupSignature } from '@buildd/core/experiment-cleanup';
// The real health rules, not a restatement of them: "a retired route does not
// read as broken" is a claim about `evaluateCronHealth`, so it is asserted
// against `evaluateCronHealth`.
import { evaluateCronHealth, MIN_RUNS_FOR_ALARM } from '@/lib/cron-health';
import { GET } from './route';

const SECRET = 'test-cron-secret';

function req(token: string | null = SECRET): NextRequest {
  return new NextRequest('https://buildd.dev/api/cron/memory-digest-readout', {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

/**
 * Fixtures go through the REAL `computeReadout`.
 *
 * A hand-rolled readout literal drifts from the shape the route actually
 * receives — the first version of this file omitted the guardrail's confidence
 * interval, and every assertion about the response body then passed against a
 * 500. Building from synthetic rows exercises the route against exactly what
 * production hands it, and each verdict is REACHED the way production reaches
 * it rather than asserted into place.
 */
const BOUNDARY = new Date('2026-01-15T09:00:00.000Z');
const HOUR = 60 * 60 * 1000;

function tid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

function rows(perArm: number) {
  const composition: any[] = [];
  const sessions: any[] = [];
  let n = 0;
  for (const era of [
    { base: new Date(BOUNDARY.getTime() - 10 * HOUR), marker: false },
    { base: BOUNDARY, marker: true },
  ]) {
    for (const arm of ['full', 'task_scoped'] as const) {
      for (let i = 0; i < perArm; i++) {
        const taskId = tid(++n);
        const jitter = (i % 5) - 2;
        composition.push({
          taskId,
          workerId: `w-${n}`,
          buildIndex: 0,
          ts: new Date(era.base.getTime() + i * 1000),
          policyVersion: READOUT_POLICY_VERSION,
          arm,
          taskMatchDerivedBy: era.marker && i % 2 === 0 ? 'inferred_paths' : 'no_match',
          backend: 'claude',
          promptBytes: 10_000 + jitter * 100,
          memoryBlockBytes: 2_000,
          digestBytes: 2_000,
          digestBytesAvailable: 2_000,
          memoryShare: 0.2 + jitter * 0.001,
        });
        sessions.push({
          taskId,
          workerId: `w-${n}`,
          status: 'completed',
          turns: 10 + jitter,
          durationMs: 60_000 + jitter * 500,
          readCalls: 5 + jitter,
          shellCalls: 5 + jitter,
          calledRecall: false,
        });
      }
    }
  }
  return { composition, sessions };
}

function build(perArm: number, now: Date) {
  return computeReadout({
    ...rows(perArm),
    policyVersion: READOUT_POLICY_VERSION,
    now,
  });
}

/** Still accruing: a handful per arm, rows still arriving. */
function accruingReadout() {
  return build(3, new Date(BOUNDARY.getTime() + 2 * HOUR));
}

/** Terminal by power: the post-boundary cohort crosses the threshold. */
function poweredReadout() {
  return build(requiredNPerArm(DESIGN_MDE), new Date(BOUNDARY.getTime() + 2 * HOUR));
}

/** Terminal by stall: short of power, and nothing new for days. */
function stalledReadout() {
  return build(5, new Date(BOUNDARY.getTime() + 5 * 24 * HOUR));
}

/** Indeterminate: no rows at all for the policy version. */
function emptyReadout() {
  return computeReadout({
    composition: [],
    sessions: [],
    policyVersion: READOUT_POLICY_VERSION,
    now: new Date(),
  });
}

beforeEach(() => {
  process.env.CRON_SECRET = SECRET;
  notifyCalls.length = 0;
  persisted.length = 0;
  claimCalls.length = 0;
  artifactCalls.length = 0;
  insertedRuns.length = 0;
  insertedTasks.length = 0;
  dispatchCalls.length = 0;
  sideEffects.length = 0;
  taskInsertThrows = null;
  claimResult = true;
  readoutThrows = null;
  readoutRuns = 0;
  deliveredVerdict = null;
  artifactThrows = null;
  artifactToReturn = { id: 'artifact-1', workspaceId: 'ws-1', key: 'k', type: 'analysis' };
  readoutToReturn = accruingReadout();
});

/** The cron_runs row this route wrote. */
function lastRun(): any {
  return insertedRuns.filter(r => r.job === 'memory-digest-readout').at(-1);
}

describe('auth', () => {
  it('rejects a request with no bearer token', async () => {
    const res = await GET(req(null));
    expect(res.status).toBe(401);
    expect(notifyCalls).toHaveLength(0);
  });

  it('rejects a wrong bearer token', async () => {
    const res = await GET(req('nope'));
    expect(res.status).toBe(401);
  });

  it('fails closed when CRON_SECRET is not configured', async () => {
    delete process.env.CRON_SECRET;
    const res = await GET(req());
    expect(res.status).toBe(500);
  });

  it('does not compute or persist anything for an unauthenticated request', async () => {
    await GET(req('nope'));
    expect(persisted).toHaveLength(0);
    expect(claimCalls).toHaveLength(0);
  });
});

describe('a non-terminal run is genuinely quiet', () => {
  it('sends no notification while the cohort is still accruing', async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(notifyCalls).toHaveLength(0);
    // Not even a claim attempt — nothing to claim.
    expect(claimCalls).toHaveLength(0);
  });

  it('still persists the readout, so a quiet run is not an invisible run', async () => {
    await GET(req());
    expect(persisted).toHaveLength(1);
    expect(persisted[0].verdict.status).toBe('accruing');
  });

  it('reports a verdict to withCronRun rather than a bare heartbeat', async () => {
    await GET(req());
    // evaluateCronHealth drops any run reporting neither changed nor errors.
    const run = insertedRuns.find(r => r.job === 'memory-digest-readout');
    expect(run).toBeDefined();
    expect(run.changed).not.toBeNull();
    expect(run.errors).not.toBeNull();
    expect(run.changed).toBe(0);
    expect(run.errors).toBe(0);
  });

  it('returns the verdict in the body so a human can curl it', async () => {
    const body = await (await GET(req())).json();
    expect(body.verdict.status).toBe('accruing');
    expect(body.notified).toBe(false);
    expect(typeof body.text).toBe('string');
  });
});

describe('a terminal run notifies', () => {
  for (const status of ['powered', 'stalled'] as const) {
    it(`pushes when the verdict is ${status}`, async () => {
      readoutToReturn = status === 'powered' ? poweredReadout() : stalledReadout();
      await GET(req());
      expect(notifyCalls).toHaveLength(1);
      const call = notifyCalls[0];
      expect(call.app).toBe('alerts');
      // -1/-2 are silent; a terminal verdict has to actually arrive.
      expect(call.priority).toBe(0);
      expect(call.title).toContain('memory digest');
      expect(call.message).toContain(status);
      expect(call.message).toContain('325');
    });
  }

  it('claims the verdict before sending, keyed on the verdict itself', async () => {
    readoutToReturn = poweredReadout();
    await GET(req());
    expect(claimCalls.map(c => c.key)).toEqual([`${READOUT_POLICY_VERSION}:powered`]);
    // The key the claim is taken on must be one the retirement check looks for,
    // or the job pushes once and then recomputes for ever anyway.
    expect(terminalNotificationKeys(READOUT_POLICY_VERSION)).toContain(claimCalls[0].key);
  });

  it('sends nothing when the claim was already taken — one verdict, one push', async () => {
    readoutToReturn = poweredReadout();
    claimResult = false;
    await GET(req());
    expect(claimCalls).toHaveLength(1);
    expect(notifyCalls).toHaveLength(0);
    // Suppressed because it was already delivered, not because nothing happened.
    const body = await (await GET(req())).json();
    expect(body.notified).toBe(false);
    expect(body.alreadyNotified).toBe(true);
  });

  it('counts the push as the run\'s `changed` work', async () => {
    readoutToReturn = stalledReadout();
    await GET(req());
    const run = insertedRuns.find(r => r.job === 'memory-digest-readout');
    expect(run.changed).toBe(1);
  });

  it('carries the readout text in the notification, not a bare status word', async () => {
    readoutToReturn = poweredReadout();
    await GET(req());
    expect(notifyCalls[0].message.length).toBeGreaterThan(40);
  });
});

describe('indeterminate is never a quiet pass', () => {
  it('reports errors=1 so three such runs alarm through cron health', async () => {
    readoutToReturn = emptyReadout();
    await GET(req());
    const run = insertedRuns.find(r2 => r2.job === 'memory-digest-readout');
    // An empty cohort is how a broken collection path looks. Reporting
    // errors=0/changed=0 here would be a green signal over an empty set.
    expect(run.errors).toBe(1);
    expect(run.changed).toBe(0);
    expect(notifyCalls).toHaveLength(0);
  });
});

describe('failure handling', () => {
  it('surfaces a thrown readout as a 500 without notifying', async () => {
    readoutThrows = new Error('boom');
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect(notifyCalls).toHaveLength(0);
  });
});

describe('retirement: a delivered verdict stops the work, not just the push', () => {
  const DELIVERED = {
    notificationKey: `${READOUT_POLICY_VERSION}:powered`,
    status: 'powered',
    claimedAt: '2026-02-01T12:00:00.000Z',
    artifactId: 'artifact-1',
    artifactUrl: 'https://buildd.dev/app/artifacts/artifact-1',
  };

  it('files no cleanup task on a retired run — the task was filed with the claim', async () => {
    deliveredVerdict = DELIVERED;
    await GET(req());
    expect(insertedTasks).toHaveLength(0);
  });

  it('does NOT compute the readout once a terminal verdict has been delivered', async () => {
    // The point of retiring. `notified === false` would also be true of a route
    // that still ran the full cohort scan every morning for ever, so the
    // assertion is on the expensive call itself, not on the absence of a push.
    deliveredVerdict = DELIVERED;
    await GET(req());
    expect(readoutRuns).toBe(0);
    expect(persisted).toHaveLength(0);
    expect(artifactCalls).toHaveLength(0);
    expect(claimCalls).toHaveLength(0);
    expect(notifyCalls).toHaveLength(0);
  });

  it('still computes while no terminal verdict has been delivered', async () => {
    // The other half of the proof: the guard is reading the claim, not just
    // refusing to work.
    await GET(req());
    expect(readoutRuns).toBe(1);
  });

  it('says it is retired, and hands back the verdict it delivered', async () => {
    deliveredVerdict = DELIVERED;
    const body = await (await GET(req())).json();
    expect(body.retired).toBe(true);
    expect(body.delivered.status).toBe('powered');
    expect(body.delivered.artifactUrl).toBe(DELIVERED.artifactUrl);
    // No readout in the body: none was computed, and a stale one would be a lie.
    expect(body.readout).toBeUndefined();
  });

  it('reports a judged verdict rather than a bare heartbeat', async () => {
    deliveredVerdict = DELIVERED;
    await GET(req());
    const run = lastRun();
    // A run reporting neither is dropped by evaluateCronHealth entirely.
    expect(run.changed).toBe(0);
    expect(run.errors).toBe(0);
    expect(run.result.retired).toBe(true);
  });

  it('does not read as a broken cron for ever after', async () => {
    deliveredVerdict = DELIVERED;
    const runs = [];
    for (let i = 0; i < MIN_RUNS_FOR_ALARM + 2; i++) {
      insertedRuns.length = 0;
      await GET(req());
      const row = lastRun();
      runs.push({
        ok: true,
        errors: row.errors,
        changed: row.changed,
        alertedAt: null,
        startedAt: new Date(Date.now() - i * 60_000),
      });
    }
    // Judged (errors is not null) and not failing, so quiet — as opposed to
    // "reports nothing", which is quiet only because it is unreadable.
    expect(runs.every(r => r.errors !== null || r.changed !== null)).toBe(true);
    expect(evaluateCronHealth(runs, new Date()).alarm).toBe(false);
  });

  it('a retired path that throws is still alarmable', async () => {
    // The one failure mode left: the lookup itself breaking. Three runs of it
    // must wake someone, or retiring the job would also retire its monitoring.
    const threw = Array.from({ length: MIN_RUNS_FOR_ALARM }, (_, i) => ({
      ok: false,
      errors: null,
      changed: null,
      alertedAt: null,
      startedAt: new Date(Date.now() - i * 60_000),
    }));
    expect(evaluateCronHealth(threw, new Date()).alarm).toBe(true);
  });
});

describe('the verdict is published as a keyed artifact', () => {
  it('upserts the artifact on an ordinary accruing run', async () => {
    await GET(req());
    expect(artifactCalls).toHaveLength(1);
    const body = await (await GET(req())).json();
    expect(body.artifact.id).toBe('artifact-1');
    expect(body.artifact.type).toBe('analysis');
  });

  it('reports the artifact in the run result without counting it as `changed`', async () => {
    // `changed` means "delivered the verdict". An artifact write happens nearly
    // every run, so counting it would make totalChanged>0 permanently true and
    // permanently suppress the indeterminate alarm.
    await GET(req());
    const run = lastRun();
    expect(run.changed).toBe(0);
    expect(run.result.artifactId).toBe('artifact-1');
    expect(run.result.artifactUrl).toBe('https://buildd.dev/app/artifacts/artifact-1');
  });

  it('does NOT publish an indeterminate readout over a real verdict', async () => {
    // "No rows — the collection path may be broken" must not overwrite the
    // analysis, which is exactly when someone would go looking for it.
    readoutToReturn = emptyReadout();
    await GET(req());
    expect(artifactCalls).toHaveLength(0);
    expect(lastRun().errors).toBe(1);
  });

  it('an artifact failure does not suppress the verdict push', async () => {
    readoutToReturn = poweredReadout();
    artifactThrows = new Error('artifact boom');
    await GET(req());
    expect(notifyCalls).toHaveLength(1);
    // No link rather than a dead one.
    expect(notifyCalls[0].url).toBeUndefined();
    expect(lastRun().result.artifactError).toBe('artifact boom');
  });

  it('records the artifact on the claim row, so the retired run can link it', async () => {
    readoutToReturn = poweredReadout();
    await GET(req());
    expect(claimCalls[0].details).toEqual({
      status: 'powered',
      artifactId: 'artifact-1',
      artifactUrl: 'https://buildd.dev/app/artifacts/artifact-1',
    });
  });
});

describe('the notification carries a link to the artifact', () => {
  it('sends the exact payload, url included', async () => {
    readoutToReturn = poweredReadout();
    await GET(req());
    expect(notifyCalls).toHaveLength(1);
    const call = notifyCalls[0];
    expect(call).toEqual({
      app: 'alerts',
      priority: 0,
      title: 'memory digest experiment — powered',
      message: call.message,
      url: 'https://buildd.dev/app/artifacts/artifact-1',
      urlTitle: 'Open the readout',
    });
    // Pushover's own field names — the helper maps urlTitle -> url_title.
    expect(call.url).toBe('https://buildd.dev/app/artifacts/artifact-1');
    expect(call.url).toStartWith('https://');
    expect(call.url).toContain('/app/artifacts/');
  });

  it('links the artifact that this run actually wrote', async () => {
    readoutToReturn = stalledReadout();
    artifactToReturn = { id: 'artifact-2', workspaceId: 'ws-1', key: 'k', type: 'analysis' };
    await GET(req());
    expect(notifyCalls[0].url).toBe('https://buildd.dev/app/artifacts/artifact-2');
  });
});

/**
 * A terminal verdict schedules its own cleanup WORK rather than emitting a
 * reminder. The properties that matter:
 *
 *  1. Exactly once, ever — gated on the SAME claim as the notification, so
 *     there is one dedupe mechanism and not two that can disagree.
 *  2. Never on a non-terminal or `indeterminate` readout.
 *  3. The description carries the prohibitions. That is the actual safety
 *     property: "clean up the finished experiment" is an instruction an agent
 *     can satisfy by deleting the reusable readout module, the CLI, the pin
 *     guard or the published verdict.
 *  4. A failed filing takes nothing else down with it.
 */
describe('a terminal verdict files a cleanup task', () => {
  it('files exactly one task on the run that takes the claim', async () => {
    readoutToReturn = poweredReadout();
    await GET(req());
    expect(insertedTasks).toHaveLength(1);
    expect(insertedTasks[0].workspaceId).toBe('ws-1');
  });

  it('does NOT file one when the claim was already taken', async () => {
    // The once-ever property. Asserted on the insert, not on a log line.
    readoutToReturn = poweredReadout();
    claimResult = false;
    await GET(req());
    expect(claimCalls).toHaveLength(1);
    expect(insertedTasks).toHaveLength(0);
  });

  it('files at most one task across repeated runs', async () => {
    readoutToReturn = poweredReadout();
    await GET(req());
    // Second morning: the claim is gone, exactly as `claimVerdictNotification`
    // behaves in production.
    claimResult = false;
    await GET(req());
    await GET(req());
    expect(insertedTasks).toHaveLength(1);
  });

  it('does NOT file one while the cohort is still accruing', async () => {
    await GET(req());
    expect(insertedTasks).toHaveLength(0);
  });

  it('does NOT file one on an indeterminate readout', async () => {
    // `indeterminate` is how a broken collection path looks. Filing cleanup for
    // an experiment whose data cannot be read is the worst possible moment.
    readoutToReturn = emptyReadout();
    await GET(req());
    expect(insertedTasks).toHaveLength(0);
    expect(claimCalls).toHaveLength(0);
  });

  it('claims BEFORE filing, and files BEFORE pushing', async () => {
    // Ordering is the dedupe. Filing before the claim would let two concurrent
    // runs both file; pushing before filing would lose the task id from the
    // only notification this experiment ever sends.
    readoutToReturn = poweredReadout();
    await GET(req());
    expect(sideEffects).toEqual(['claim', 'task-insert', 'notify']);
  });

  it('requires a PR, to dev', async () => {
    readoutToReturn = poweredReadout();
    await GET(req());
    const task = insertedTasks[0];
    expect(task.outputRequirement).toBe('pr_required');
    expect(task.context.baseBranch).toBe('dev');
  });

  it('anchors the task so buildd\'s own dedupe is a second line of defence', async () => {
    readoutToReturn = poweredReadout();
    await GET(req());
    const task = insertedTasks[0];
    // `error` kind with a namespaced signature is an IDENTIFYING key type, so a
    // live match stops a re-filing through the API or MCP.
    expect(task.subjectKind).toBe('error');
    expect(task.subjectErrorSignature).toBe(experimentCleanupSignature(READOUT_POLICY_VERSION));
    expect(task.subjectDedupeScope).toBe('active');
    expect(task.subjectAnchor.source).toBe('system');
    expect(task.subjectAnchor.confidence).toBe('exact');
  });

  it('scopes the task to the manifest, not to the tree', async () => {
    readoutToReturn = poweredReadout();
    await GET(req());
    expect(insertedTasks[0].pathManifest).toContain('cron-manifest.json');
    expect(insertedTasks[0].pathManifest).not.toContain('**');
  });

  it('dispatches the filed task', async () => {
    readoutToReturn = poweredReadout();
    await GET(req());
    expect(dispatchCalls).toHaveLength(1);
    expect(dispatchCalls[0].task.id).toBe('cleanup-task-1');
  });

  it('reports the task id in the run result', async () => {
    readoutToReturn = poweredReadout();
    await GET(req());
    expect(lastRun().result.cleanupTaskId).toBe('cleanup-task-1');
    expect(lastRun().result.cleanupTaskError).toBeNull();
  });
});

describe('the cleanup task description carries the prohibitions', () => {
  /**
   * The named assets, pinned. A future edit that drops the do-not-delete list
   * — or replaces it with "use your judgement" — fails here. The substance is
   * pinned, not the prose.
   */
  const PROTECTED = [
    'packages/core/memory-digest-readout.ts',
    'packages/core/memory-digest-readout-source.ts',
    'packages/core/scripts/memory-digest-readout.ts',
    'readout:memory-digest',
    'packages/core/__tests__/memory-digest-readout-policy-pin.test.ts',
    'apps/runner/__tests__/unit/memory-digest-policy-version-pin.test.ts',
    `memory-digest-readout:${READOUT_POLICY_VERSION}`,
    'system_cache',
    'apps/runner/src/memory-digest-policy.ts',
  ];

  async function description(): Promise<string> {
    readoutToReturn = poweredReadout();
    await GET(req());
    return insertedTasks[0].description as string;
  }

  it('tells the agent to remove the manifest entry', async () => {
    const d = await description();
    expect(d).toContain('cron-manifest.json');
    expect(d).toMatch(/daily tick/i);
  });

  for (const asset of PROTECTED) {
    it(`forbids touching ${asset}`, async () => {
      const d = await description();
      expect(d.slice(d.indexOf('DO NOT'))).toContain(asset);
    });
  }

  it('makes deleting the route optional rather than required', async () => {
    const d = await description();
    expect(d).toContain('apps/web/src/app/api/cron/memory-digest-readout');
    expect(d.slice(d.indexOf('Optional'))).toMatch(/NOT required by this task/i);
  });

  it('states the two-stage split and that only stage one is automated', async () => {
    const d = await description();
    expect(d).toMatch(/stage one/i);
    expect(d).toMatch(/stage two/i);
    expect(d).toMatch(/only stage one/i);
  });

  it('states that the experiment\'s decision is not this task', async () => {
    const d = await description();
    expect(d).toMatch(/keep(ing)? or revert/i);
    expect(d).toMatch(/do not assume/i);
  });

  it('links the artifact this run wrote, so the agent can read the verdict', async () => {
    const d = await description();
    expect(d).toContain('https://buildd.dev/app/artifacts/artifact-1');
  });
});

describe('the notification says a cleanup task was filed', () => {
  it('adds one line naming the task, and keeps the link on the artifact', async () => {
    readoutToReturn = poweredReadout();
    await GET(req());
    const call = notifyCalls[0];
    expect(call.message).toContain('cleanup-task-1');
    // The push is about the verdict. Repointing the link at the task would
    // bury the analysis behind a second hop.
    expect(call.url).toBe('https://buildd.dev/app/artifacts/artifact-1');
    expect(call.urlTitle).toBe('Open the readout');
  });

  it('still carries the readout summary, not just the cleanup line', async () => {
    readoutToReturn = poweredReadout();
    await GET(req());
    expect(notifyCalls[0].message).toContain('powered');
    expect(notifyCalls[0].message).toContain('325');
  });

  it('says plainly when NO task could be filed', async () => {
    readoutToReturn = poweredReadout();
    taskInsertThrows = new Error('task boom');
    await GET(req());
    expect(notifyCalls).toHaveLength(1);
    expect(notifyCalls[0].message).toMatch(/no cleanup task/i);
    expect(notifyCalls[0].message).toMatch(/by hand/i);
  });
});

describe('a failed filing takes nothing else down', () => {
  it('still pushes the verdict', async () => {
    readoutToReturn = poweredReadout();
    taskInsertThrows = new Error('task boom');
    await GET(req());
    expect(notifyCalls).toHaveLength(1);
    expect(notifyCalls[0].url).toBe('https://buildd.dev/app/artifacts/artifact-1');
  });

  it('still publishes the artifact and persists the readout', async () => {
    readoutToReturn = poweredReadout();
    taskInsertThrows = new Error('task boom');
    await GET(req());
    expect(artifactCalls).toHaveLength(1);
    expect(persisted).toHaveLength(1);
  });

  it('returns 200 and records the failure rather than throwing', async () => {
    readoutToReturn = poweredReadout();
    taskInsertThrows = new Error('task boom');
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(lastRun().result.cleanupTaskId).toBeNull();
    expect(lastRun().result.cleanupTaskError).toBe('task boom');
    // The verdict was still delivered, so the claim was not spent for nothing.
    expect(lastRun().changed).toBe(1);
  });

  it('files nothing when there is no workspace to file into', async () => {
    // `upsertReadoutArtifact` returns null when no workspace can be resolved.
    // The task has nowhere to go; the push must still happen.
    readoutToReturn = poweredReadout();
    artifactToReturn = null;
    await GET(req());
    expect(insertedTasks).toHaveLength(0);
    expect(notifyCalls).toHaveLength(1);
    expect(notifyCalls[0].message).toMatch(/no cleanup task/i);
  });
});
