/**
 * Unit tests for CBM observability metric collection.
 *
 * Verifies that:
 *   - cbmOutcome is set correctly from the activation result
 *   - cbmToolCounts accumulates per CBM tool name
 *   - cbmFileAccessCounts tracks Read/Grep/Glob separately
 *   - resultMeta.cbm is populated with correct totals at session end
 */

import { describe, test, expect } from 'bun:test';
// The REAL assembly, not a copy of it. This file used to define its own
// "simulates what workers.ts does" version, which by construction could not fail
// when the shipped shape changed — and a field that was computed but never
// emitted (sharedCache) is exactly how the shared cache's hit rate stayed
// invisible on the fleet for a week.
import { buildCbmMetrics } from '../../src/cbm-enforcement';

describe('buildCbmMetrics — shared-seed visibility', () => {
  test('emits sharedCache=false rather than omitting the key', () => {
    // The distinction that matters: a row with sharedCache:false says "this task
    // did not get the seed". An absent key is indistinguishable from a worker
    // that predates the field, which is what made 0% and 70% look identical.
    const m = buildCbmMetrics({ cbmOutcome: 'enforced' })!;
    expect(m.sharedCache).toBe(false);
    expect(Object.keys(m)).toContain('sharedCache');
  });

  test('emits sharedCache=true when the session ran on the seed', () => {
    const m = buildCbmMetrics({ cbmOutcome: 'enforced', cbmSharedCache: true })!;
    expect(m.sharedCache).toBe(true);
  });

  test('carries the seed-refresh outcome so a never-seeded repo is queryable', () => {
    const m = buildCbmMetrics({ cbmOutcome: 'enforced', cbmSeedRefresh: 'script_absent' })!;
    expect(m.seedRefresh).toBe('script_absent');
  });

  test("types skipped_warm, which the shipped code has written all along", () => {
    const m = buildCbmMetrics({ cbmOutcome: 'enforced', cbmBootstrapResult: 'skipped_warm' })!;
    expect(m.bootstrapResult).toBe('skipped_warm');
  });

  test('still returns undefined when CBM never activated', () => {
    expect(buildCbmMetrics({})).toBeUndefined();
  });
});

// Pure helper: simulates what workers.ts does when a CBM or file-access tool call arrives.
function handleToolCall(
  toolName: string,
  worker: {
    cbmToolCounts: Record<string, number>;
    cbmFileAccessCounts: { read: number; grep: number; glob: number };
  }
) {
  if (toolName.startsWith('mcp__codebase-memory__')) {
    const cbmTool = toolName.slice('mcp__codebase-memory__'.length);
    worker.cbmToolCounts[cbmTool] = (worker.cbmToolCounts[cbmTool] ?? 0) + 1;
  } else {
    if (toolName === 'Read') worker.cbmFileAccessCounts.read++;
    else if (toolName === 'Grep') worker.cbmFileAccessCounts.grep++;
    else if (toolName === 'Glob') worker.cbmFileAccessCounts.glob++;
  }
}

describe('CBM outcome classification', () => {
  test('enforced when buildCbmActivation returns enforced=true', () => {
    const metrics = buildCbmMetrics({
      cbmOutcome: 'enforced',
      cbmToolCounts: {},
      cbmFileAccessCounts: { read: 0, grep: 0, glob: 0 },
    });
    expect(metrics?.outcome).toBe('enforced');
    expect(metrics?.disableReason).toBeUndefined();
  });

  test('disabled with reason binary_absent', () => {
    const metrics = buildCbmMetrics({
      cbmOutcome: 'disabled',
      cbmDisableReason: 'binary_absent',
      cbmToolCounts: {},
      cbmFileAccessCounts: { read: 5, grep: 2, glob: 1 },
    });
    expect(metrics?.outcome).toBe('disabled');
    expect(metrics?.disableReason).toBe('binary_absent');
    expect(metrics?.readCount).toBe(5);
  });

  test('legacy_mcp_json when detected via .mcp.json path', () => {
    const metrics = buildCbmMetrics({
      cbmOutcome: 'legacy_mcp_json',
      cbmToolCounts: { search_code: 1 },
      cbmFileAccessCounts: { read: 2, grep: 0, glob: 0 },
    });
    expect(metrics?.outcome).toBe('legacy_mcp_json');
    expect(metrics?.totalCbmCalls).toBe(1);
  });

  test('returns undefined when cbmOutcome was never set', () => {
    const metrics = buildCbmMetrics({});
    expect(metrics).toBeUndefined();
  });
});

describe('CBM bootstrap observability', () => {
  test('bootstrapResult ok is recorded in metrics when bootstrap succeeds', () => {
    const metrics = buildCbmMetrics({
      cbmOutcome: 'enforced',
      cbmBootstrapResult: 'ok',
      cbmToolCounts: {},
      cbmFileAccessCounts: { read: 0, grep: 0, glob: 0 },
    });
    expect(metrics?.bootstrapResult).toBe('ok');
    expect(metrics?.bootstrapFailReason).toBeUndefined();
  });

  test('bootstrapResult failed and reason are recorded when bootstrap fails', () => {
    const metrics = buildCbmMetrics({
      cbmOutcome: 'enforced',
      cbmBootstrapResult: 'failed',
      cbmBootstrapFailReason: 'timeout after 30000ms',
      cbmToolCounts: {},
      cbmFileAccessCounts: { read: 0, grep: 0, glob: 0 },
    });
    expect(metrics?.bootstrapResult).toBe('failed');
    expect(metrics?.bootstrapFailReason).toBe('timeout after 30000ms');
  });

  test('bootstrapResult absent when CBM was disabled (binary absent)', () => {
    const metrics = buildCbmMetrics({
      cbmOutcome: 'disabled',
      cbmDisableReason: 'binary_absent',
      cbmToolCounts: {},
      cbmFileAccessCounts: { read: 0, grep: 0, glob: 0 },
    });
    expect(metrics?.bootstrapResult).toBeUndefined();
  });
});

describe('CBM tool call counting', () => {
  test('accumulates counts per CBM tool name', () => {
    const worker = { cbmToolCounts: {} as Record<string, number>, cbmFileAccessCounts: { read: 0, grep: 0, glob: 0 } };
    handleToolCall('mcp__codebase-memory__search_code', worker);
    handleToolCall('mcp__codebase-memory__search_code', worker);
    handleToolCall('mcp__codebase-memory__query_graph', worker);
    expect(worker.cbmToolCounts.search_code).toBe(2);
    expect(worker.cbmToolCounts.query_graph).toBe(1);
  });

  test('does not count non-CBM MCP tools in cbmToolCounts', () => {
    const worker = { cbmToolCounts: {} as Record<string, number>, cbmFileAccessCounts: { read: 0, grep: 0, glob: 0 } };
    handleToolCall('mcp__buildd__buildd', worker);
    expect(Object.keys(worker.cbmToolCounts).length).toBe(0);
  });

  test('totalCbmCalls sums all tool counts', () => {
    const metrics = buildCbmMetrics({
      cbmOutcome: 'enforced',
      cbmToolCounts: { search_code: 3, query_graph: 2, trace_path: 1 },
      cbmFileAccessCounts: { read: 0, grep: 0, glob: 0 },
    });
    expect(metrics?.totalCbmCalls).toBe(6);
  });
});

describe('File-access tool counting', () => {
  test('increments read, grep, glob independently', () => {
    const worker = { cbmToolCounts: {} as Record<string, number>, cbmFileAccessCounts: { read: 0, grep: 0, glob: 0 } };
    handleToolCall('Read', worker);
    handleToolCall('Read', worker);
    handleToolCall('Grep', worker);
    handleToolCall('Glob', worker);
    handleToolCall('Bash', worker); // not counted
    expect(worker.cbmFileAccessCounts.read).toBe(2);
    expect(worker.cbmFileAccessCounts.grep).toBe(1);
    expect(worker.cbmFileAccessCounts.glob).toBe(1);
  });

  test('metrics reflect file-access counts correctly', () => {
    const metrics = buildCbmMetrics({
      cbmOutcome: 'enforced',
      cbmToolCounts: {},
      cbmFileAccessCounts: { read: 10, grep: 4, glob: 2 },
    });
    expect(metrics?.readCount).toBe(10);
    expect(metrics?.grepCount).toBe(4);
    expect(metrics?.globCount).toBe(2);
  });

  test('non-file tools (Bash, Edit, Write) are not counted', () => {
    const worker = { cbmToolCounts: {} as Record<string, number>, cbmFileAccessCounts: { read: 0, grep: 0, glob: 0 } };
    handleToolCall('Bash', worker);
    handleToolCall('Edit', worker);
    handleToolCall('Write', worker);
    expect(worker.cbmFileAccessCounts.read).toBe(0);
    expect(worker.cbmFileAccessCounts.grep).toBe(0);
    expect(worker.cbmFileAccessCounts.glob).toBe(0);
  });
});
