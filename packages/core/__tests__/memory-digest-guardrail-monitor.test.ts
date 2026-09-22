import { describe, it, expect } from 'bun:test';
import {
  evaluateMemoryDigestGuardrail,
  SHIP_BASELINE_TASK_SCOPED_FAILURES,
  SHIP_BASELINE_TASK_SCOPED_N,
  GUARDRAIL_WINDOW_DAYS,
  type GuardrailMonitorInput,
} from '../memory-digest-guardrail-monitor';
import type { CompositionRow, SessionRow } from '../memory-digest-readout';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-09-25T00:00:00Z');

function tid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

function comp(taskId: string, ts: Date, over: Partial<CompositionRow> = {}): CompositionRow {
  return {
    workerId: `w-${taskId}`,
    taskId,
    buildIndex: 0,
    ts,
    policyVersion: 'memory-digest-v4',
    arm: 'task_scoped',
    propensity: 1,
    taskMatchDerivedBy: 'inferred_paths',
    backend: 'claude',
    promptBytes: 10000,
    memoryBlockBytes: 1500,
    digestBytes: 0,
    digestBytesAvailable: 4000,
    memoryShare: 0.15,
    ...over,
  } as CompositionRow;
}

function sess(taskId: string, status: string): SessionRow {
  return {
    taskId,
    workerId: `w-${taskId}`,
    status,
    turns: 10,
    durationMs: 1000,
    readCalls: 1,
    shellCalls: 1,
    calledRecall: false,
  };
}

/** Baseline rate is 83/345 ≈ 24.06%. */
function makeCohort(n: number, failedCount: number): { composition: CompositionRow[]; sessions: SessionRow[] } {
  const composition: CompositionRow[] = [];
  const sessions: SessionRow[] = [];
  for (let i = 0; i < n; i++) {
    const id = tid(i);
    composition.push(comp(id, new Date(NOW.getTime() - DAY)));
    sessions.push(sess(id, i < failedCount ? 'failed' : 'completed'));
  }
  return { composition, sessions };
}

describe('evaluateMemoryDigestGuardrail', () => {
  it('FIRES when the rolling window is credibly worse than the ship baseline', () => {
    // 200 tasks at 45% failure vs a 24.06% ship baseline — a wide, unmistakable gap.
    const { composition, sessions } = makeCohort(200, 90);
    const verdict = evaluateMemoryDigestGuardrail({ composition, sessions, now: NOW });

    expect(verdict.n).toBe(200);
    expect(verdict.failed).toBe(90);
    expect(verdict.alarm).toBe(true);
    expect(verdict.diff.ciLow).not.toBeNull();
    expect(verdict.diff.ciLow!).toBeGreaterThan(0);
    expect(verdict.reason).toContain('credibly worse');
  });

  it('stays QUIET when the rolling window matches the ship baseline within noise', () => {
    // Same shape as the actual ship-time cohort (83/345) — must not fire on itself.
    const { composition, sessions } = makeCohort(
      SHIP_BASELINE_TASK_SCOPED_N,
      SHIP_BASELINE_TASK_SCOPED_FAILURES,
    );
    const verdict = evaluateMemoryDigestGuardrail({ composition, sessions, now: NOW });

    expect(verdict.alarm).toBe(false);
    expect(verdict.diff.ciLow === null || verdict.diff.ciLow <= 0).toBe(true);
  });

  it('stays QUIET on a small noisy sample even when the point estimate looks worse', () => {
    // 3 tasks, 2 failed (66.7%) — looks alarming as a point estimate, but n=3
    // cannot distinguish that from noise, and the CI must reflect it.
    const { composition, sessions } = makeCohort(3, 2);
    const verdict = evaluateMemoryDigestGuardrail({ composition, sessions, now: NOW });

    expect(verdict.alarm).toBe(false);
  });

  it('excludes rows outside the window', () => {
    const inWindow = comp(tid(1), new Date(NOW.getTime() - DAY));
    const outOfWindow = comp(tid(2), new Date(NOW.getTime() - (GUARDRAIL_WINDOW_DAYS + 5) * DAY));
    const sessions = [sess(tid(1), 'completed'), sess(tid(2), 'failed')];
    const verdict = evaluateMemoryDigestGuardrail({
      composition: [inWindow, outOfWindow],
      sessions,
      now: NOW,
    });

    expect(verdict.n).toBe(1);
    expect(verdict.failed).toBe(0);
  });

  it('excludes the pre-flip randomised cohort (propensity < 1) from the rolling window', () => {
    const randomised = comp(tid(1), new Date(NOW.getTime() - DAY), { propensity: 0.5 });
    const shipped = comp(tid(2), new Date(NOW.getTime() - DAY), { propensity: 1 });
    const sessions = [sess(tid(1), 'failed'), sess(tid(2), 'completed')];
    const verdict = evaluateMemoryDigestGuardrail({
      composition: [randomised, shipped],
      sessions,
      now: NOW,
    });

    expect(verdict.n).toBe(1);
    expect(verdict.failed).toBe(0);
  });

  it('excludes the `full` arm entirely, even if some row is mislabelled propensity 1', () => {
    const fullArm = comp(tid(1), new Date(NOW.getTime() - DAY), { arm: 'full' });
    const sessions = [sess(tid(1), 'failed')];
    const verdict = evaluateMemoryDigestGuardrail({ composition: [fullArm], sessions, now: NOW });

    expect(verdict.n).toBe(0);
    expect(verdict.sessionless).toBe(0);
  });

  it('reports a shipped-arm task with no matching session as sessionless, never as a pass', () => {
    const noSession = comp(tid(1), new Date(NOW.getTime() - DAY));
    const verdict = evaluateMemoryDigestGuardrail({ composition: [noSession], sessions: [], now: NOW });

    expect(verdict.n).toBe(0);
    expect(verdict.sessionless).toBe(1);
    expect(verdict.rate).toBeNull();
  });

  it('excludes rows on another (or unrecorded) backend', () => {
    const codex = comp(tid(1), new Date(NOW.getTime() - DAY), { backend: 'codex' });
    const unrecorded = comp(tid(2), new Date(NOW.getTime() - DAY), { backend: null });
    const sessions = [sess(tid(1), 'failed'), sess(tid(2), 'failed')];
    const verdict = evaluateMemoryDigestGuardrail({
      composition: [codex, unrecorded],
      sessions,
      now: NOW,
    });

    expect(verdict.n).toBe(0);
  });
});
