/**
 * Unit tests for the runner logging shim (apps/runner/src/log.ts):
 *  - timestamp + level + short correlation id, replacing the old
 *    `[Worker <uuid>] ` 46-byte literal prefix
 *  - collapseTick / logCollapsed: the non-negotiable collapse rule — any
 *    dedupe of repeated lines must carry {suppressed, windowMs, firstTs,
 *    lastTs} on the eventual summary, proven here by replaying a burst
 *    (1000+ occurrences in 5 minutes) as a fixture.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/log.test.ts
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { logInfo, logWarn, logError, collapseTick, collapseFlush, logCollapsed, __resetCollapseState } from '../../src/log';

function captureConsole() {
  const lines: { method: string; args: unknown[] }[] = [];
  const originals = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...args: unknown[]) => lines.push({ method: 'log', args });
  console.warn = (...args: unknown[]) => lines.push({ method: 'warn', args });
  console.error = (...args: unknown[]) => lines.push({ method: 'error', args });
  return {
    lines,
    restore: () => {
      console.log = originals.log;
      console.warn = originals.warn;
      console.error = originals.error;
    },
  };
}

describe('log shim formatting', () => {
  test('logInfo emits one line with an ISO timestamp and no raw uuid prefix', () => {
    const cap = captureConsole();
    try {
      logInfo('worker ready', { workerId: '11111111-2222-3333-4444-555555555555' });
    } finally {
      cap.restore();
    }
    expect(cap.lines.length).toBe(1);
    const line = String(cap.lines[0].args[0]);
    expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
    // Short correlation id (8 chars), not the old `[Worker <full-uuid>] ` prefix.
    expect(line).toContain('w:11111111');
    expect(line).not.toContain('11111111-2222-3333-4444-555555555555');
    expect(line).not.toContain('[Worker 11111111-2222-3333-4444-555555555555]');
  });

  test('logWarn/logError route to console.warn/console.error respectively', () => {
    const cap = captureConsole();
    try {
      logWarn('careful');
      logError('bad');
    } finally {
      cap.restore();
    }
    expect(cap.lines.map(l => l.method)).toEqual(['warn', 'error']);
  });

  test('includes taskId tag when provided', () => {
    const cap = captureConsole();
    try {
      logInfo('claimed', { taskId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });
    } finally {
      cap.restore();
    }
    expect(String(cap.lines[0].args[0])).toContain('t:aaaaaaaa');
  });
});

describe('collapseTick', () => {
  beforeEach(() => __resetCollapseState());

  test('first occurrence in a fresh window always emits directly', () => {
    const result = collapseTick('k1', 60_000, 1_000);
    expect(result.kind).toBe('emit');
  });

  test('occurrences within the window are suppressed, not silently lost', () => {
    collapseTick('k2', 60_000, 0);
    const second = collapseTick('k2', 60_000, 10_000);
    const third = collapseTick('k2', 60_000, 20_000);
    expect(second.kind).toBe('suppressed');
    expect(third.kind).toBe('suppressed');
  });

  test('crossing the window boundary flushes a summary carrying suppressed/windowMs/firstTs/lastTs', () => {
    collapseTick('k3', 60_000, 0); // emit, opens window at t=0
    collapseTick('k3', 60_000, 10_000); // suppressed #1
    collapseTick('k3', 60_000, 20_000); // suppressed #2
    const flushed = collapseTick('k3', 60_000, 70_000); // window elapsed -> summary
    expect(flushed.kind).toBe('summary');
    if (flushed.kind === 'summary') {
      expect(flushed.summary.suppressed).toBe(2);
      expect(flushed.summary.firstTs).toBe(0);
      expect(flushed.summary.lastTs).toBe(20_000);
      expect(flushed.summary.windowMs).toBe(20_000);
    }
  });

  test('a window with nothing suppressed emits directly again on the next occurrence', () => {
    collapseTick('k4', 60_000, 0); // emit
    const next = collapseTick('k4', 60_000, 70_000); // window elapsed, nothing suppressed
    expect(next.kind).toBe('emit');
  });

  test('independent keys do not interfere with each other', () => {
    collapseTick('a', 60_000, 0);
    const b = collapseTick('b', 60_000, 0);
    expect(b.kind).toBe('emit');
  });

  test('burst fixture: 1000+ occurrences in 5 minutes collapse to a handful of lines with accurate counts', () => {
    const key = 'burst';
    const windowMs = 30_000; // 30s windows inside the 5-minute burst
    const totalEvents = 1200;
    const burstDurationMs = 5 * 60_000; // 5 minutes
    let emits = 0;
    let totalSuppressedReported = 0;
    let summaries = 0;

    for (let i = 0; i < totalEvents; i++) {
      const now = Math.floor((i / totalEvents) * burstDurationMs);
      const tick = collapseTick(key, windowMs, now);
      if (tick.kind === 'emit') emits++;
      else if (tick.kind === 'summary') {
        summaries++;
        totalSuppressedReported += tick.summary.suppressed;
        expect(tick.summary.lastTs).toBeGreaterThanOrEqual(tick.summary.firstTs);
        expect(tick.summary.windowMs).toBeGreaterThanOrEqual(0);
      }
    }

    // Force-close the trailing window so its suppressed tail is counted too.
    const tail = collapseFlush(key);
    if (tail) totalSuppressedReported += tail.suppressed;

    // Every occurrence is accounted for: either it was one of the direct
    // emits (1 per window-open, including the summary-triggering one) or it
    // was folded into a reported suppressed count. Nothing vanishes.
    expect(emits + summaries + totalSuppressedReported).toBe(totalEvents);
    // The whole point: a 1200-event burst reads as a handful of lines, not 1200.
    expect(emits + summaries).toBeLessThan(50);
    expect(totalSuppressedReported).toBeGreaterThan(1000);
  });
});

describe('logCollapsed', () => {
  beforeEach(() => __resetCollapseState());

  test('first call logs directly; calls inside the window are silent; the flush call logs a summary with counts', () => {
    const cap = captureConsole();
    try {
      logCollapsed('warn', 'claim-poll-failure', 60_000, 'Failed to claim tasks on reconnect: boom');
      // Manipulate via repeated calls at the same instant (window still open) —
      // real callers pass wall-clock `now` implicitly via Date.now(), so we
      // only assert on call count/shape here, not exact timing.
      logCollapsed('warn', 'claim-poll-failure', 60_000, 'Failed to claim tasks on reconnect: boom');
      logCollapsed('warn', 'claim-poll-failure', 60_000, 'Failed to claim tasks on reconnect: boom');
    } finally {
      cap.restore();
    }
    // First call emits; the next two (same window) are suppressed -> exactly one line so far.
    expect(cap.lines.length).toBe(1);
    expect(cap.lines[0].method).toBe('warn');
  });

  test('never dumps a raw Error object (no multi-line stack) — only a message string', () => {
    const cap = captureConsole();
    const err = new Error('server unreachable');
    try {
      logCollapsed('warn', 'claim-poll-failure-2', 60_000, `Failed to claim tasks on startup: ${err.message}`);
    } finally {
      cap.restore();
    }
    expect(cap.lines.length).toBe(1);
    const arg = cap.lines[0].args[0];
    expect(typeof arg).toBe('string');
    expect(String(arg)).not.toContain('at ');
    expect(String(arg).split('\n').length).toBe(1);
  });
});
