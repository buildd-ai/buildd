/**
 * Regression guard for heartbeat log-volume reduction (measured at 26% of
 * the entire runner log — one distinct "runner alive" message every 60s,
 * whose only informational branch, DEGRADED, has never fired).
 *
 * This reduction is only safe AFTER the logging shim (log.ts) gives every
 * line its own timestamp — the heartbeat used to be the log's only clock.
 * With that in place, routine "alive" ticks can collapse into an occasional
 * summary instead of one line every 60s. DEGRADED must never be collapsed:
 * it is exactly the diagnostic signal the collapse rule exists to protect.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/heartbeat-log.test.ts
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { emitHeartbeatTick } from '../../src/heartbeat-log';
import { __resetCollapseState } from '../../src/log';

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

describe('emitHeartbeatTick', () => {
  beforeEach(() => __resetCollapseState());

  test('the first alive tick emits directly', () => {
    const cap = captureConsole();
    try {
      emitHeartbeatTick(false, '', 0);
    } finally {
      cap.restore();
    }
    expect(cap.lines.length).toBe(1);
    expect(cap.lines[0].method).toBe('log');
    expect(String(cap.lines[0].args[0])).toContain('runner alive');
  });

  test('60 consecutive alive ticks (1 hour at 60s each) print far fewer than 60 lines', () => {
    const cap = captureConsole();
    try {
      for (let i = 0; i < 60; i++) {
        emitHeartbeatTick(false, '', i * 60_000);
      }
    } finally {
      cap.restore();
    }
    expect(cap.lines.length).toBeLessThan(10);
  });

  test('DEGRADED always emits directly, every single tick, never collapsed', () => {
    const cap = captureConsole();
    try {
      for (let i = 0; i < 10; i++) {
        emitHeartbeatTick(true, 'no successful server contact (last: 10m ago); claims are failing', i * 60_000);
      }
    } finally {
      cap.restore();
    }
    expect(cap.lines.length).toBe(10);
    expect(cap.lines.every(l => l.method === 'error')).toBe(true);
    expect(String(cap.lines[0].args[0])).toContain('DEGRADED');
  });

  test('a DEGRADED tick interrupts an alive collapse window without corrupting it', () => {
    const cap = captureConsole();
    try {
      emitHeartbeatTick(false, '', 0); // alive, emits directly, opens window
      emitHeartbeatTick(false, '', 60_000); // alive, suppressed
      emitHeartbeatTick(true, 'gap', 120_000); // degraded — always emits
      emitHeartbeatTick(false, '', 180_000); // alive again, still within original window
    } finally {
      cap.restore();
    }
    const degradedLines = cap.lines.filter(l => l.method === 'error');
    expect(degradedLines.length).toBe(1);
  });
});
