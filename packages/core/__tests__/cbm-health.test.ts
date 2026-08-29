import { describe, it, expect, beforeEach } from 'bun:test';
import { mock } from 'bun:test';

// Controlled DB results — mutated per test.
let findManyResult: Array<{ resultMeta: unknown }> = [];
let reportOpsCalls: Array<unknown> = [];

mock.module('../db', () => ({
  db: {
    query: {
      workers: {
        findMany: () => Promise.resolve(findManyResult),
      },
    },
  },
}));
mock.module('../db/schema', () => ({ workers: { workspaceId: 'wid', status: 'st', resultMeta: 'rm', completedAt: 'ca' } }));
mock.module('drizzle-orm', () => ({
  and: (...a: unknown[]) => a,
  desc: (c: unknown) => c,
  eq: (a: unknown, b: unknown) => [a, b],
  isNotNull: (c: unknown) => c,
}));
mock.module('../report-ops', () => ({
  reportOps: (input: unknown) => {
    reportOpsCalls.push(input);
    return Promise.resolve(true);
  },
}));

import { detectCbmFleetDisabled, CBM_FLEET_THRESHOLD } from '../cbm-health';

const WS = 'ws-abc-123';

function makeBinaryAbsentRow() {
  return { resultMeta: { cbm: { outcome: 'disabled', disableReason: 'binary_absent' } } };
}

function makeEnforcedRow() {
  return { resultMeta: { cbm: { outcome: 'enforced' } } };
}

describe('detectCbmFleetDisabled', () => {
  beforeEach(() => {
    findManyResult = [];
    reportOpsCalls = [];
    process.env.OPS_ALERTS_ENABLED = '1';
  });

  it('does nothing when current worker is not binary_absent', async () => {
    findManyResult = Array(CBM_FLEET_THRESHOLD - 1).fill(makeBinaryAbsentRow());
    await detectCbmFleetDisabled(WS, { outcome: 'enforced' });
    expect(reportOpsCalls).toHaveLength(0);
  });

  it('does nothing when current worker is disabled but not binary_absent', async () => {
    findManyResult = Array(CBM_FLEET_THRESHOLD - 1).fill(makeBinaryAbsentRow());
    await detectCbmFleetDisabled(WS, { outcome: 'disabled', disableReason: 'codex_task' });
    expect(reportOpsCalls).toHaveLength(0);
  });

  it('does nothing when current is binary_absent but prior workers have fewer than threshold', async () => {
    findManyResult = Array(CBM_FLEET_THRESHOLD - 2).fill(makeBinaryAbsentRow());
    await detectCbmFleetDisabled(WS, { outcome: 'disabled', disableReason: 'binary_absent' });
    expect(reportOpsCalls).toHaveLength(0);
  });

  it('does nothing when one of the prior workers has a non-binary_absent outcome', async () => {
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
});
