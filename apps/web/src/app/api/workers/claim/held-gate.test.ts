import { describe, it, expect, mock } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';

const mockMissionsFindFirst = mock(() => null as any);

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      missions: { findFirst: mockMissionsFindFirst },
    },
  },
}));

import { missionNotHeld, BYPASS_HELD_GATE_KEY, checkMissionHeld } from './held-gate';

/**
 * The held gate is a SQL expression. We verify the exported constant that
 * encodes the bypass key name (since inspecting the drizzle SQL object
 * directly hits circular-ref issues in JSON.stringify).
 *
 * Behavioural contract (prose):
 *   - Task with no missionId → always claimable (no mission to be held).
 *   - Task under armed mission (isHeld=false) → claimable.
 *   - Task under held mission (isHeld=true) → NOT claimable.
 *   - Task under held mission but context[BYPASS_HELD_GATE_KEY]=true → claimable
 *     (force-start bypass set by /start with forceOverride=true and a missionId).
 */
describe('checkMissionHeld', () => {
  it('returns false when mission is not held', async () => {
    mockMissionsFindFirst.mockResolvedValue(null);
    const result = await checkMissionHeld('mission-123');
    expect(result).toBe(false);
  });

  it('returns true when mission is held', async () => {
    mockMissionsFindFirst.mockResolvedValue({ id: 'mission-123' });
    const result = await checkMissionHeld('mission-123');
    expect(result).toBe(true);
  });
});

describe('held gate — bypass key contract', () => {
  it('bypass key is "bypassHeldGate"', () => {
    expect(BYPASS_HELD_GATE_KEY).toBe('bypassHeldGate');
  });

  it('missionNotHeld() returns a SQL fragment', () => {
    const result = missionNotHeld();
    expect(result).toBeDefined();
    expect(typeof result).toBe('object');
  });

  it('bypass key is a stable string — changing it would break context written by /start', () => {
    // The key must match what /api/tasks/[id]/start writes to task.context.
    // A rename here without updating the start route would silently break bypass.
    expect(BYPASS_HELD_GATE_KEY).toEqual('bypassHeldGate');
  });
});

// ─── The emitted SQL ─────────────────────────────────────────────────────────
//
// `typeof result === 'object'` was the entire guard on the SQL gate, and it let
// every semantic mutation through: `m.is_held = true` → `= false`, dropping the
// bypass clause, `mission_id IS NULL` → `IS NOT NULL`, `NOT EXISTS` → `EXISTS`.
// Each one is a whole-fleet outage in one direction or the other — either held
// missions keep dispatching (the hold button does nothing) or every task under
// any mission becomes permanently unclaimable.
//
// The circular-ref problem the comment above describes is real for
// JSON.stringify, but PgDialect renders the fragment fine, and per-file test
// processes keep the route test's `drizzle-orm` mock out of this file.

const dialect = new PgDialect();

function renderHeldGate(): string {
  return dialect
    .sqlToQuery(missionNotHeld())
    .sql.replace(/\s+/g, ' ')
    .trim();
}

describe('missionNotHeld() — emitted SQL', () => {
  it('lets a task with no mission through', () => {
    // `IS NOT NULL` here inverts the escape: mission-less tasks (the majority)
    // would need a held mission to be claimable, i.e. none of them ever claims.
    expect(renderHeldGate()).toContain('"tasks"."mission_id" IS NULL');
  });

  it('honours the force-start bypass written into task.context', () => {
    const text = renderHeldGate();
    expect(text).toContain(`"tasks"."context"->>'${BYPASS_HELD_GATE_KEY}' = 'true'`);
    // The three arms are alternatives, not requirements — an AND here would
    // mean a task needs no mission AND a bypass AND an unheld mission.
    expect(text).not.toContain('AND "tasks"."context"');
    expect(text.split(' OR ')).toHaveLength(3);
  });

  it('blocks a task whose mission is held, and only when it is held', () => {
    const text = renderHeldGate();
    // NOT EXISTS(held mission) — `EXISTS` would claim *only* held missions'
    // tasks; `is_held = false` would make holding a mission a no-op.
    expect(text).toMatch(
      /OR NOT EXISTS \( SELECT 1 FROM "missions" m WHERE m\.id = "tasks"\."mission_id" AND m\.is_held = true \)/,
    );
  });
});

describe('checkMissionHeld — query shape', () => {
  it('filters on is_held, not merely on the mission id', async () => {
    // The DB is mocked, so the where clause was never observed: dropping
    // `eq(missions.isHeld, true)` left the file green while making every
    // existing mission report as held — /api/tasks/[id]/start would refuse to
    // start any mission task at all.
    mockMissionsFindFirst.mockResolvedValue(null);
    await checkMissionHeld('mission-abc');

    const args = mockMissionsFindFirst.mock.calls.at(-1)![0] as { where: any };
    const { sql: text, params } = dialect.sqlToQuery(args.where);
    expect(text.replace(/\s+/g, ' ')).toContain('"missions"."is_held" = $2');
    expect(text).toContain('"missions"."id" = $1');
    expect(params).toEqual(['mission-abc', true]);
  });
});
