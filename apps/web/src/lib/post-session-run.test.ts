import { describe, expect, it } from 'bun:test';
import {
  MAX_POST_SESSION_ATTEMPTS,
  POST_SESSION_POLICY_VERSION,
  POST_SESSION_STALE_COLLECTING_MS,
  type StageAFacts,
  type StageASource,
} from '@buildd/core/post-session-quality';
import {
  processPostSessionRun,
  sweepPostSessionRuns,
  type PostSessionRunStore,
  type PostSessionWorkerRef,
} from './post-session-run';

const NOW = new Date('2026-10-03T12:00:00Z');

interface FakeRow {
  id: string;
  workerId: string;
  policyVersion: string;
  mode: string;
  state: string;
  attempts: number;
  facts: StageAFacts | null;
  transcriptAvailability: string | null;
  errorStage: string | null;
  lastError: string | null;
  updatedAt: Date;
}

function worker(over: Partial<PostSessionWorkerRef> = {}): PostSessionWorkerRef {
  return {
    id: 'worker-1',
    status: 'completed',
    startedAt: new Date('2026-10-03T11:00:00Z'),
    exitCause: null,
    taskId: 'task-1',
    workspaceId: 'ws-1',
    missionId: null,
    gitConfig: null,
    ...over,
  };
}

function sourceFor(w: PostSessionWorkerRef): StageASource {
  return {
    worker: {
      id: w.id, status: w.status, exitCause: w.exitCause, error: null, turns: 3, inputTokens: 10, outputTokens: 5,
      costUsd: '0.1', startedAt: w.startedAt, completedAt: NOW, prNumber: null, prLifecycleStatus: null, mergedAt: null,
      supersededByPrNumber: null, abandonedAt: null, rejectedCompletionPayload: null, dirtyWorktree: false,
      mcpCallCount: 0, resultMeta: null,
    },
    task: {
      id: w.taskId!, status: 'completed', kind: 'engineering', category: null, roleSlug: 'builder', missionId: null,
      outputRequirement: null, creationSource: null, parentTaskId: null, result: null,
    },
    workspace: { id: w.workspaceId, mergePolicyTier: null, dataClass: 'standard' },
    mode: 'shadow',
    attempts: { attemptNumber: 1, totalAttempts: 1 },
    reviews: [],
    ciFixAttempts: 0,
    errorTraces: [],
    transcript: { availability: 'absent', sizeBytes: null },
    corpora: null,
    unavailable: [],
  };
}

/**
 * In-memory store with the SAME uniqueness and compare-and-set rules as the
 * Postgres implementation: (workerId, policyVersion) unique, retry only from
 * `failed` under the attempt cap or from a stale `collecting`, writes fenced on
 * (state='collecting', attempts).
 */
function fakeStore(workers: PostSessionWorkerRef[], opts: { failSource?: (n: number) => boolean } = {}) {
  const rows = new Map<string, FakeRow>();
  const byId = new Map(workers.map(w => [w.id, w]));
  let sourceCalls = 0;
  let seq = 0;
  // Anything that would touch the worker/task rows. The run store has no such
  // method by design; this records an attempt if one is ever added.
  const foreignWrites: string[] = [];

  const store: PostSessionRunStore & { rows: Map<string, FakeRow>; sourceCalls: () => number; foreignWrites: string[] } = {
    rows,
    foreignWrites,
    sourceCalls: () => sourceCalls,
    async loadWorker(id) {
      return byId.get(id) ?? null;
    },
    async claimRun({ workerId, policyVersion, mode, now }) {
      const key = `${workerId}|${policyVersion}`;
      const existing = rows.get(key);
      if (!existing) {
        const row: FakeRow = {
          id: `run-${++seq}`, workerId, policyVersion, mode, state: 'collecting', attempts: 1,
          facts: null, transcriptAvailability: null, errorStage: null, lastError: null, updatedAt: now,
        };
        rows.set(key, row);
        return { claimed: true, runId: row.id, attempt: 1 };
      }
      const retryable =
        (existing.state === 'failed' && existing.attempts < MAX_POST_SESSION_ATTEMPTS) ||
        (existing.state === 'collecting' && existing.updatedAt.getTime() < now.getTime() - POST_SESSION_STALE_COLLECTING_MS);
      if (!retryable) return { claimed: false, runId: existing.id, state: existing.state as never };
      existing.state = 'collecting';
      existing.attempts += 1;
      existing.updatedAt = now;
      return { claimed: true, runId: existing.id, attempt: existing.attempts };
    },
    async loadSource(w) {
      sourceCalls++;
      // Yield so concurrent processors genuinely interleave.
      await new Promise(r => setTimeout(r, 1));
      if (opts.failSource?.(sourceCalls)) throw new Error('reviews query timed out');
      return sourceFor(byId.get(w.id)!);
    },
    async completeRun(runId, attempt, { facts, transcriptAvailability, now }) {
      const row = [...rows.values()].find(r => r.id === runId);
      if (!row || row.state !== 'collecting' || row.attempts !== attempt) return false;
      Object.assign(row, { state: 'collected', facts, transcriptAvailability, updatedAt: now });
      return true;
    },
    async failRun(runId, attempt, { stage, error, now }) {
      const row = [...rows.values()].find(r => r.id === runId);
      if (!row || row.state !== 'collecting' || row.attempts !== attempt) return;
      Object.assign(row, { state: 'failed', errorStage: stage, lastError: error, updatedAt: now });
    },
    async listCandidates({ policyVersion, limit }) {
      return workers
        .filter(w => {
          const r = rows.get(`${w.id}|${policyVersion}`);
          return !r || (r.state === 'failed' && r.attempts < MAX_POST_SESSION_ATTEMPTS);
        })
        .slice(0, limit)
        .map(w => w.id);
    },
  };
  return store;
}

describe('processPostSessionRun', () => {
  it('collects bounded facts once and records them on the run', async () => {
    const store = fakeStore([worker()]);
    const res = await processPostSessionRun('worker-1', { store, now: NOW });
    expect(res).toEqual({ status: 'collected', runId: 'run-1' });
    const row = store.rows.get(`worker-1|${POST_SESSION_POLICY_VERSION}`)!;
    expect(row.state).toBe('collected');
    expect(row.mode).toBe('shadow');
    expect(row.facts?.context.workerId).toBe('worker-1');
    expect(row.transcriptAvailability).toBe('absent');
  });

  it('is idempotent: reprocessing the same worker is a duplicate and collects nothing', async () => {
    const store = fakeStore([worker()]);
    await processPostSessionRun('worker-1', { store, now: NOW });
    const again = await processPostSessionRun('worker-1', { store, now: NOW });
    expect(again).toEqual({ status: 'duplicate', runId: 'run-1', state: 'collected' });
    expect(store.rows.size).toBe(1);
    expect(store.sourceCalls()).toBe(1);
  });

  it('is idempotent under concurrent processing of the same worker', async () => {
    const store = fakeStore([worker()]);
    const results = await Promise.all(
      Array.from({ length: 6 }, () => processPostSessionRun('worker-1', { store, now: NOW })),
    );
    expect(results.filter(r => r.status === 'collected')).toHaveLength(1);
    expect(results.filter(r => r.status === 'duplicate')).toHaveLength(5);
    expect(store.rows.size).toBe(1);
    expect(store.sourceCalls()).toBe(1);
  });

  it('creates a separate run for a new policy version without touching the old one', async () => {
    const store = fakeStore([worker()]);
    await processPostSessionRun('worker-1', { store, now: NOW });
    const v2 = await processPostSessionRun('worker-1', { store, now: NOW, policyVersion: 'psq-v2' });
    expect(v2.status).toBe('collected');
    expect(store.rows.size).toBe(2);
    expect(store.rows.get(`worker-1|${POST_SESSION_POLICY_VERSION}`)!.state).toBe('collected');
  });

  it('records failure diagnostics, then retries up to the cap and stops', async () => {
    const store = fakeStore([worker()], { failSource: () => true });
    const first = await processPostSessionRun('worker-1', { store, now: NOW });
    expect(first.status).toBe('failed');
    const row = store.rows.get(`worker-1|${POST_SESSION_POLICY_VERSION}`)!;
    expect(row).toMatchObject({ state: 'failed', errorStage: 'collect', attempts: 1 });
    expect(row.lastError).toContain('reviews query timed out');

    for (let i = 2; i <= MAX_POST_SESSION_ATTEMPTS; i++) {
      expect((await processPostSessionRun('worker-1', { store, now: NOW })).status).toBe('failed');
    }
    expect(row.attempts).toBe(MAX_POST_SESSION_ATTEMPTS);
    expect(await processPostSessionRun('worker-1', { store, now: NOW })).toMatchObject({ status: 'duplicate', state: 'failed' });
    expect(store.rows.size).toBe(1);
  });

  it('recovers a failed run on retry', async () => {
    const store = fakeStore([worker()], { failSource: n => n === 1 });
    expect((await processPostSessionRun('worker-1', { store, now: NOW })).status).toBe('failed');
    expect((await processPostSessionRun('worker-1', { store, now: NOW })).status).toBe('collected');
    const row = store.rows.get(`worker-1|${POST_SESSION_POLICY_VERSION}`)!;
    expect(row).toMatchObject({ state: 'collected', attempts: 2 });
    // The failure history stays readable after the retry succeeded.
    expect(row.lastError).toContain('reviews query timed out');
  });

  it('reclaims a run stuck in collecting past the stale window, and fences the stale writer', async () => {
    const store = fakeStore([worker()]);
    const stale = await store.claimRun({
      workerId: 'worker-1', taskId: 'task-1', workspaceId: 'ws-1', missionId: null,
      policyVersion: POST_SESSION_POLICY_VERSION, mode: 'shadow', now: NOW,
    });
    expect(stale.claimed).toBe(true);
    // Within the window: still owned by the first claimant.
    expect((await processPostSessionRun('worker-1', { store, now: new Date(NOW.getTime() + 60_000) })).status).toBe('duplicate');
    const later = new Date(NOW.getTime() + POST_SESSION_STALE_COLLECTING_MS + 1);
    expect((await processPostSessionRun('worker-1', { store, now: later })).status).toBe('collected');
    // The crashed first claimant's late write is fenced by the attempt number.
    expect(await store.completeRun((stale as { runId: string }).runId, 1, {
      facts: null as never, transcriptAvailability: 'unknown', now: later,
    })).toBe(false);
  });

  it('writes nothing for a workspace in off mode', async () => {
    const store = fakeStore([worker({ gitConfig: { postSessionQuality: { mode: 'off' } } as never })]);
    expect(await processPostSessionRun('worker-1', { store, now: NOW })).toEqual({ status: 'disabled' });
    expect(store.rows.size).toBe(0);
  });

  it('records the propose mode in effect at creation time', async () => {
    const store = fakeStore([worker({ gitConfig: { postSessionQuality: { mode: 'propose' } } as never })]);
    await processPostSessionRun('worker-1', { store, now: NOW });
    expect(store.rows.get(`worker-1|${POST_SESSION_POLICY_VERSION}`)!.mode).toBe('propose');
  });

  it('skips ineligible workers without writing a row', async () => {
    const store = fakeStore([
      worker({ id: 'live', status: 'running' }),
      worker({ id: 'never', startedAt: null }),
      worker({ id: 'orphan', taskId: null }),
    ]);
    expect(await processPostSessionRun('live', { store, now: NOW })).toEqual({ status: 'ineligible', reason: 'not_terminal' });
    expect(await processPostSessionRun('never', { store, now: NOW })).toEqual({ status: 'ineligible', reason: 'never_started' });
    expect(await processPostSessionRun('orphan', { store, now: NOW })).toEqual({ status: 'ineligible', reason: 'no_task' });
    expect(await processPostSessionRun('gone', { store, now: NOW })).toEqual({ status: 'missing' });
    expect(store.rows.size).toBe(0);
  });

  it('never throws, even when the store itself fails', async () => {
    const store = fakeStore([worker()]);
    store.claimRun = async () => { throw new Error('connection reset'); };
    const res = await processPostSessionRun('worker-1', { store, now: NOW });
    expect(res).toEqual({ status: 'error', error: 'connection reset' });
  });
});

describe('sweepPostSessionRuns', () => {
  it('processes each eligible worker once; a second sweep is a no-op', async () => {
    const store = fakeStore([worker({ id: 'a' }), worker({ id: 'b' }), worker({ id: 'c' })]);
    const first = await sweepPostSessionRuns({ store, now: NOW });
    expect(first).toMatchObject({ candidates: 3, collected: 3, duplicate: 0, failed: 0 });
    const second = await sweepPostSessionRuns({ store, now: NOW });
    expect(second).toMatchObject({ candidates: 0, collected: 0 });
    expect(store.rows.size).toBe(3);
    expect(store.sourceCalls()).toBe(3);
  });

  it('two overlapping sweeps produce one run per worker', async () => {
    const store = fakeStore([worker({ id: 'a' }), worker({ id: 'b' })]);
    const [s1, s2] = await Promise.all([
      sweepPostSessionRuns({ store, now: NOW }),
      sweepPostSessionRuns({ store, now: NOW }),
    ]);
    expect(s1.collected + s2.collected).toBe(2);
    expect(s1.duplicate + s2.duplicate).toBe(2);
    expect(store.rows.size).toBe(2);
  });

  it('keeps going past one failing worker and reports it', async () => {
    const store = fakeStore([worker({ id: 'a' }), worker({ id: 'b' })], { failSource: n => n === 1 });
    const res = await sweepPostSessionRuns({ store, now: NOW });
    expect(res).toMatchObject({ candidates: 2, collected: 1, failed: 1 });
  });

  it('returns an error summary instead of throwing when listing fails', async () => {
    const store = fakeStore([]);
    store.listCandidates = async () => { throw new Error('db down'); };
    const res = await sweepPostSessionRuns({ store, now: NOW });
    expect(res).toMatchObject({ candidates: 0, errors: 1 });
  });
});
