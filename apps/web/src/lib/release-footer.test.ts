process.env.NODE_ENV = 'test';

import { describe, it, expect, mock, beforeEach } from 'bun:test';

// ── Chainable db.select mock — queue up one result per call within a test ────

let selectResults: any[] = [];
// Every WHERE this module builds, in call order. A mocked `db` makes predicates
// unobservable, and queue depth is exactly a predicate — so capture them.
let capturedWheres: any[] = [];
function chainable(result: any) {
  const obj: any = {
    from: () => obj,
    where: (pred: any) => {
      capturedWheres.push(pred);
      return obj;
    },
    orderBy: () => obj,
    limit: () => obj,
    innerJoin: () => obj,
    then: (resolve: any) => resolve(result),
  };
  return obj;
}

/** Flatten the fake `and(...)`/`sql` tree into the SQL text it would render. */
function whereText(pred: any): string {
  if (pred == null) return '';
  if (Array.isArray(pred)) return pred.map(whereText).join(' ');
  if (pred.type === 'and') return pred.args.map(whereText).join(' ');
  if (pred.type === 'sql') return (pred.strings ?? []).join('?') + ' ' + (pred.values ?? []).join(' ');
  return '';
}
const mockSelect = mock(() => chainable(selectResults.shift()));

mock.module('@buildd/core/db', () => ({
  db: { select: mockSelect },
}));

mock.module('@buildd/core/db/schema', () => ({
  releases: { id: 'id', workspaceId: 'workspace_id', createdAt: 'created_at', state: 'state' },
  workers: { taskId: 'task_id', mergedAt: 'merged_at', prBaseRef: 'pr_base_ref' },
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
    capturedWheres = [];
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

  // P4 / mission-delivery-arc: a task PR that merged into `mission/<slug>` has
  // landed on the integration branch, NOT on trunk. Counting it here reports a
  // mission's work as releasable while nothing of it is on trunk, and then
  // counts it a second time when the mission PR merges.
  it('gated → the queue-depth WHERE excludes merges into a mission integration branch', async () => {
    mockDetectArchetype.mockReturnValue('gated');
    mockResolveGatedReleaseBaseline.mockResolvedValue({ source: 'healthy', asOf: '2026-08-20T00:00:00.000Z' });
    selectResults = [
      [{ id: 'rel-latest' }],
      [{ queueDepth: 1, oldestMergedAt: null }],
    ];
    await loadReleaseFooterData(ws);

    const queueWhere = whereText(capturedWheres[capturedWheres.length - 1]).toLowerCase();
    expect(queueWhere).toContain('not like');
    expect(queueWhere).toContain('mission/%');
    // Null base refs (every row merged before the column existed) still count.
    expect(queueWhere).toContain('is null');
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
