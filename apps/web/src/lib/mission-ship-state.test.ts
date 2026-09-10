import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { isMissionIntegrationMerge } from '@buildd/core/release-queue-scope';

// ── db mock ──────────────────────────────────────────────────────────────────
// A mocked `db` makes every predicate unobservable, so this file captures the
// select fields and the WHERE fragment and renders them with PgDialect rather
// than trusting that "the query ran".

let capturedSelectFields: Record<string, unknown> | null = null;
let capturedWhere: unknown = null;
let selectRows: Array<Record<string, unknown>> = [];
let selectCallCount = 0;

// Option A' fixture mode. The mocked db cannot execute SQL, so when this is set
// the aggregate row is computed FROM the query the loader actually built: the
// base-ref exclusion is applied only if the query carries it. That is what makes
// the Option A' assertions below value assertions that fail when the filter is
// missing, rather than a restatement of the classifier's own precedence.
let fixtureMissionMerges: Array<{ taskId: string; prBaseRef: string | null }> | null = null;

function rowFromFixture(): Record<string, unknown> {
  const mergedSql = render(capturedSelectFields?.mergedTaskCount);
  const excludesMissionBranches = /pr_base_ref/.test(mergedSql) && /not like/i.test(mergedSql);
  const counted = fixtureMissionMerges!.filter(
    (m) => !(excludesMissionBranches && isMissionIntegrationMerge(m.prBaseRef)),
  );
  return {
    openWorkCount: 0,
    mergedTaskCount: new Set(counted.map((m) => m.taskId)).size,
    shippedTaskCount: 0,
  };
}

const mockSelect = mock((fields: Record<string, unknown>) => {
  selectCallCount++;
  capturedSelectFields = fields;
  const chain: Record<string, unknown> = {};
  chain.from = () => chain;
  chain.leftJoin = () => chain;
  chain.innerJoin = () => chain;
  chain.where = (pred: unknown) => {
    capturedWhere = pred;
    const rows = fixtureMissionMerges ? [rowFromFixture()] : selectRows;
    // Thenable AND chainable: `loadMissionShipState` awaits `.where(...)`
    // directly, `loadShippedMissionIds` chains `.groupBy(...)` after it.
    const resultChain: Record<string, unknown> = {
      groupBy: () => Promise.resolve(rows),
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve(rows).then(resolve, reject),
      catch: (reject: (e: unknown) => unknown) => Promise.resolve(rows).catch(reject),
    };
    return resultChain;
  };
  return chain;
});

mock.module('@buildd/core/db', () => ({ db: { select: mockSelect } }));

import {
  classifyMissionShipState,
  shouldQueryMissionShipState,
  loadMissionShipState,
  loadShippedMissionIds,
  type MissionShipEvidence,
  type MissionShipState,
} from './mission-ship-state';

const dialect = new PgDialect();
function render(frag: unknown): string {
  return dialect.sqlToQuery(frag as never).sql.replace(/\s+/g, ' ').trim();
}
function renderParams(frag: unknown): unknown[] {
  return dialect.sqlToQuery(frag as never).params;
}

function evidence(over: Partial<MissionShipEvidence> = {}): MissionShipEvidence {
  return { openWorkCount: 0, mergedTaskCount: 0, shippedTaskCount: 0, releaseAttempted: false, ...over };
}

// ── The archetype/workspace branch — decided WITHOUT a release query ─────────
// Spec §9 AC-42: `none` is the ONLY state reached without looking at release
// data. `not_applicable` is this classifier's `none`, so it must obey the same
// rule — hence a guard callable before the loader issues anything.

describe('shouldQueryMissionShipState', () => {
  it('is false for a workspace-less mission — there is no release ledger to join', () => {
    expect(shouldQueryMissionShipState({ workspaceId: null, archetype: 'gated' })).toBe(false);
  });

  it('is false for archetype none', () => {
    expect(shouldQueryMissionShipState({ workspaceId: 'ws-1', archetype: 'none' })).toBe(false);
  });

  it('is true for the release-capable archetypes', () => {
    for (const archetype of ['gated', 'continuous', 'store', 'package'] as const) {
      expect(shouldQueryMissionShipState({ workspaceId: 'ws-1', archetype })).toBe(true);
    }
  });
});

describe('classifyMissionShipState — not_applicable', () => {
  it('returns not_applicable for a workspace-less mission', () => {
    expect(classifyMissionShipState({ archetype: 'gated', workspaceId: null, evidence: null })).toBe('not_applicable');
  });

  it('returns not_applicable for archetype none', () => {
    expect(classifyMissionShipState({ archetype: 'none', workspaceId: 'ws-1', evidence: null })).toBe('not_applicable');
  });

  it('lets the archetype branch win even when evidence was somehow loaded', () => {
    // Guards against a caller that queries first and classifies second: the
    // archetype answer must not depend on release data at all.
    expect(
      classifyMissionShipState({
        archetype: 'none',
        workspaceId: 'ws-1',
        evidence: evidence({ mergedTaskCount: 4, shippedTaskCount: 4 }),
      }),
    ).toBe('not_applicable');
  });
});

describe('classifyMissionShipState — the four live states', () => {
  it('building while any non-terminal work remains', () => {
    expect(
      classifyMissionShipState({ archetype: 'gated', workspaceId: 'ws-1', evidence: evidence({ openWorkCount: 2, mergedTaskCount: 3 }) }),
    ).toBe('building');
  });

  it('shipped when a healthy release contains the work', () => {
    expect(
      classifyMissionShipState({
        archetype: 'gated',
        workspaceId: 'ws-1',
        evidence: evidence({ mergedTaskCount: 3, shippedTaskCount: 3 }),
      }),
    ).toBe('shipped');
  });

  it('shipped, not release_failed, when an attempt was recorded AND a healthy release contains the work', () => {
    // `release_failed` is defined as "an attempt was recorded, no healthy
    // release contains the work" — a successful retry after a failed attempt
    // must not read as failed forever.
    expect(
      classifyMissionShipState({
        archetype: 'gated',
        workspaceId: 'ws-1',
        evidence: evidence({ mergedTaskCount: 3, shippedTaskCount: 3, releaseAttempted: true }),
      }),
    ).toBe('shipped');
  });

  it('release_failed when an attempt was recorded and no healthy release contains the work', () => {
    expect(
      classifyMissionShipState({
        archetype: 'gated',
        workspaceId: 'ws-1',
        evidence: evidence({ mergedTaskCount: 3, shippedTaskCount: 0, releaseAttempted: true }),
      }),
    ).toBe('release_failed');
  });

  it('merged_unshipped when work merged, nothing healthy carries it, and no attempt was recorded', () => {
    expect(
      classifyMissionShipState({
        archetype: 'gated',
        workspaceId: 'ws-1',
        evidence: evidence({ mergedTaskCount: 3 }),
      }),
    ).toBe('merged_unshipped');
  });

  it('building for a release-capable mission that has produced nothing yet', () => {
    expect(classifyMissionShipState({ archetype: 'continuous', workspaceId: 'ws-1', evidence: evidence() })).toBe('building');
  });

  it('building — never a partially_shipped — when open work coexists with shipped work', () => {
    // The design doc removes `partially_shipped` on purpose. Open work means the
    // mission is still building; it must not report `shipped` off a partial join.
    expect(
      classifyMissionShipState({
        archetype: 'gated',
        workspaceId: 'ws-1',
        evidence: evidence({ openWorkCount: 1, mergedTaskCount: 5, shippedTaskCount: 4 }),
      }),
    ).toBe('building');
  });

  it('never returns not_applicable for a release-capable mission with no evidence loaded', () => {
    // §9.1: a release-capable mission with nothing to show must not be computed
    // the same way as an archetype-`none` one.
    const out: MissionShipState = classifyMissionShipState({ archetype: 'gated', workspaceId: 'ws-1', evidence: null });
    expect(out).not.toBe('not_applicable');
    expect(out).toBe('building');
  });
});

// ── Loader ───────────────────────────────────────────────────────────────────

describe('loadMissionShipState', () => {
  beforeEach(() => {
    mockSelect.mockClear();
    selectCallCount = 0;
    capturedSelectFields = null;
    capturedWhere = null;
    selectRows = [];
  });

  const gatedWorkspace = {
    name: 'illustrative-workspace',
    releaseConfig: { enabled: true, prodBranch: 'main' },
    gitConfig: { requiresPR: true, defaultBranch: 'dev' },
  };

  it('issues NO release query for archetype none (the §9 AC-42 analogue)', async () => {
    const out = await loadMissionShipState(
      { id: 'm-1', workspaceId: 'ws-1', releaseAttemptedAt: null },
      { name: 'illustrative-workspace', releaseConfig: null, gitConfig: { requiresPR: true } },
    );
    expect(out).toBe('not_applicable');
    expect(selectCallCount).toBe(0);
  });

  it('issues NO release query for a workspace-less mission', async () => {
    const out = await loadMissionShipState({ id: 'm-1', workspaceId: null, releaseAttemptedAt: null }, null);
    expect(out).toBe('not_applicable');
    expect(selectCallCount).toBe(0);
  });

  it('scopes the evidence query to the mission and partitions on healthy releases', async () => {
    selectRows = [{ openWorkCount: 0, mergedTaskCount: 2, shippedTaskCount: 2 }];

    await loadMissionShipState({ id: 'm-1', workspaceId: 'ws-1', releaseAttemptedAt: null }, gatedWorkspace);

    expect(selectCallCount).toBe(1);
    // The mission scope must be in the WHERE, not implied by the mock.
    expect(render(capturedWhere)).toContain('"tasks"."mission_id" = ');
    // The shipped partition must actually test releases.state = 'healthy'.
    const shipped = render(capturedSelectFields?.shippedTaskCount);
    expect(shipped).toContain('"releases"."state"');
    expect(shipped).toContain("'healthy'");
    // The merged partition must read workers.merged_at, not task status.
    expect(render(capturedSelectFields?.mergedTaskCount)).toContain('"workers"."merged_at"');
    // The open-work partition must emit a real IN list, not one bound array
    // param (drizzle expands an interpolated array; a raw `= $1` would compare
    // a status against an array and count every task as open).
    const open = render(capturedSelectFields?.openWorkCount);
    expect(open).toContain('"tasks"."status" not in ($1, $2, $3)');
    expect(renderParams(capturedSelectFields?.openWorkCount)).toEqual(['completed', 'failed', 'cancelled']);
    // Every count must be DISTINCT — a task with N workers or N release edges
    // would otherwise be counted N times by the multiplied join.
    for (const field of ['openWorkCount', 'mergedTaskCount', 'shippedTaskCount'] as const) {
      expect(render(capturedSelectFields?.[field])).toContain('count(distinct');
    }
  });

  it('reads releaseAttemptedAt as the attempt signal — merged work + an attempt + nothing healthy is release_failed', async () => {
    selectRows = [{ openWorkCount: 0, mergedTaskCount: 3, shippedTaskCount: 0 }];

    const out = await loadMissionShipState(
      { id: 'm-1', workspaceId: 'ws-1', releaseAttemptedAt: new Date('2026-01-01T00:00:00.000Z') },
      gatedWorkspace,
    );
    expect(out).toBe('release_failed');
  });

  it('the same evidence without an attempt is merged_unshipped', async () => {
    selectRows = [{ openWorkCount: 0, mergedTaskCount: 3, shippedTaskCount: 0 }];

    const out = await loadMissionShipState(
      { id: 'm-1', workspaceId: 'ws-1', releaseAttemptedAt: null },
      gatedWorkspace,
    );
    expect(out).toBe('merged_unshipped');
  });

  it('returns building when the aggregate row comes back empty', async () => {
    selectRows = [];
    const out = await loadMissionShipState(
      { id: 'm-1', workspaceId: 'ws-1', releaseAttemptedAt: null },
      gatedWorkspace,
    );
    expect(out).toBe('building');
  });
});

// ── Option A': merges into a mission integration branch are not on trunk ─────
// `packages/core/release-queue-scope.ts` exists because a mission that opts into
// an integration branch stamps `workers.mergedAt` once per task PR while nothing
// of that mission has reached trunk. Four release-queue queries carry its
// base-ref filter; this module's `mergedTaskCount` was the fifth and missed it,
// so an A' mission with every task PR merged into the integration branch and the
// mission PR still open reported `merged_unshipped` — "everything is merged, the
// release queue is what's next" — while trunk had none of it.

describe("loadMissionShipState — Option A' integration-branch merges", () => {
  const MISSION_BRANCH = 'mission/example-slug-0a1b2c3d';
  const gatedWorkspace = {
    name: 'illustrative-workspace',
    releaseConfig: { enabled: true, prodBranch: 'main' },
    gitConfig: { requiresPR: true, defaultBranch: 'dev' },
  };
  const mission = { id: 'm-1', workspaceId: 'ws-1', releaseAttemptedAt: null };

  beforeEach(() => {
    mockSelect.mockClear();
    selectCallCount = 0;
    capturedSelectFields = null;
    capturedWhere = null;
    selectRows = [];
    fixtureMissionMerges = null;
  });

  afterEach(() => {
    fixtureMissionMerges = null;
  });

  it('the merged partition carries the base-ref exclusion, and an unknown base still counts', async () => {
    selectRows = [{ openWorkCount: 0, mergedTaskCount: 0, shippedTaskCount: 0 }];

    await loadMissionShipState(mission, gatedWorkspace);

    const merged = render(capturedSelectFields?.mergedTaskCount);
    expect(merged).toContain('"workers"."merged_at"');
    expect(merged).toContain('"workers"."pr_base_ref"');
    expect(merged).toMatch(/not like/i);
    expect(renderParams(capturedSelectFields?.mergedTaskCount)).toContain('mission/%');
    // A null base ref means "we do not know", which must never read as
    // quarantined — every row merged before the column existed is null.
    expect(merged).toContain('is null');
  });

  it('a mission whose task PRs all merged into its integration branch is NOT merged_unshipped', async () => {
    fixtureMissionMerges = [
      { taskId: 't-1', prBaseRef: MISSION_BRANCH },
      { taskId: 't-2', prBaseRef: MISSION_BRANCH },
    ];

    const out = await loadMissionShipState(mission, gatedWorkspace);

    // Nothing is on trunk and the mission is still awaiting its one review gate.
    expect(out).toBe('building');
    expect(out).not.toBe('merged_unshipped');
  });

  it('the mission PR itself (base = trunk) does count as merged work', async () => {
    // The bookkeeping owner row for the mission PR merges into trunk, and that
    // merge IS releasable work — the filter must not swallow it too.
    fixtureMissionMerges = [
      { taskId: 't-1', prBaseRef: MISSION_BRANCH },
      { taskId: 't-owner', prBaseRef: 'dev' },
    ];

    expect(await loadMissionShipState(mission, gatedWorkspace)).toBe('merged_unshipped');
  });

  it('a merge with an unknown base ref still counts — pre-A\' rows keep their behaviour', async () => {
    fixtureMissionMerges = [{ taskId: 't-1', prBaseRef: null }];

    expect(await loadMissionShipState(mission, gatedWorkspace)).toBe('merged_unshipped');
  });
});

// ── loadShippedMissionIds — batched rollup signal ───────────────────────────

describe('loadShippedMissionIds', () => {
  beforeEach(() => {
    mockSelect.mockClear();
    selectCallCount = 0;
    capturedWhere = null;
    selectRows = [];
    fixtureMissionMerges = null;
  });

  it('returns an empty set and issues NO query for an empty mission list', async () => {
    const out = await loadShippedMissionIds([]);
    expect(out.size).toBe(0);
    expect(selectCallCount).toBe(0);
  });

  it('issues exactly one query for many missions — not one per mission', async () => {
    selectRows = [{ missionId: 'm-1' }, { missionId: 'm-2' }];
    await loadShippedMissionIds(['m-1', 'm-2', 'm-3']);
    expect(selectCallCount).toBe(1);
  });

  it('returns the mission ids with at least one task in a healthy release', async () => {
    selectRows = [{ missionId: 'm-1' }];
    const out = await loadShippedMissionIds(['m-1', 'm-2']);
    expect(out.has('m-1')).toBe(true);
    expect(out.has('m-2')).toBe(false);
  });

  it('scopes to the given mission ids and partitions on healthy releases', async () => {
    selectRows = [];
    await loadShippedMissionIds(['m-1', 'm-2']);
    const where = render(capturedWhere);
    expect(where).toContain('"tasks"."mission_id" in');
    expect(where).toContain('"releases"."state" = ');
    expect(renderParams(capturedWhere)).toContain('healthy');
  });
});
