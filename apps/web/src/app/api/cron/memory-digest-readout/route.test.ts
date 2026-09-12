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

mock.module('@buildd/core/db/schema', () => ({
  cronRuns: { id: 'id', job: 'job', startedAt: 'startedAt', alertedAt: 'alertedAt' },
}));

mock.module('drizzle-orm', () => ({
  desc: (a: any) => ({ a, op: 'desc' }),
  gt: (a: any, b: any) => ({ a, b, op: 'gt' }),
  lt: (a: any, b: any) => ({ a, b, op: 'lt' }),
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  and: (...c: any[]) => ({ c, type: 'and' }),
}));

const insertedRuns: any[] = [];
mock.module('@buildd/core/db', () => ({
  db: {
    insert: () => ({
      values: (v: any) => {
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

// ── The notifier ────────────────────────────────────────────────────────────

const notifyCalls: any[] = [];
mock.module('@/lib/pushover', () => ({
  notify: (opts: any) => {
    notifyCalls.push(opts);
  },
}));

// ── The readout itself ──────────────────────────────────────────────────────

const persisted: any[] = [];
const claimCalls: string[] = [];

let readoutToReturn: any;
let claimResult = true;
let readoutThrows: Error | null = null;

mock.module('@buildd/core/memory-digest-readout-source', () => ({
  runMemoryDigestReadout: async () => {
    if (readoutThrows) throw readoutThrows;
    return readoutToReturn;
  },
  persistReadout: async (r: any) => {
    persisted.push(r);
  },
  claimVerdictNotification: async (key: string) => {
    claimCalls.push(key);
    return claimResult;
  },
}));

import {
  computeReadout,
  requiredNPerArm,
  DESIGN_MDE,
  READOUT_POLICY_VERSION,
} from '@buildd/core/memory-digest-readout';
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
  insertedRuns.length = 0;
  claimResult = true;
  readoutThrows = null;
  readoutToReturn = accruingReadout();
});

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
    expect(claimCalls).toEqual([`${READOUT_POLICY_VERSION}:powered`]);
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
