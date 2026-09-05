import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';

// ── db mock ──────────────────────────────────────────────────────────────────
// A mocked `db` makes every predicate unobservable, so this file captures the
// select fields and the WHERE fragment and renders them with PgDialect rather
// than trusting that "the query ran".

let capturedSelectFields: Record<string, unknown> | null = null;
let capturedWhere: unknown = null;
let selectRows: Array<Record<string, unknown>> = [];
let selectCallCount = 0;

const mockSelect = mock((fields: Record<string, unknown>) => {
  selectCallCount++;
  capturedSelectFields = fields;
  const chain: Record<string, unknown> = {};
  chain.from = () => chain;
  chain.leftJoin = () => chain;
  chain.innerJoin = () => chain;
  chain.where = (pred: unknown) => {
    capturedWhere = pred;
    return Promise.resolve(selectRows);
  };
  return chain;
});

mock.module('@buildd/core/db', () => ({ db: { select: mockSelect } }));

import {
  classifyMissionShipState,
  shouldQueryMissionShipState,
  loadMissionShipState,
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
