/**
 * The red-PR sweep's decision table: lifecycle × owner × fix-in-flight ×
 * budget, asserting exactly one action (retry, escalate) or none per PR, and
 * when the PR is looked at again.
 */
import { describe, it, expect } from 'bun:test';
import {
  runCiRedSweep,
  dueAfterWindow,
  CI_RED_MIN_AGE_MS,
  CI_RED_PICKUP_MS,
  CI_RED_RUNNING_WAIT_MS,
  CI_RED_RETRY_MS,
  CI_RED_FLOOR_ENUMERATION_CAP,
  type CiRedSweepDeps,
  type CiRedTarget,
  type CiRedChecks,
  type CiRedPeek,
} from './ci-red-sweep';
import { CI_RED_ESCALATED_KEY } from './ci-red-queue';
import type { CiRetryOutcome, CiFailureInput } from './ci-failure-retry';

const NOW = Date.parse('2026-10-02T12:00:00Z');
const OLD_RED = NOW - CI_RED_MIN_AGE_MS - 60_000;

function target(prNumber = 7, ctx: Record<string, unknown> | null = {}): CiRedTarget {
  return {
    workspaceId: 'ws1',
    prNumber,
    installationId: 1,
    repoFullName: 'o/r',
    owner: {
      taskId: 't1', workerId: 'w1', title: 'Do it', workspaceId: 'ws1', missionId: 'm1',
      status: 'completed', context: ctx, result: null,
    },
  };
}

interface Fake {
  deps: CiRedSweepDeps;
  retries: CiFailureInput[];
  escalations: Array<{ prNumber: number; headSha: string; prior: string | null }>;
  marked: Map<string, number>;
  cleared: string[];
  reseeded: Array<{ member: string; dueAtMs: number }> | null;
}

function fake(opts: {
  floor?: Array<{ workspaceId: string; prNumber: number }>;
  due?: string[];
  resolve?: (pr: number) => ReturnType<CiRedSweepDeps['resolveTarget']>;
  peek?: Partial<CiRedPeek> | (() => Promise<CiRedPeek>);
  checks?: CiRedChecks;
  retry?: CiRetryOutcome;
  escalateResult?: boolean;
} = {}): Fake {
  const f: Fake = { deps: null as any, retries: [], escalations: [], marked: new Map(), cleared: [], reseeded: null };
  f.deps = {
    listFloor: async () => opts.floor ?? [{ workspaceId: 'ws1', prNumber: 7 }],
    listDue: async () => opts.due ?? [],
    resolveTarget: async (ref) => (opts.resolve ? opts.resolve(ref.prNumber) : { ok: true, target: target(ref.prNumber) }),
    peek: async () => {
      if (typeof opts.peek === 'function') return opts.peek();
      return { state: 'open', draft: false, headSha: 'h1', ...(opts.peek ?? {}) };
    },
    readChecks: async () => opts.checks ?? { lifecycle: 'ci_failed', redSinceMs: OLD_RED },
    retry: async (input) => {
      f.retries.push(input);
      return opts.retry ?? { kind: 'dispatched', taskId: 'r1' };
    },
    escalateNoPush: async (t, headSha, prior) => {
      f.escalations.push({ prNumber: t.prNumber, headSha, prior });
      return opts.escalateResult ?? true;
    },
    markDue: async (m, at) => { f.marked.set(m, at); },
    clearDue: async (ms) => { f.cleared.push(...ms); },
    reseedDue: async (entries) => { f.reseeded = entries; },
    sleep: async () => {},
    now: () => NOW,
  };
  return f;
}

const run = (f: Fake, source: 'floor' | 'due' = 'floor') => runCiRedSweep({ source }, f.deps);

describe('red-PR sweep — one action per PR, or none', () => {
  it('red past the window, nothing in flight, budget left → one CI retry on the live head, looked at again later', async () => {
    const f = fake();
    const r = await run(f);
    expect(f.retries).toEqual([
      { repoFullName: 'o/r', prNumber: 7, headSha: 'h1', installationId: 1, surface: 'cron:ci-red' },
    ]);
    expect(f.escalations).toEqual([]);
    expect(r.dispatched).toBe(1);
    expect(f.reseeded).toEqual([{ member: 'ws1:7', dueAtMs: NOW + CI_RED_PICKUP_MS }]);
  });

  it('red but younger than the window → no action, due when the window passes', async () => {
    const redSince = NOW - 60_000;
    const f = fake({ checks: { lifecycle: 'ci_failed', redSinceMs: redSince } });
    const r = await run(f);
    expect(f.retries).toEqual([]);
    expect(r.tooYoung).toBe(1);
    expect(f.reseeded).toEqual([{ member: 'ws1:7', dueAtMs: redSince + CI_RED_MIN_AGE_MS }]);
  });

  it('checks still running → no action, looked at again soon', async () => {
    const f = fake({ checks: { lifecycle: 'ci_running', redSinceMs: null } });
    await run(f);
    expect(f.retries).toEqual([]);
    expect(f.reseeded).toEqual([{ member: 'ws1:7', dueAtMs: NOW + CI_RED_RUNNING_WAIT_MS }]);
  });

  for (const lifecycle of ['ci_green', null] as const) {
    it(`checks ${lifecycle ?? 'absent'} → no action, off the queue`, async () => {
      const f = fake({ checks: { lifecycle, redSinceMs: null } });
      await run(f);
      expect(f.retries).toEqual([]);
      expect(f.reseeded).toEqual([]);
    });
  }

  it('fix in flight → no action, looked at again (the in-flight-skip case)', async () => {
    const f = fake({ retry: { kind: 'skipped', reason: 'fix_in_flight', inFlightTaskId: 'x' } });
    const r = await run(f);
    expect(f.retries.length).toBe(1);
    expect(f.escalations).toEqual([]);
    expect(r.inFlight).toBe(1);
    expect(f.reseeded).toEqual([{ member: 'ws1:7', dueAtMs: NOW + CI_RED_PICKUP_MS }]);
  });

  it('the in-flight attempt finished without pushing → the head is escalated once, not retried again', async () => {
    const f = fake({ retry: { kind: 'skipped', reason: 'head_already_retried', priorAttemptTaskId: 'c1' } });
    const r = await run(f);
    expect(f.escalations).toEqual([{ prNumber: 7, headSha: 'h1', prior: 'c1' }]);
    expect(r.escalated).toBe(1);
    expect(f.reseeded).toEqual([]);
  });

  it('a head already escalated by another door → not counted twice', async () => {
    const f = fake({ retry: { kind: 'skipped', reason: 'head_already_retried' }, escalateResult: false });
    const r = await run(f);
    expect(r.escalated).toBe(0);
    expect(r.skipped.already_escalated).toBe(1);
  });

  for (const reason of ['retries_exhausted', 'retries_disabled'] as const) {
    it(`budget gone (${reason}) → the retry function's own escalation, nothing extra`, async () => {
      const f = fake({ retry: { kind: 'skipped', reason } });
      const r = await run(f);
      expect(f.escalations).toEqual([]);
      expect(r.escalated).toBe(1);
      expect(f.reseeded).toEqual([]);
    });
  }

  it('owner already escalated on this head → no GitHub check read, no retry', async () => {
    let checksRead = 0;
    const f = fake({ resolve: () => Promise.resolve({ ok: true, target: target(7, { [CI_RED_ESCALATED_KEY]: 'h1' }) }) });
    const inner = f.deps.readChecks;
    f.deps.readChecks = async (...a) => { checksRead++; return inner(...a); };
    const r = await run(f);
    expect(f.retries).toEqual([]);
    expect(checksRead).toBe(0);
    expect(r.skipped.already_escalated).toBe(1);
  });

  it('owner escalated on an older head → the new red head is acted on', async () => {
    const f = fake({ resolve: () => Promise.resolve({ ok: true, target: target(7, { [CI_RED_ESCALATED_KEY]: 'old' }) }) });
    await run(f);
    expect(f.retries.length).toBe(1);
  });

  for (const skip of ['no_open_worker', 'owner_stopped', 'no_repo', 'no_installation'] as const) {
    it(`unresolvable target (${skip}) → no action, off the queue`, async () => {
      const f = fake({ due: ['ws1:7'], resolve: () => Promise.resolve({ ok: false, skip }) });
      const r = await run(f, 'due');
      expect(f.retries).toEqual([]);
      expect(r.skipped[skip]).toBe(1);
      expect(f.cleared).toEqual(['ws1:7']);
    });
  }

  for (const [peek, why] of [[{ state: 'merged' }, 'merged'], [{ state: 'closed' }, 'closed'], [{ draft: true }, 'draft']] as const) {
    it(`PR ${why} → no action`, async () => {
      const f = fake({ peek });
      const r = await run(f);
      expect(f.retries).toEqual([]);
      expect(r.skipped[why]).toBe(1);
    });
  }

  it('GitHub unreadable → an error, retried soon, never a retry on a guessed head', async () => {
    const f = fake({ peek: () => Promise.reject(new Error('502')) });
    const r = await run(f);
    expect(f.retries).toEqual([]);
    expect(r.errors).toBe(1);
    expect(f.reseeded).toEqual([{ member: 'ws1:7', dueAtMs: NOW + CI_RED_RETRY_MS }]);
  });

  it('a lost race with the webhook on this head → looked at again, not escalated', async () => {
    const f = fake({ retry: { kind: 'skipped', reason: 'duplicate' } });
    await run(f);
    expect(f.escalations).toEqual([]);
    expect(f.reseeded).toEqual([{ member: 'ws1:7', dueAtMs: NOW + CI_RED_PICKUP_MS }]);
  });

  it('a second run on the same head after an escalation does nothing (idempotent per PR + head)', async () => {
    // First run escalates; the escalation stamps the owner. The second run sees the stamp.
    let ctx: Record<string, unknown> = {};
    const f = fake({
      resolve: () => Promise.resolve({ ok: true, target: target(7, ctx) }),
      retry: { kind: 'skipped', reason: 'head_already_retried', priorAttemptTaskId: 'c1' },
    });
    f.deps.escalateNoPush = async (_t, headSha) => { f.escalations.push({ prNumber: 7, headSha, prior: null }); ctx = { [CI_RED_ESCALATED_KEY]: headSha }; return true; };
    await run(f);
    await run(f);
    expect(f.escalations.length).toBe(1);
    expect(f.retries.length).toBe(1);
  });
});

describe('red-PR sweep — sources and the queue', () => {
  it('due source reads the queue, drops malformed members, and upserts instead of replacing', async () => {
    const f = fake({ due: ['ws1:7', 'garbage', 'ws1:7'] });
    const r = await run(f, 'due');
    expect(r.enumerated).toBe(1);
    expect(f.cleared).toContain('garbage');
    expect(f.reseeded).toBeNull();
    expect(f.marked.get('ws1:7')).toBe(NOW + CI_RED_PICKUP_MS);
  });

  it('due source clears members that need nothing more', async () => {
    const f = fake({ due: ['ws1:7'], checks: { lifecycle: 'ci_green', redSinceMs: null } });
    await run(f, 'due');
    expect(f.cleared).toEqual(['ws1:7']);
  });

  it('a truncated floor upserts rather than replacing the queue', async () => {
    const floor = Array.from({ length: CI_RED_FLOOR_ENUMERATION_CAP + 1 }, (_, i) => ({ workspaceId: 'ws1', prNumber: i + 1 }));
    const f = fake({ floor, checks: { lifecycle: 'ci_green', redSinceMs: null } });
    const r = await runCiRedSweep({ source: 'floor', batchCap: 2 }, f.deps);
    expect(r.truncated).toBe(true);
    expect(f.reseeded).toBeNull();
    expect(r.deferred).toBe(CI_RED_FLOOR_ENUMERATION_CAP - 2);
  });

  it('batch cap leaves the rest due now on the floor', async () => {
    const f = fake({ floor: [{ workspaceId: 'ws1', prNumber: 1 }, { workspaceId: 'ws1', prNumber: 2 }] });
    const r = await runCiRedSweep({ source: 'floor', batchCap: 1 }, f.deps);
    expect(r.deferred).toBe(1);
    expect(f.reseeded).toContainEqual({ member: 'ws1:2', dueAtMs: NOW });
  });
});

describe('dueAfterWindow', () => {
  it('is null once the window has passed, or when GitHub gave no time', () => {
    expect(dueAfterWindow(OLD_RED, NOW)).toBeNull();
    expect(dueAfterWindow(null, NOW)).toBeNull();
    expect(dueAfterWindow(NOW, NOW)).toBe(NOW + CI_RED_MIN_AGE_MS);
  });
});
