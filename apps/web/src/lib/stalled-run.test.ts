/**
 * Unit tests for apps/web/src/lib/stalled-run.ts
 *
 * Run: bun run scripts/run-unit-tests.ts apps/web/src/lib/stalled-run.test.ts
 */

import { describe, it, expect } from 'bun:test';
import { stalledFor, STALLED_RUN_THRESHOLD_MS, type StalledRunWorker } from './stalled-run';

const MIN = 60_000;
const now = new Date('2026-10-22T12:00:00Z');
const ago = (ms: number) => now.getTime() - ms;

function worker(over: Partial<StalledRunWorker> = {}): StalledRunWorker {
  return {
    status: 'running',
    waitingFor: null,
    startedAt: new Date(ago(72 * MIN)),
    milestones: [],
    mcpCalls: [],
    ...over,
  };
}

describe('stalledFor', () => {
  it('threshold is 30 minutes', () => {
    expect(STALLED_RUN_THRESHOLD_MS).toBe(30 * MIN);
  });

  it('progressing run → null', () => {
    const w = worker({
      milestones: [
        { type: 'phase', toolCount: 3, ts: ago(50 * MIN) },
        { type: 'action', tool: 'Edit', ts: ago(2 * MIN) },
      ],
    });
    expect(stalledFor(w, now)).toBeNull();
  });

  it('heartbeating but no milestone or turn for 31 min → 31 min', () => {
    // Heartbeats and lease renewals bump updatedAt / leaseExpiresAt only; neither is read.
    const w = worker({
      updatedAt: new Date(ago(10_000)),
      leaseExpiresAt: new Date(now.getTime() + 60_000),
      milestones: [
        { type: 'phase', toolCount: 1, ts: ago(40 * MIN) },
        { type: 'action', tool: 'Bash', cmd: 'bun test', ts: ago(31 * MIN) },
      ],
    } as Partial<StalledRunWorker>);
    expect(stalledFor(w, now)).toBe(31 * MIN);
  });

  it('just started → null', () => {
    expect(stalledFor(worker({ startedAt: new Date(ago(2 * MIN)) }), now)).toBeNull();
  });

  it('no signal since start, started 45 min ago → 45 min', () => {
    expect(stalledFor(worker({ startedAt: new Date(ago(45 * MIN)) }), now)).toBe(45 * MIN);
  });

  it('a recent MCP call counts as progress', () => {
    const w = worker({
      milestones: [{ type: 'phase', toolCount: 1, ts: ago(60 * MIN) }],
      mcpCalls: [{ server: 'buildd', tool: 'buildd_tasks', ts: ago(5 * MIN), ok: true }],
    });
    expect(stalledFor(w, now)).toBeNull();
  });

  it('a recent checkpoint (first commit) counts as progress', () => {
    const w = worker({
      milestones: [
        { type: 'phase', toolCount: 1, ts: ago(60 * MIN) },
        { type: 'checkpoint', event: 'first_commit', ts: ago(1 * MIN) },
      ],
    });
    expect(stalledFor(w, now)).toBeNull();
  });

  it('exactly at the threshold → null; just past → stalled', () => {
    const at = worker({ milestones: [{ type: 'phase', toolCount: 1, ts: ago(30 * MIN) }] });
    expect(stalledFor(at, now)).toBeNull();
    const past = worker({ milestones: [{ type: 'phase', toolCount: 1, ts: ago(30 * MIN + 1) }] });
    expect(stalledFor(past, now)).toBe(30 * MIN + 1);
  });

  it('waiting on input → null (not a stall)', () => {
    expect(stalledFor(worker({ status: 'waiting_input' }), now)).toBeNull();
  });

  it('paused → null', () => {
    expect(stalledFor(worker({ status: 'paused' }), now)).toBeNull();
  });

  it('running with a pause/question still pending → null', () => {
    expect(stalledFor(worker({ waitingFor: { type: 'pause' } }), now)).toBeNull();
  });

  it('pause requested → null', () => {
    expect(stalledFor(worker({ pauseRequestedAt: new Date(ago(40 * MIN)) }), now)).toBeNull();
  });

  it('parked → null', () => {
    expect(stalledFor(worker({ parkedUntil: new Date(now.getTime() + 60 * MIN) }), now)).toBeNull();
  });

  it('terminal or not-yet-running statuses → null', () => {
    for (const status of ['completed', 'failed', 'error', 'superseded', 'idle', 'starting']) {
      expect(stalledFor(worker({ status }), now)).toBeNull();
    }
  });

  it('no startedAt and no signals → null (nothing to measure from)', () => {
    expect(stalledFor(worker({ startedAt: null }), now)).toBeNull();
  });

  it('accepts ISO strings for dates (JSON-serialized rows)', () => {
    const w = worker({ startedAt: new Date(ago(45 * MIN)).toISOString() });
    expect(stalledFor(w, now)).toBe(45 * MIN);
  });

  it('ignores malformed milestone timestamps', () => {
    const w = worker({
      startedAt: new Date(ago(45 * MIN)),
      milestones: [{ type: 'phase', toolCount: 1, ts: 'nope' as unknown as number }],
    });
    expect(stalledFor(w, now)).toBe(45 * MIN);
  });
});
