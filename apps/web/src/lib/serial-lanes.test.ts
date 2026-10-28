import { describe, expect, it } from 'bun:test';
import {
  MIGRATION_LANE,
  laneKeysFor,
  lanePathsFor,
  laneVerdict,
  lanePosition,
  isOwnPrRepair,
  stuckSince,
  STUCK_LANE_MS,
  type LaneMember,
  type LaneView,
} from './serial-lanes';
import { compareLaneOrder } from './claim-order';

const t0 = new Date('2026-10-01T00:00:00Z');
const at = (min: number) => new Date(t0.getTime() + min * 60_000);

function member(taskId: string, o: Partial<LaneMember> = {}): LaneMember {
  return {
    taskId, claimableSince: at(0), priority: 0, createdAt: at(0), heldAt: null,
    holding: false, ready: true, status: 'pending', prNumber: null, prUrl: null, lastActivityAt: null, ...o,
  };
}
const view = (members: LaneMember[]): LaneView => ({ workspaceId: 'ws', lane: MIGRATION_LANE, members });

describe('lane keys', () => {
  it('schema and migration paths are the migration lane', () => {
    expect(laneKeysFor(['packages/core/db/schema.ts'], null)).toEqual([MIGRATION_LANE]);
    expect(laneKeysFor(['packages/core/drizzle/20261023000000_x/migration.sql', 'apps/web/a.ts'], null)).toEqual([MIGRATION_LANE]);
  });

  it('ordinary files, the repo-wide sentinel and an empty manifest are in no lane', () => {
    expect(laneKeysFor(['apps/web/src/lib/a.ts'], null)).toEqual([]);
    expect(laneKeysFor(['**'], null)).toEqual([]);
    expect(laneKeysFor(null, null)).toEqual([]);
  });

  it('each configured hard surface is its own lane', () => {
    const gitConfig = { overlapHotspots: ['apps/web/src/hot.ts'] } as never;
    expect(laneKeysFor(['apps/web/src/hot.ts', 'packages/core/db/schema.ts'], gitConfig).sort())
      .toEqual([MIGRATION_LANE, 'surface:hotspot:apps/web/src/hot.ts'].sort());
    expect(lanePathsFor(['apps/web/src/hot.ts', 'apps/web/x.ts'], gitConfig, 'surface:hotspot:apps/web/src/hot.ts')).toEqual(['apps/web/src/hot.ts']);
  });

  it('a malformed surface config keeps the migration lane and drops the surfaces', () => {
    const gitConfig = { overlapHotspots: 'not-a-list' } as never;
    expect(laneKeysFor(['packages/core/db/schema.ts', 'x.ts'], gitConfig)).toEqual([MIGRATION_LANE]);
  });
});

describe('lane order (I-3)', () => {
  it('first come by claimable time, then priority, then age; unstamped last', () => {
    const rows = [
      { taskId: 'c', claimableSince: at(5), priority: 9, createdAt: at(0) },
      { taskId: 'a', claimableSince: at(1), priority: 0, createdAt: at(3) },
      { taskId: 'n', claimableSince: null, priority: 10, createdAt: at(0) },
      { taskId: 'b', claimableSince: at(1), priority: 5, createdAt: at(4) },
    ];
    expect(rows.sort(compareLaneOrder).map(r => r.taskId)).toEqual(['b', 'a', 'c', 'n']);
  });
});

describe('lane verdict', () => {
  it('AC-2: behind a holder, B and C are positions 1 and 2 naming the holder', () => {
    const v = view([member('A', { holding: true, heldAt: at(2), status: 'in_progress' }), member('B', { claimableSince: at(1) }), member('C', { claimableSince: at(3) })]);
    const b = laneVerdict(v, 'B');
    const c = laneVerdict(v, 'C');
    expect(b).toMatchObject({ kind: 'held', holder: { taskId: 'A' }, position: 1 });
    expect(c).toMatchObject({ kind: 'held', holder: { taskId: 'A' }, position: 2 });
    expect(laneVerdict(v, 'A').kind).toBe('holder');
  });

  it('AC-2: once the holder leaves, B may take the lane and C is position 1 behind B', () => {
    const v = view([member('B', { claimableSince: at(1) }), member('C', { claimableSince: at(3) })]);
    expect(laneVerdict(v, 'B').kind).toBe('free');
    expect(laneVerdict(v, 'C')).toMatchObject({ kind: 'behind', ahead: { taskId: 'B' }, position: 1 });
    expect(lanePosition(v, 'C')).toBe(1);
  });

  it('AC-3 / I-4: a parked, held or dependency-blocked task ahead keeps its position and blocks nobody', () => {
    const v = view([member('P', { claimableSince: at(1), ready: false }), member('Q', { claimableSince: at(2) })]);
    expect(laneVerdict(v, 'Q').kind).toBe('free');
    expect(lanePosition(v, 'P')).toBe(0);
    expect(lanePosition(v, 'Q')).toBe(1);
    // Q takes the lane: P keeps its place, first behind the holder.
    const held = view([member('P', { claimableSince: at(1), ready: false }), member('Q', { claimableSince: at(2), holding: true, heldAt: at(3) })]);
    expect(lanePosition(held, 'P')).toBe(1);
  });

  it('a task with no entry yet stands at the back', () => {
    const v = view([member('A', { holding: true }), member('B')]);
    expect(laneVerdict(v, 'Z')).toMatchObject({ kind: 'held', position: 2 });
  });
});

describe('own-PR repairs (I-6)', () => {
  it('a conflict, CI or review fix attempt for a PR is exempt; an ordinary task is not', () => {
    expect(isOwnPrRepair({ taskClass: 'attempt', conflictRetryPrNumber: 7 })).toBe(true);
    expect(isOwnPrRepair({ taskClass: 'attempt', ciRetryPrNumber: 7 })).toBe(true);
    expect(isOwnPrRepair({ taskClass: 'attempt', reviewerRetryPrNumber: 7 })).toBe(true);
    expect(isOwnPrRepair({ taskClass: 'attempt' })).toBe(false);
    expect(isOwnPrRepair({ taskClass: 'task', conflictRetryPrNumber: 7 })).toBe(false);
  });
});

describe('stuck lane (I-7)', () => {
  it('a holder whose PR saw no activity for 24h is stuck, from its last activity', () => {
    const now = at(60 * 30);
    const holder = member('A', { holding: true, heldAt: at(0), prNumber: 7, lastActivityAt: at(60) });
    expect(stuckSince(holder, now)).toEqual(at(60));
    expect(stuckSince({ ...holder, lastActivityAt: new Date(now.getTime() - STUCK_LANE_MS + 60_000) }, now)).toBeNull();
  });

  it('a holder with no PR yet (still running) is never stuck', () => {
    expect(stuckSince(member('A', { holding: true, heldAt: at(0) }), at(60 * 48))).toBeNull();
  });
});
