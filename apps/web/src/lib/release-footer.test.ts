process.env.NODE_ENV = 'test';

import { describe, it, expect, mock, beforeEach } from 'bun:test';

// ── Chainable db.select mock — queue up one result per call within a test ────

let selectResults: any[] = [];
function chainable(result: any) {
  const obj: any = {
    from: () => obj,
    where: () => obj,
    orderBy: () => obj,
    limit: () => obj,
    innerJoin: () => obj,
    then: (resolve: any) => resolve(result),
  };
  return obj;
}
const mockSelect = mock(() => chainable(selectResults.shift()));

mock.module('@buildd/core/db', () => ({
  db: { select: mockSelect },
}));

mock.module('@buildd/core/db/schema', () => ({
  releases: { id: 'id', workspaceId: 'workspace_id', createdAt: 'created_at', state: 'state' },
  workers: { taskId: 'task_id', mergedAt: 'merged_at' },
  tasks: { id: 'id', workspaceId: 'workspace_id' },
}));

mock.module('drizzle-orm', () => ({
  desc: (a: any) => ({ type: 'desc', a }),
  eq: (a: any, b: any) => ({ type: 'eq', a, b }),
  and: (...args: any[]) => ({ type: 'and', args }),
  isNotNull: (a: any) => ({ type: 'isNotNull', a }),
  sql: Object.assign((strings: TemplateStringsArray, ...values: any[]) => ({ type: 'sql', strings, values }), {}),
}));

const mockDetectArchetype = mock(() => 'none' as any);
mock.module('@buildd/core/release-archetype', () => ({ detectArchetype: mockDetectArchetype }));

const mockResolveGatedReleaseBaseline = mock(() => Promise.resolve({ source: 'none', asOf: null }) as any);
mock.module('@/lib/release-baseline', () => ({ resolveGatedReleaseBaseline: mockResolveGatedReleaseBaseline }));

// ── Now import the module under test ─────────────────────────────────────────

import { loadReleaseFooterData } from './release-footer';

const ws = { id: 'ws-1', name: 'buildd', gitConfig: null, releaseConfig: null };

describe('loadReleaseFooterData', () => {
  beforeEach(() => {
    selectResults = [];
    mockSelect.mockClear();
    mockDetectArchetype.mockReset();
    mockResolveGatedReleaseBaseline.mockReset();
  });

  it('archetype none → returns null (no query beyond archetype detection)', async () => {
    mockDetectArchetype.mockReturnValue('none');
    const data = await loadReleaseFooterData(ws);
    expect(data).toBeNull();
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it('gated, unseeded baseline, 4 unshipped merges → queue depth 4 with prod_head source', async () => {
    mockDetectArchetype.mockReturnValue('gated');
    mockResolveGatedReleaseBaseline.mockResolvedValue({ source: 'prod_head', asOf: '2026-08-01T00:00:00.000Z' });
    selectResults = [
      [{ id: 'rel-latest' }], // latest release row lookup
      [{ queueDepth: 4, oldestMergedAt: '2026-08-10T00:00:00.000Z' }], // queue count
    ];
    const data = await loadReleaseFooterData(ws);
    expect(data).toMatchObject({
      archetype: 'gated',
      queueDepth: { kind: 'value', value: 4 },
      oldestMergedAt: { kind: 'value', value: '2026-08-10T00:00:00.000Z' },
      baselineSource: 'prod_head',
      releaseId: 'rel-latest',
    });
  });

  it('gated, no baseline resolvable at all → queueDepth unavailable (no_baseline)', async () => {
    mockDetectArchetype.mockReturnValue('gated');
    mockResolveGatedReleaseBaseline.mockResolvedValue({ source: 'none', asOf: null });
    selectResults = [[]]; // latest release row lookup only — no queue query issued
    const data = await loadReleaseFooterData(ws);
    expect(data).toMatchObject({
      archetype: 'gated',
      queueDepth: { kind: 'unavailable', reason: 'no_baseline' },
      releaseId: null,
    });
  });

  it('gated, healthy baseline, zero unshipped merges → clean (queueDepth 0)', async () => {
    mockDetectArchetype.mockReturnValue('gated');
    mockResolveGatedReleaseBaseline.mockResolvedValue({ source: 'healthy', asOf: '2026-08-20T00:00:00.000Z' });
    selectResults = [
      [{ id: 'rel-latest' }],
      [{ queueDepth: 0, oldestMergedAt: null }],
    ];
    const data = await loadReleaseFooterData(ws);
    expect(data).toMatchObject({
      archetype: 'gated',
      queueDepth: { kind: 'value', value: 0 },
      oldestMergedAt: { kind: 'unavailable', reason: 'no_scope' },
      baselineSource: 'healthy',
    });
  });

  it('continuous, a release row exists → last deploy state', async () => {
    mockDetectArchetype.mockReturnValue('continuous');
    selectResults = [
      [{ id: 'rel-1', state: 'healthy', deployedAt: '2026-08-15T00:00:00.000Z', healthyAt: '2026-08-15T01:00:00.000Z' }],
    ];
    const data = await loadReleaseFooterData(ws);
    expect(data).toMatchObject({
      archetype: 'continuous',
      state: 'healthy',
      deployedAt: '2026-08-15T00:00:00.000Z',
      healthyAt: '2026-08-15T01:00:00.000Z',
      releaseId: 'rel-1',
    });
  });

  it('continuous, no release row exists → null (unseeded, no chrome)', async () => {
    mockDetectArchetype.mockReturnValue('continuous');
    selectResults = [[]];
    const data = await loadReleaseFooterData(ws);
    expect(data).toBeNull();
  });
});
