import { describe, it, expect, mock } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';

const mockMissionsFindFirst = mock(() => null as any);
const mockTasksFindFirst = mock(() => null as any);

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      missions: { findFirst: mockMissionsFindFirst },
      tasks: { findFirst: mockTasksFindFirst },
    },
  },
}));

import { missionNotHeld, missionNotLocal, checkMissionLocal, checkTaskMissionLocal, BYPASS_HELD_GATE_KEY, checkMissionHeld, taskNotHeld, TASK_HOLD_KEY, notHeldOrLocal, REVIEWER_FOR_KEY } from './held-gate';

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
    const q = dialect.sqlToQuery(missionNotHeld());
    // Coalesced (see the two-valued test below); the key is a bound param.
    expect(text).toMatch(/COALESCE\("tasks"\."context"->>\$1, ''\) = 'true'/);
    expect(q.params[0]).toBe(BYPASS_HELD_GATE_KEY);
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

// Friction cad81659: `context->>'bypassHeldGate' = 'true'` is NULL when the key
// is absent, so a HELD mission's gate evaluated to NULL OR NULL OR FALSE = NULL
// rather than FALSE. The claim WHERE excludes either way, but the explicit-claim
// probe reads the gate as a column and took NULL for "not evaluated", answering
// "Excluded by a claim filter this diagnosis does not cover".
describe('missionNotHeld(): two-valued', () => {
  it('never reads the bypass key bare (a missing key must be FALSE, not NULL)', () => {
    const text = renderHeldGate();
    expect(text).not.toMatch(/"tasks"\."context"->>'bypassHeldGate' = 'true'/);
    expect(text).toContain('COALESCE("tasks"."context"->>');
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

describe('taskNotHeld() — a single held task is not claimable', () => {
  it('passes a task only when its context carries no hold', () => {
    const text = dialect.sqlToQuery(taskNotHeld()).sql.replace(/\s+/g, ' ').trim();
    // `IS NOT NULL` would make every task unclaimable except the held ones.
    expect(text).toBe(`("tasks"."context"->'${TASK_HOLD_KEY}') IS NULL`);
  });

  it('the hold key is stable — the PATCH route writes it', () => {
    expect(TASK_HOLD_KEY).toBe('heldBy');
  });
});

// ─── executor='local' (task 09ed6675) ────────────────────────────────────────
describe('missionNotLocal() — emitted SQL', () => {
  const render = () => dialect.sqlToQuery(missionNotLocal());
  const text = () => render().sql.replace(/\s+/g, ' ').trim();

  it('lets a task with no mission through', () => {
    expect(text()).toContain('"tasks"."mission_id" IS NULL');
  });

  it('blocks a task only when its mission runs locally', () => {
    // `EXISTS` would make runners claim ONLY local missions' tasks; `<> 'local'`
    // would make every runner-executed mission unclaimable.
    expect(text()).toMatch(
      /OR NOT EXISTS \( SELECT 1 FROM "missions" m WHERE m\.id = "tasks"\."mission_id" AND m\.executor = 'local' \)/,
    );
    // Independent of the hold: the held gate is its own predicate.
    expect(text()).not.toContain('is_held');
  });

  it('honours the dashboard force-start bypass, two-valued', () => {
    expect(text()).toMatch(/COALESCE\("tasks"\."context"->>\$1, ''\) = 'true'/);
    expect(render().params[0]).toBe(BYPASS_HELD_GATE_KEY);
    expect(text().split(' OR ')).toHaveLength(4);
  });

  // A reviewer task is filed by the platform into the reviewed task's mission.
  // Nothing tells the local session it exists, so under the local gate it sat
  // pending with no worker and the PR it gates never merged.
  it('lets a reviewer task through: the review is the merge gate, not mission work', () => {
    expect(text()).toContain(`OR ("tasks"."context"->'${REVIEWER_FOR_KEY}') IS NOT NULL`);
    // Exempt from the executor only — a held mission still holds its reviews.
    expect(dialect.sqlToQuery(missionNotHeld()).sql).not.toContain(REVIEWER_FOR_KEY);
  });
});

describe('checkMissionLocal — query shape', () => {
  it('filters on executor = local, not merely on the mission id', async () => {
    mockMissionsFindFirst.mockResolvedValue(null);
    expect(await checkMissionLocal('mission-abc')).toBe(false);
    const args = mockMissionsFindFirst.mock.calls.at(-1)![0] as { where: any };
    const { sql: q, params } = dialect.sqlToQuery(args.where);
    expect(q).toContain('"missions"."executor" = $2');
    expect(params).toEqual(['mission-abc', 'local']);
    mockMissionsFindFirst.mockResolvedValue({ id: 'mission-abc' });
    expect(await checkMissionLocal('mission-abc')).toBe(true);
  });
});

describe('checkTaskMissionLocal', () => {
  it('returns false when the task has no mission', async () => {
    mockTasksFindFirst.mockResolvedValue({ missionId: null });
    expect(await checkTaskMissionLocal('task-1')).toBe(false);
  });

  it('returns false when the task is not found', async () => {
    mockTasksFindFirst.mockResolvedValue(null);
    expect(await checkTaskMissionLocal('task-1')).toBe(false);
  });

  it("returns false when the task's mission is not local", async () => {
    mockTasksFindFirst.mockResolvedValue({ missionId: 'mission-abc' });
    mockMissionsFindFirst.mockResolvedValue(null);
    expect(await checkTaskMissionLocal('task-1')).toBe(false);
  });

  it("returns true when the task's mission has executor='local'", async () => {
    mockTasksFindFirst.mockResolvedValue({ missionId: 'mission-abc' });
    mockMissionsFindFirst.mockResolvedValue({ id: 'mission-abc' });
    expect(await checkTaskMissionLocal('task-1')).toBe(true);
  });
});

// ─── sweeps and alerts share the claim gates (task 07132c03) ─────────────────
describe('notHeldOrLocal() — the three claim gates, conjoined', () => {
  const norm = (q: Parameters<PgDialect['sqlToQuery']>[0]) =>
    dialect.sqlToQuery(q).sql.replace(/\$\d+/g, '$?');

  it('embeds missionNotHeld, missionNotLocal and taskNotHeld verbatim', () => {
    const text = norm(notHeldOrLocal());
    for (const gate of [missionNotHeld(), missionNotLocal(), taskNotHeld()]) {
      expect(text).toContain(norm(gate));
    }
  });

  it('ANDs them: every gate must pass, not any one', () => {
    const text = norm(notHeldOrLocal());
    expect(text).toContain(`${norm(missionNotHeld())} AND ${norm(missionNotLocal())} AND ${norm(taskNotHeld())}`);
  });
});
