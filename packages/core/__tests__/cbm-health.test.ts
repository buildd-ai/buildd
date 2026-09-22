import { describe, it, expect, beforeEach } from 'bun:test';
import { mock } from 'bun:test';

// Controlled DB results — mutated per test.
let findManyResult: Array<{ resultMeta: unknown }> = [];
let reportOpsCalls: Array<unknown> = [];
let findManyArgs: Array<Record<string, unknown>> = [];

mock.module('../db', () => ({
  db: {
    query: {
      workers: {
        findMany: (args: Record<string, unknown>) => {
          findManyArgs.push(args);
          return Promise.resolve(findManyResult);
        },
      },
    },
  },
}));
mock.module('../db/schema', () => ({ workers: { workspaceId: 'wid', status: 'st', resultMeta: 'rm', completedAt: 'ca' } }));
mock.module('drizzle-orm', () => ({
  and: (...a: unknown[]) => a,
  desc: (c: unknown) => c,
  eq: (a: unknown, b: unknown) => ['eq', a, b],
  isNotNull: (c: unknown) => ['isNotNull', c],
  inArray: (c: unknown, vals: unknown) => ['inArray', c, vals],
}));
mock.module('../report-ops', () => ({
  reportOps: (input: unknown) => {
    reportOpsCalls.push(input);
    return Promise.resolve(true);
  },
}));

import {
  detectCbmFleetDisabled,
  CBM_FLEET_THRESHOLD,
  detectCbmEnforcedUnused,
  CBM_UNUSED_THRESHOLD,
  CBM_HEALTH_TERMINAL_STATUSES,
} from '../cbm-health';

const WS = 'ws-abc-123';

function makeBinaryAbsentRow() {
  return { resultMeta: { cbm: { outcome: 'disabled', disableReason: 'binary_absent' } } };
}

function makeNoWorktreeRow() {
  return { resultMeta: { cbm: { outcome: 'disabled', disableReason: 'no_worktree' } } };
}

function makeEnforcedRow() {
  return { resultMeta: { cbm: { outcome: 'enforced' } } };
}

function makeBootstrapFailedRow() {
  return { resultMeta: { cbm: { outcome: 'enforced', bootstrapResult: 'failed' } } };
}

describe('detectCbmFleetDisabled', () => {
  beforeEach(() => {
    findManyResult = [];
    reportOpsCalls = [];
    findManyArgs = [];
    process.env.OPS_ALERTS_ENABLED = '1';
  });

  it('does nothing when current worker is not disabled', async () => {
    findManyResult = Array(CBM_FLEET_THRESHOLD - 1).fill(makeBinaryAbsentRow());
    await detectCbmFleetDisabled(WS, { outcome: 'enforced' });
    expect(reportOpsCalls).toHaveLength(0);
  });

  it('does nothing when current is binary_absent but prior workers have fewer than threshold', async () => {
    findManyResult = Array(CBM_FLEET_THRESHOLD - 2).fill(makeBinaryAbsentRow());
    await detectCbmFleetDisabled(WS, { outcome: 'disabled', disableReason: 'binary_absent' });
    expect(reportOpsCalls).toHaveLength(0);
  });

  it('does nothing when one of the prior workers is not disabled (enforced breaks the streak)', async () => {
    findManyResult = [
      makeEnforcedRow(),
      ...Array(CBM_FLEET_THRESHOLD - 2).fill(makeBinaryAbsentRow()),
    ];
    await detectCbmFleetDisabled(WS, { outcome: 'disabled', disableReason: 'binary_absent' });
    expect(reportOpsCalls).toHaveLength(0);
  });

  it('fires alert when current + prior (N-1) are all binary_absent', async () => {
    findManyResult = Array(CBM_FLEET_THRESHOLD - 1).fill(makeBinaryAbsentRow());
    await detectCbmFleetDisabled(WS, { outcome: 'disabled', disableReason: 'binary_absent' });
    expect(reportOpsCalls).toHaveLength(1);
    const call = reportOpsCalls[0] as Record<string, unknown>;
    expect(call.source).toBe('cbm-health');
    expect(call.severity).toBe('error');
    expect(String(call.dedupeKey)).toContain(WS);
    expect(String(call.detail)).toContain('binary_absent');
  });

  it('fires alert on a streak of no_worktree, not just binary_absent', async () => {
    findManyResult = Array(CBM_FLEET_THRESHOLD - 1).fill(makeNoWorktreeRow());
    await detectCbmFleetDisabled(WS, { outcome: 'disabled', disableReason: 'no_worktree' });
    expect(reportOpsCalls).toHaveLength(1);
    const call = reportOpsCalls[0] as Record<string, unknown>;
    expect(String(call.message)).toContain('no_worktree');
    // Not the binary_absent-specific remediation text when no worker in the
    // streak reported binary_absent.
    expect(String(call.detail)).not.toContain('codebase-memory-mcp missing');
  });

  it('fires on a mixed streak of disable reasons, naming all of them', async () => {
    findManyResult = [
      makeNoWorktreeRow(),
      ...Array(CBM_FLEET_THRESHOLD - 2).fill(makeBinaryAbsentRow()),
    ];
    await detectCbmFleetDisabled(WS, { outcome: 'disabled', disableReason: 'no_worktree' });
    expect(reportOpsCalls).toHaveLength(1);
    const call = reportOpsCalls[0] as Record<string, unknown>;
    expect(String(call.message)).toContain('no_worktree');
    expect(String(call.message)).toContain('binary_absent');
    expect(String(call.detail)).toContain('codebase-memory-mcp missing');
    expect(String(call.dedupeKey)).toBe(`cbm-fleet-disabled:${WS}`);
  });


  it('counts failed and error workers in the streak, not only completed ones', async () => {
    // A workspace where every worker DIES is exactly what binary_absent causes;
    // scoping the history query to completed workers meant it could never page.
    expect(CBM_HEALTH_TERMINAL_STATUSES).toEqual(['completed', 'failed', 'error']);
    findManyResult = Array(CBM_FLEET_THRESHOLD - 1).fill(makeBinaryAbsentRow());
    await detectCbmFleetDisabled(WS, { outcome: 'disabled', disableReason: 'binary_absent' });
    const where = JSON.stringify(findManyArgs[0]?.where);
    expect(where).toContain('failed');
    expect(where).toContain('error');
    expect(where).toContain('completed');
    expect(reportOpsCalls).toHaveLength(1);
  });

  it('still requires the full streak — one transient failure does not page', async () => {
    findManyResult = [
      makeEnforcedRow(),
      ...Array(CBM_FLEET_THRESHOLD - 2).fill(makeBinaryAbsentRow()),
    ];
    await detectCbmFleetDisabled(WS, { outcome: 'disabled', disableReason: 'binary_absent' });
    expect(reportOpsCalls).toHaveLength(0);
    // Threshold and dedupe key must be untouched by the status widening.
    findManyResult = Array(CBM_FLEET_THRESHOLD - 1).fill(makeBinaryAbsentRow());
    await detectCbmFleetDisabled(WS, { outcome: 'disabled', disableReason: 'binary_absent' });
    expect(reportOpsCalls).toHaveLength(1);
    expect((reportOpsCalls[0] as Record<string, unknown>).dedupeKey)
      .toBe(`cbm-fleet-disabled:${WS}`);
  });

  it('is a no-op when OPS_ALERTS_ENABLED is not set', async () => {
    delete process.env.OPS_ALERTS_ENABLED;
    findManyResult = Array(CBM_FLEET_THRESHOLD - 1).fill(makeBinaryAbsentRow());
    await detectCbmFleetDisabled(WS, { outcome: 'disabled', disableReason: 'binary_absent' });
    expect(reportOpsCalls).toHaveLength(0);
  });

  it('handles null/undefined currentCbm gracefully', async () => {
    findManyResult = Array(CBM_FLEET_THRESHOLD - 1).fill(makeBinaryAbsentRow());
    await detectCbmFleetDisabled(WS, null);
    await detectCbmFleetDisabled(WS, undefined);
    expect(reportOpsCalls).toHaveLength(0);
  });

  // The bug this task exists to fix: the worker path sets outcome='enforced'
  // unconditionally once CBM is mounted, even when the index bootstrap that
  // enforcement depends on failed. A fleet where every index build fails but
  // the binary is present therefore reported 'enforced' on every worker and
  // this detector's outcome==='disabled' predicate could never see it — 100%
  // healthy while indexing was 100% broken.
  // @signal-fire: cbm-fleet-health
  it('fires when enforced workers all report a failed index bootstrap', async () => {
    findManyResult = Array(CBM_FLEET_THRESHOLD - 1).fill(makeBootstrapFailedRow());
    await detectCbmFleetDisabled(WS, { outcome: 'enforced', bootstrapResult: 'failed' });
    expect(reportOpsCalls).toHaveLength(1);
    const call = reportOpsCalls[0] as Record<string, unknown>;
    expect(call.severity).toBe('error');
    expect(String(call.detail)).toContain('bootstrap_failed');
  });

  it('does not treat a merely-unindexed-yet worker as unhealthy — only outcome=enforced + bootstrapResult=failed counts', async () => {
    findManyResult = Array(CBM_FLEET_THRESHOLD - 1).fill(makeBootstrapFailedRow());
    // skipped_warm means a shared seed was admitted — no per-task index ran, and
    // that is not a failure.
    await detectCbmFleetDisabled(WS, { outcome: 'enforced', bootstrapResult: 'skipped_warm' });
    expect(reportOpsCalls).toHaveLength(0);
  });

  it('a single healthy bootstrap breaks a bootstrap-failed streak', async () => {
    findManyResult = [
      { resultMeta: { cbm: { outcome: 'enforced', bootstrapResult: 'ok' } } },
      ...Array(CBM_FLEET_THRESHOLD - 2).fill(makeBootstrapFailedRow()),
    ];
    await detectCbmFleetDisabled(WS, { outcome: 'enforced', bootstrapResult: 'failed' });
    expect(reportOpsCalls).toHaveLength(0);
  });

  it('names bootstrap failure alongside disabled reasons in a mixed streak', async () => {
    findManyResult = [
      makeBinaryAbsentRow(),
      ...Array(CBM_FLEET_THRESHOLD - 2).fill(makeBootstrapFailedRow()),
    ];
    await detectCbmFleetDisabled(WS, { outcome: 'enforced', bootstrapResult: 'failed' });
    expect(reportOpsCalls).toHaveLength(1);
    const call = reportOpsCalls[0] as Record<string, unknown>;
    expect(String(call.message)).toContain('bootstrap_failed');
    expect(String(call.message)).toContain('binary_absent');
  });
});

describe('detectCbmEnforcedUnused', () => {
  beforeEach(() => {
    findManyResult = [];
    reportOpsCalls = [];
    findManyArgs = [];
    process.env.OPS_ALERTS_ENABLED = '1';
  });

  /** Navigated enough to count as having gone looking for code. */
  const NAV = { readCount: 4, grepCount: 2, globCount: 0 };
  const mountedUnused = () => ({ resultMeta: { cbm: { outcome: 'enforced', toolCalls: {}, ...NAV } } });
  const mountedUsed = () => ({ resultMeta: { cbm: { outcome: 'enforced', toolCalls: { search_graph: 2 }, ...NAV } } });
  /** A coordination/observation task: mounted, but it barely opened a file. */
  const barelyNavigated = () => ({
    resultMeta: { cbm: { outcome: 'enforced', toolCalls: {}, readCount: 1, grepCount: 0, globCount: 0 } },
  });

  it('alerts when a full streak of enforced workers never queried the graph', async () => {
    findManyResult = Array.from({ length: CBM_UNUSED_THRESHOLD - 1 }, mountedUnused);
    await detectCbmEnforcedUnused(WS, { outcome: 'enforced', toolCalls: {}, ...NAV });
    expect(reportOpsCalls.length).toBe(1);
    const call = reportOpsCalls[0] as Record<string, unknown>;
    expect(call.source).toBe('cbm-health');
    // Date-stamped so a multi-day trend pages daily, not every throttle window.
    expect(String(call.dedupeKey)).toMatch(
      new RegExp(`^cbm-enforced-unused:${WS}:\\d{4}-\\d{2}-\\d{2}$`),
    );
    expect(String(call.message)).toContain('never queried');
  });

  it('stays silent when the current worker did call a graph tool', async () => {
    findManyResult = Array.from({ length: CBM_UNUSED_THRESHOLD - 1 }, mountedUnused);
    await detectCbmEnforcedUnused(WS, { outcome: 'enforced', toolCalls: { trace_path: 1 }, ...NAV });
    expect(reportOpsCalls.length).toBe(0);
  });

  it('stays silent when any prior worker in the streak used the graph', async () => {
    findManyResult = [
      ...Array.from({ length: CBM_UNUSED_THRESHOLD - 2 }, mountedUnused),
      mountedUsed(),
    ];
    await detectCbmEnforcedUnused(WS, { outcome: 'enforced', toolCalls: {}, ...NAV });
    expect(reportOpsCalls.length).toBe(0);
  });

  // The reason this alert became noise: most CBM-enforced workers are
  // coordination/observation tasks that never open a file, so they satisfied
  // "made zero graph calls" trivially and the streak was always full.
  it('stays silent when the current worker barely navigated — it had nothing to ask', async () => {
    findManyResult = Array.from({ length: CBM_UNUSED_THRESHOLD - 1 }, mountedUnused);
    await detectCbmEnforcedUnused(WS, {
      outcome: 'enforced', toolCalls: {}, readCount: 1, grepCount: 0, globCount: 0,
    });
    expect(reportOpsCalls.length).toBe(0);
  });

  it('does not count barely-navigating workers as streak members', async () => {
    // A full window of coordination tasks plus one real navigator: not a streak.
    findManyResult = [
      ...Array.from({ length: CBM_UNUSED_THRESHOLD * 4 }, barelyNavigated),
      mountedUnused(),
    ];
    await detectCbmEnforcedUnused(WS, { outcome: 'enforced', toolCalls: {}, ...NAV });
    expect(reportOpsCalls.length).toBe(0);
  });

  it('scans far enough back to find eligible workers among the coordination traffic', async () => {
    // Eligible rows are a small minority, so the streak must still be reachable
    // when they are sparsely interleaved with ineligible ones.
    const padded: Array<unknown> = [];
    for (let i = 0; i < CBM_UNUSED_THRESHOLD - 1; i++) {
      padded.push(barelyNavigated(), barelyNavigated(), mountedUnused());
    }
    findManyResult = padded;
    await detectCbmEnforcedUnused(WS, { outcome: 'enforced', toolCalls: {}, ...NAV });
    expect(reportOpsCalls.length).toBe(1);
  });

  it('does not fire for disabled workers — that is the other detector', async () => {
    findManyResult = Array.from({ length: CBM_UNUSED_THRESHOLD - 1 }, mountedUnused);
    await detectCbmEnforcedUnused(WS, { outcome: 'disabled', disableReason: 'binary_absent' });
    expect(reportOpsCalls.length).toBe(0);
  });

  it('sends a real notification, not a badge-only warning', async () => {
    // severity 'warning' maps to Pushover priority -2: badge only, no sound, no
    // banner. This alert fired in production and was never seen. Adoption being
    // zero is worth waking up for; if it is not, the alert should not exist.
    findManyResult = Array.from({ length: CBM_UNUSED_THRESHOLD - 1 }, mountedUnused);
    await detectCbmEnforcedUnused(WS, { outcome: 'enforced', toolCalls: {}, ...NAV });
    expect((reportOpsCalls[0] as Record<string, unknown>).severity).toBe('error');
  });

  it('carries the observed evidence, not just static prose', async () => {
    findManyResult = Array.from({ length: CBM_UNUSED_THRESHOLD - 1 }, mountedUnused);
    await detectCbmEnforcedUnused(WS, {
      outcome: 'enforced',
      toolCalls: {},
      readCount: 31,
      grepCount: 12,
      globCount: 3,
    });
    const detail = String((reportOpsCalls[0] as Record<string, unknown>).detail);
    // What the agent did instead of querying the graph is the actionable part.
    expect(detail).toContain('31');
    expect(detail).toContain('12');
  });

  it('ignores workers that never had CBM mounted when measuring the streak', async () => {
    // A Codex task or a worktree-less coordination worker carries no cbm key. It
    // is not evidence either way, but it used to break the streak and silence
    // the alert — in a mixed fleet that is most of the time.
    findManyResult = [
      ...Array.from({ length: CBM_UNUSED_THRESHOLD - 1 }, mountedUnused),
      { resultMeta: { stopReason: 'end_turn' } },
      { resultMeta: { stopReason: 'end_turn' } },
    ];
    await detectCbmEnforcedUnused(WS, { outcome: 'enforced', toolCalls: {}, ...NAV });
    expect(reportOpsCalls.length).toBe(1);
  });

  it('still needs a full window of CBM-carrying workers', async () => {
    findManyResult = [
      ...Array.from({ length: 3 }, mountedUnused),
      ...Array.from({ length: 20 }, () => ({ resultMeta: { stopReason: 'end_turn' } })),
    ];
    await detectCbmEnforcedUnused(WS, { outcome: 'enforced', toolCalls: {}, ...NAV });
    expect(reportOpsCalls.length).toBe(0);
  });

  it('stays silent without enough history', async () => {
    findManyResult = Array.from({ length: 2 }, mountedUnused);
    await detectCbmEnforcedUnused(WS, { outcome: 'enforced', toolCalls: {}, ...NAV });
    expect(reportOpsCalls.length).toBe(0);
  });


  it('stays scoped to completed workers — a crashed session makes no graph calls', async () => {
    findManyResult = Array.from({ length: CBM_UNUSED_THRESHOLD - 1 }, mountedUnused);
    await detectCbmEnforcedUnused(WS, { outcome: 'enforced', toolCalls: {}, ...NAV });
    const where = JSON.stringify(findManyArgs[0]?.where);
    expect(where).toContain('completed');
    expect(where).not.toContain('failed');
  });

  it('is a no-op when ops alerting is disabled', async () => {
    delete process.env.OPS_ALERTS_ENABLED;
    findManyResult = Array.from({ length: CBM_UNUSED_THRESHOLD - 1 }, mountedUnused);
    await detectCbmEnforcedUnused(WS, { outcome: 'enforced', toolCalls: {}, ...NAV });
    expect(reportOpsCalls.length).toBe(0);
  });
});
