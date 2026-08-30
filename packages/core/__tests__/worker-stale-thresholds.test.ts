import { describe, it, expect } from 'bun:test';
import {
  WORKER_HARD_TIMEOUT_MS,
  WORKER_STALE_REAP_GRACE_MS,
  WORKER_STALE_REAP_MS,
} from '@buildd/shared';

/**
 * Regression: the server reaper and the runner's own backstop drifted apart.
 *
 * The runner deliberately keeps a worker alive through long silent tool calls
 * (worker-sync.ts checkStale skips the stale-abort while `toolInFlight` is set),
 * backstopped by WORKER_HARD_TIMEOUT_MS. The server, which has no knowledge of
 * `toolInFlight`, was reaping the same worker after 15 minutes of a frozen
 * `workers.updatedAt` — so every silent tool call between 15 and 30 minutes was
 * a guaranteed false-positive kill of a healthy session.
 *
 * These are not two independent tunables: the server must stay quiet until the
 * runner's own backstop has had a chance to fire and report a specific error,
 * otherwise a generic "stale worker expired" overwrites the real reason. The
 * constants now live together in @buildd/shared so the relationship is
 * enforceable rather than coincidental.
 */
describe('worker staleness thresholds', () => {
  it('never lets the server reap a worker before the runner backstop fires', () => {
    expect(WORKER_STALE_REAP_MS).toBeGreaterThan(WORKER_HARD_TIMEOUT_MS);
  });

  it('leaves a positive grace window for the runner to report a real cause', () => {
    expect(WORKER_STALE_REAP_GRACE_MS).toBeGreaterThan(0);
    expect(WORKER_STALE_REAP_MS).toBe(WORKER_HARD_TIMEOUT_MS + WORKER_STALE_REAP_GRACE_MS);
  });

  it('keeps the runner backstop at 30 minutes', () => {
    // worker-sync.ts documents 30 minutes as the absolute ceiling for a worker
    // producing no SDK activity. If this changes, the server threshold derived
    // from it moves too — which is the point of deriving it.
    expect(WORKER_HARD_TIMEOUT_MS).toBe(30 * 60 * 1000);
  });
});
