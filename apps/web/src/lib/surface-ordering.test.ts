/**
 * Surface merge ordering (conflict-aware-orchestration.md §3).
 *
 * Pure ordering/matching is tested directly; the guard and the merge slot are
 * tested through injected deps; every DB predicate is rendered through
 * PgDialect, because a mocked `db` would hide the WHERE scoping entirely.
 */
import { describe, it, expect, mock } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';

mock.module('@buildd/core/db', () => ({ db: { query: {} } }));

import {
  resolveSurfaceOrderingMode,
  serializedSurfaceDefs,
  resolveSerializedSurfaces,
  resolveIntentSurfaces,
  groupContenders,
  evaluateSurfaceOrder,
  guardSurfaceOrdering,
  acquireMergeSlot,
  settleSurfaceIntentsOnClose,
  openIntentsOnSurfacesWhere,
  ownOpenIntentsWhere,
  reservationTakeoverWhere,
  reservationLaneWhere,
  intentInsertIfAbsentSql,
  sameBaseLane,
  type IntentRow,
  type SurfaceOrderingDeps,
  type GuardInput,
} from './surface-ordering';
import type { WorkspaceGitConfig } from '@buildd/core/db/schema';
import type { PrScopeRead } from './pr-scope-reconcile';

const dialect = new PgDialect();
const render = (q: Parameters<PgDialect['sqlToQuery']>[0]) => dialect.sqlToQuery(q);

const MIGRATIONS = 'Drizzle migrations';
const LOCK = 'lockfile';

const CONFIG = {
  surfaceOrdering: 'enforce',
  conflictSurfaces: [
    { pattern: 'bun.lock', label: LOCK, serialize: true },
    { pattern: 'docs/**', label: 'docs' },
  ],
  sequenceNamespaces: [
    {
      dir: 'packages/core/drizzle',
      anchorFile: 'packages/core/drizzle/meta/_journal.json',
      label: MIGRATIONS,
      triggers: ['packages/core/db/schema.ts'],
      serialize: true,
    },
  ],
} as unknown as WorkspaceGitConfig;

const t0 = new Date('2026-01-01T00:00:00Z').getTime();
const at = (mins: number) => new Date(t0 + mins * 60_000);
const row = (prNumber: number | null, surface: string, mins: number, taskId: string | null = `task-${prNumber}`, baseRef: string | null = null): IntentRow => ({
  prNumber, surface, createdAt: at(mins), taskId, baseRef,
});
/** A row recorded with its base branch. */
const on = (baseRef: string, prNumber: number, surface: string, mins: number): IntentRow => row(prNumber, surface, mins, `task-${prNumber}`, baseRef);
const TRUNK = 'dev';
const MISSION_BRANCH = 'mission/abcd1234-integration';

// ── Config / matching ────────────────────────────────────────────────────────

describe('resolveSurfaceOrderingMode', () => {
  it('defaults to off', () => {
    expect(resolveSurfaceOrderingMode(null)).toBe('off');
    expect(resolveSurfaceOrderingMode({} as WorkspaceGitConfig)).toBe('off');
    expect(resolveSurfaceOrderingMode({ surfaceOrdering: 'yes' } as unknown as WorkspaceGitConfig)).toBe('off');
  });
  it('honours exact shadow/enforce', () => {
    expect(resolveSurfaceOrderingMode({ surfaceOrdering: 'shadow' } as WorkspaceGitConfig)).toBe('shadow');
    expect(resolveSurfaceOrderingMode({ surfaceOrdering: 'enforce' } as WorkspaceGitConfig)).toBe('enforce');
  });
});

describe('serialized surfaces', () => {
  it('only opted-in surfaces are serialized; warning surfaces are not', () => {
    expect(serializedSurfaceDefs(CONFIG).map((d) => d.label).sort()).toEqual([MIGRATIONS, LOCK].sort());
  });

  it('a schema-only diff touches the migration namespace (explicit trigger)', () => {
    expect(resolveSerializedSurfaces(['packages/core/db/schema.ts'], CONFIG)).toEqual([MIGRATIONS]);
  });

  it('generated artifacts count despite the regenerable-file lease exemption', () => {
    expect(resolveSerializedSurfaces(['packages/core/drizzle/meta/_journal.json'], CONFIG)).toEqual([MIGRATIONS]);
    expect(resolveSerializedSurfaces(['packages/core/drizzle/meta/0007_snapshot.json'], CONFIG)).toEqual([MIGRATIONS]);
  });

  it('distinct SQL filenames sharing an index both land on the one namespace surface', () => {
    expect(resolveSerializedSurfaces(['packages/core/drizzle/0007_alpha.sql'], CONFIG)).toEqual([MIGRATIONS]);
    expect(resolveSerializedSurfaces(['packages/core/drizzle/0007_beta.sql'], CONFIG)).toEqual([MIGRATIONS]);
  });

  it('unrelated paths match nothing', () => {
    expect(resolveSerializedSurfaces(['apps/web/src/x.ts', 'docs/a.md'], CONFIG)).toEqual([]);
  });

  it('intent surfaces include warning surfaces plus serialized namespaces', () => {
    expect(resolveIntentSurfaces(['docs/a.md', 'packages/core/db/schema.ts'], CONFIG).sort()).toEqual(['docs', MIGRATIONS].sort());
  });
});

// ── Ordering (pure) ──────────────────────────────────────────────────────────

describe('groupContenders', () => {
  it('groups every row of one PR into one contender and dedupes surfaces', () => {
    const c = groupContenders([row(5, LOCK, 3), row(5, LOCK, 4), row(5, MIGRATIONS, 1)]);
    expect(c).toHaveLength(1);
    expect(c[0].prNumber).toBe(5);
    expect(c[0].surfaces.sort()).toEqual([LOCK, MIGRATIONS].sort());
    expect(c[0].createdAt).toBe(at(1).getTime());
  });

  it('skips provisional rows with no PR (they cannot merge)', () => {
    expect(groupContenders([row(null, LOCK, 0)])).toEqual([]);
  });

  it('keeps rows with a NULL task id (the PR is still a contender)', () => {
    const c = groupContenders([row(9, LOCK, 0, null)]);
    expect(c).toHaveLength(1);
    expect(c[0].taskId).toBeNull();
  });
});

describe('evaluateSurfaceOrder', () => {
  it('a later PR waits behind the earlier one; the earlier one does not wait', () => {
    const rows = [row(10, MIGRATIONS, 0), row(11, MIGRATIONS, 5)];
    expect(evaluateSurfaceOrder(11, rows).blockers.map((b) => b.prNumber)).toEqual([10]);
    expect(evaluateSurfaceOrder(10, rows).blockers).toEqual([]);
  });

  it('never blocks on its own PR, however many rows it has', () => {
    const rows = [row(10, MIGRATIONS, 0), row(10, MIGRATIONS, 1), row(10, LOCK, 2)];
    expect(evaluateSurfaceOrder(10, rows).blockers).toEqual([]);
  });

  it('a createdAt tie breaks deterministically by PR number, never mutually', () => {
    const rows = [row(21, LOCK, 0), row(20, LOCK, 0)];
    const a = evaluateSurfaceOrder(20, rows).blockers;
    const b = evaluateSurfaceOrder(21, rows).blockers;
    expect(a).toEqual([]);
    expect(b.map((x) => x.prNumber)).toEqual([20]);
  });

  it('a cross-surface inversion cannot make both wait; it is reported', () => {
    // PR 30 is earlier on migrations, PR 31 is earlier on the lockfile.
    const rows = [row(30, MIGRATIONS, 0), row(31, MIGRATIONS, 5), row(31, LOCK, 1), row(30, LOCK, 6)];
    const r30 = evaluateSurfaceOrder(30, rows);
    const r31 = evaluateSurfaceOrder(31, rows);
    const waiting = [r30.blockers.length > 0, r31.blockers.length > 0];
    expect(waiting.filter(Boolean)).toHaveLength(1);
    expect(r30.blockers).toEqual([]);
    expect(r31.blockers.map((b) => b.prNumber)).toEqual([30]);
    expect(r31.inversions.map((i) => i.prNumber)).toEqual([30]);
  });

  it('a PR whose own rows are missing is ordered last (conservative)', () => {
    expect(evaluateSurfaceOrder(99, [row(10, LOCK, 50)]).blockers.map((b) => b.prNumber)).toEqual([10]);
  });

  it('a revision digest changes when the contender set changes', () => {
    const a = evaluateSurfaceOrder(11, [row(10, LOCK, 0), row(11, LOCK, 1)]).revision;
    const b = evaluateSurfaceOrder(11, [row(10, LOCK, 0), row(11, LOCK, 1), row(12, LOCK, 2)]).revision;
    expect(a).not.toBe(b);
  });
});

// ── SQL scoping ──────────────────────────────────────────────────────────────

describe('predicates', () => {
  it('open intents are workspace- and surface-scoped and exclude closed rows', () => {
    const q = render(openIntentsOnSurfacesWhere('ws-1', [LOCK, MIGRATIONS]));
    expect(q.sql).toContain('"change_intents"."workspace_id" = $1');
    expect(q.sql).toContain('"change_intents"."surface" in ($2, $3)');
    expect(q.sql).toContain('"change_intents"."closed_at" is null');
    expect(q.params).toEqual(['ws-1', LOCK, MIGRATIONS]);
  });

  it("own-PR intents are scoped to workspace + PR, open only", () => {
    const q = render(ownOpenIntentsWhere('ws-1', 42));
    expect(q.sql).toContain('"change_intents"."workspace_id" = $1');
    expect(q.sql).toContain('"change_intents"."pr_number" = $2');
    expect(q.sql).toContain('"change_intents"."closed_at" is null');
  });

  it('without a reconciled token only the same PR may replace a reservation', () => {
    const q = render(reservationTakeoverWhere());
    expect(q.sql).toBe('"surface_reservations"."pr_number" = excluded.pr_number');
  });

  it('an expired hold is replaced only by its exact token, still expired', () => {
    const q = render(reservationTakeoverWhere('tok-1'));
    expect(q.sql).toContain('"surface_reservations"."pr_number" = excluded.pr_number');
    expect(q.sql).toContain('"surface_reservations"."token" = $1::uuid');
    expect(q.sql).toContain('"surface_reservations"."expires_at" < now()');
    expect(q.params).toEqual(['tok-1']);
  });

  it('intent insert is one statement guarded by NOT EXISTS on (workspace, PR, surface, open)', () => {
    const q = render(intentInsertIfAbsentSql({ workspaceId: 'ws-1', surface: LOCK, taskId: null, prNumber: 7, branch: 'b', headSha: 'h' }));
    expect(q.sql).toMatch(/insert into "change_intents"/i);
    expect(q.sql).toMatch(/where not exists/i);
    expect(q.sql).toMatch(/closed_at is null/i);
    expect(q.params).toContain('ws-1');
    expect(q.params).toContain(7);
    expect(q.params).toContain(LOCK);
  });

  it('intent insert records the PR base branch', () => {
    const q = render(intentInsertIfAbsentSql({ workspaceId: 'ws-1', surface: LOCK, taskId: null, prNumber: 7, branch: 'b', headSha: 'h', baseRef: MISSION_BRANCH }));
    expect(q.sql).toMatch(/"base_ref"/);
    expect(q.params).toContain(MISSION_BRANCH);
  });

  it('a reservation lane is workspace + repo + base branch + surface', () => {
    const q = render(reservationLaneWhere('ws-1', 'acme/repo', TRUNK, MIGRATIONS));
    expect(q.sql).toMatch(/"surface_reservations"\."workspace_id" = \$\d/);
    expect(q.sql).toMatch(/"surface_reservations"\."repo_full_name" = \$\d/);
    expect(q.sql).toMatch(/"surface_reservations"\."base_ref" = \$\d/);
    expect(q.sql).toMatch(/"surface_reservations"\."surface" = \$\d/);
    expect(q.params).toEqual(['ws-1', 'acme/repo', TRUNK, MIGRATIONS]);
  });
});

// ── Base-branch lanes (a slot is "the next migration on THIS base") ───────────

describe('base-branch lanes', () => {
  it('only a recorded, different base rules a contender out', () => {
    expect(sameBaseLane(TRUNK, { baseRef: TRUNK })).toBe(true);
    expect(sameBaseLane(TRUNK, { baseRef: MISSION_BRANCH })).toBe(false);
    expect(sameBaseLane(TRUNK, { baseRef: null })).toBe(true);
    expect(sameBaseLane(null, { baseRef: MISSION_BRANCH })).toBe(true);
  });

  it('a mission PR and its own task PR on the integration branch never wait on each other', () => {
    // The mission PR (integration -> trunk) recorded its intent first, at its first green CI.
    const rows = [on(TRUNK, 50, MIGRATIONS, 0), on(MISSION_BRANCH, 51, MIGRATIONS, 5)];
    expect(evaluateSurfaceOrder(51, rows).blockers).toEqual([]);
    expect(evaluateSurfaceOrder(50, rows).blockers).toEqual([]);
    // ...and with the task PR first, the mission PR still does not wait on it.
    const flipped = [on(MISSION_BRANCH, 51, MIGRATIONS, 0), on(TRUNK, 50, MIGRATIONS, 5)];
    expect(evaluateSurfaceOrder(50, flipped).blockers).toEqual([]);
  });

  it('a trunk PR does not wait behind a PR that only targets a mission branch', () => {
    const rows = [on(MISSION_BRANCH, 51, MIGRATIONS, 0), on(TRUNK, 60, MIGRATIONS, 5)];
    expect(evaluateSurfaceOrder(60, rows).blockers).toEqual([]);
  });

  it('the mission PR going to trunk still serializes against other trunk PRs', () => {
    const rows = [on(TRUNK, 50, MIGRATIONS, 0), on(MISSION_BRANCH, 51, MIGRATIONS, 1), on(TRUNK, 60, MIGRATIONS, 5)];
    expect(evaluateSurfaceOrder(60, rows).blockers.map((b) => b.prNumber)).toEqual([50]);
    expect(evaluateSurfaceOrder(50, rows).blockers).toEqual([]);
  });

  it('two task PRs on the same mission branch serialize with each other', () => {
    const rows = [on(MISSION_BRANCH, 51, MIGRATIONS, 0), on(MISSION_BRANCH, 52, MIGRATIONS, 5), on(TRUNK, 50, MIGRATIONS, 1)];
    expect(evaluateSurfaceOrder(52, rows).blockers.map((b) => b.prNumber)).toEqual([51]);
  });

  it('a contender with no recorded base still counts (conservative)', () => {
    const rows = [row(10, MIGRATIONS, 0), on(TRUNK, 11, MIGRATIONS, 5)];
    expect(evaluateSurfaceOrder(11, rows).blockers.map((b) => b.prNumber)).toEqual([10]);
  });

  it('guard: mission PR vs own task PR — the task PR merges, and so does the mission PR', async () => {
    const rows = [on(TRUNK, 50, MIGRATIONS, 0), on(MISSION_BRANCH, 51, MIGRATIONS, 5)];
    const task = harness({}, { rows, scope: { status: 'complete', files: ['packages/core/db/schema.ts'], headSha: 'h51', baseSha: 'b', baseRef: MISSION_BRANCH } });
    const tv = await guardSurfaceOrdering(input({ prNumber: 51, headSha: 'h51' }), task.deps);
    expect(tv.blocks).toBe(false);
    if (tv.blocks) throw new Error('unreachable');
    expect(tv.slot?.baseRef).toBe(MISSION_BRANCH);

    const mission = harness({}, { rows, scope: { status: 'complete', files: ['packages/core/db/schema.ts'], headSha: 'h50', baseSha: 'b', baseRef: TRUNK } });
    expect((await guardSurfaceOrdering(input({ prNumber: 50, headSha: 'h50' }), mission.deps)).blocks).toBe(false);
  });

  it('guard: a trunk PR does not wait behind a mission-branch-only PR', async () => {
    const h = harness({}, { rows: [on(MISSION_BRANCH, 51, MIGRATIONS, 0), on(TRUNK, 11, MIGRATIONS, 5)] });
    expect((await guardSurfaceOrdering(input(), h.deps)).blocks).toBe(false);
  });

  it('guard: an unrecorded-base blocker that GitHub says lands elsewhere is dropped, stamped, and ignored by the recheck', async () => {
    const h = harness({}, { rows: [row(51, MIGRATIONS, 0), on(TRUNK, 11, MIGRATIONS, 5)], prBases: { 51: MISSION_BRANCH } });
    const v = await guardSurfaceOrdering(input(), h.deps);
    expect(v.blocks).toBe(false);
    if (v.blocks) throw new Error('unreachable');
    expect(h.stamped).toEqual([{ prNumber: 51, baseRef: MISSION_BRANCH }]);
    expect(v.slot?.ignorePrs).toEqual([51]);
  });

  it('guard: an unrecorded-base blocker on the same base still defers', async () => {
    const h = harness({}, { rows: [row(10, MIGRATIONS, 0), on(TRUNK, 11, MIGRATIONS, 5)], prBases: { 10: TRUNK } });
    const v = await guardSurfaceOrdering(input(), h.deps);
    expect(v.blocks).toBe(true);
    expect(h.stamped).toEqual([]);
  });

  it('guard: without a base ref from GitHub, enforce defers as unverified', async () => {
    const h = harness({}, { scope: { status: 'complete', files: ['packages/core/db/schema.ts'], headSha: 'head-1', baseSha: 'base-1' } });
    const v = await guardSurfaceOrdering(input(), h.deps);
    expect(v.blocks).toBe(true);
    if (!v.blocks) throw new Error('unreachable');
    expect(v.kind).toBe('unverified');
  });

  it('slot: the same surface on two bases is two lanes — both reserve', async () => {
    const store = slotStore();
    const h = harness({ ...store, loadOpenIntents: async () => [on(TRUNK, 50, MIGRATIONS, 0), on(MISSION_BRANCH, 51, MIGRATIONS, 5)] });
    const [a, b] = await Promise.all([
      acquireMergeSlot(slotReq(50, [MIGRATIONS], TRUNK), h.deps),
      acquireMergeSlot(slotReq(51, [MIGRATIONS], MISSION_BRANCH), h.deps),
    ]);
    expect([a.ok, b.ok]).toEqual([true, true]);
  });

  it('slot recheck: a PR the guard verified on another base does not refuse the slot', async () => {
    const store = slotStore();
    const h = harness({ ...store, loadOpenIntents: async () => [row(51, MIGRATIONS, 0), on(TRUNK, 11, MIGRATIONS, 5)] });
    expect((await acquireMergeSlot(slotReq(11, [MIGRATIONS], TRUNK, [51]), h.deps)).ok).toBe(true);
    const store2 = slotStore();
    const h2 = harness({ ...store2, loadOpenIntents: async () => [row(51, MIGRATIONS, 0), on(TRUNK, 11, MIGRATIONS, 5)] });
    expect((await acquireMergeSlot(slotReq(11, [MIGRATIONS], TRUNK, []), h2.deps)).ok).toBe(false);
  });

  it('settle: closing a trunk PR wakes the next trunk contender, not a mission-branch PR ahead of it', async () => {
    const woke: number[] = [];
    await settleSurfaceIntentsOnClose({ workspaceId: 'ws-1', prNumber: 10 }, {
      loadOwnOpenSurfaces: async () => ({ surfaces: [MIGRATIONS], baseRef: TRUNK }),
      closeIntents: async () => {},
      releaseReservations: async () => {},
      loadOpenIntents: async () => [on(MISSION_BRANCH, 51, MIGRATIONS, 1), on(TRUNK, 12, MIGRATIONS, 3)],
      loadGitConfig: async () => CONFIG,
      redrive: async (_ws: string, n: number) => { woke.push(n); },
    });
    expect(woke).toEqual([12]);
  });

  it('settle: with the closed PR\'s base unknown, the head of every lane is woken', async () => {
    const woke: number[] = [];
    await settleSurfaceIntentsOnClose({ workspaceId: 'ws-1', prNumber: 10 }, {
      loadOwnOpenSurfaces: async () => ({ surfaces: [MIGRATIONS], baseRef: null }),
      closeIntents: async () => {},
      releaseReservations: async () => {},
      loadOpenIntents: async () => [on(MISSION_BRANCH, 51, MIGRATIONS, 1), on(MISSION_BRANCH, 52, MIGRATIONS, 2), on(TRUNK, 12, MIGRATIONS, 3)],
      loadGitConfig: async () => CONFIG,
      redrive: async (_ws: string, n: number) => { woke.push(n); },
    });
    expect(woke.sort((a, b) => a - b)).toEqual([12, 51]);
  });
});

// ── Guard ────────────────────────────────────────────────────────────────────

type Rec = { gate: string; outcome: string; reason: string; detail?: Record<string, unknown> };

function harness(
  over: Partial<SurfaceOrderingDeps> = {},
  state: { rows?: IntentRow[]; scope?: PrScopeRead; prStates?: Record<number, 'open' | 'merged' | 'closed' | 'error'>; prBases?: Record<number, string> } = {},
) {
  const recorded: Rec[] = [];
  const settled: number[] = [];
  const stamped: Array<{ prNumber: number; baseRef: string }> = [];
  const reconciled: Array<{ prNumber: number; surfaces: string[]; baseRef?: string | null }> = [];
  let rows = state.rows ?? [];
  const deps: SurfaceOrderingDeps = {
    readScope: async () => state.scope ?? { status: 'complete', files: ['packages/core/db/schema.ts'], headSha: 'head-1', baseSha: 'base-1', baseRef: TRUNK },
    reconcileOwnIntents: async (i) => {
      reconciled.push({ prNumber: i.prNumber, surfaces: i.actualSurfaces, baseRef: i.baseRef });
      if (!rows.some((r) => r.prNumber === i.prNumber)) {
        rows = [...rows, ...i.actualSurfaces.map((s) => row(i.prNumber, s, 1000, `task-${i.prNumber}`, i.baseRef))];
      }
    },
    loadOpenIntents: async () => rows,
    readPrState: async (_repo, n) => {
      const s = state.prStates?.[n] ?? 'open';
      if (s === 'error') throw new Error('GitHub 502');
      return { state: s, baseRef: state.prBases?.[n] ?? TRUNK };
    },
    stampBaseRef: async (_ws, prNumber, baseRef) => { stamped.push({ prNumber, baseRef }); },
    settleClosedPr: async (_ws, n) => {
      settled.push(n);
      rows = rows.filter((r) => r.prNumber !== n);
    },
    record: (e) => recorded.push(e as Rec),
    ...over,
  };
  return { deps, recorded, settled, reconciled, stamped, setRows: (r: IntentRow[]) => (rows = r) };
}

const input = (over: Partial<GuardInput> = {}): GuardInput => ({
  workspaceId: 'ws-1',
  installationId: 1,
  repoFullName: 'acme/repo',
  prNumber: 11,
  headSha: 'head-1',
  gitConfig: CONFIG,
  taskId: 'task-11',
  workerId: 'w-11',
  door: 'auto-merge',
  callerOrigin: 'system',
  ...over,
});

describe('guardSurfaceOrdering', () => {
  it('default policy is a no-op: no reads, no ledger, no reconcile', async () => {
    let touched = 0;
    const spy = async () => { touched++; throw new Error('must not be called'); };
    const deps = { readScope: spy, reconcileOwnIntents: spy, loadOpenIntents: spy, readPrState: spy, settleClosedPr: spy, record: () => { touched++; } } as unknown as SurfaceOrderingDeps;
    const v1 = await guardSurfaceOrdering(input({ gitConfig: null }), deps);
    const v2 = await guardSurfaceOrdering(input({ gitConfig: { conflictSurfaces: [{ pattern: 'bun.lock', label: LOCK, serialize: true }] } as unknown as WorkspaceGitConfig }), deps);
    const v3 = await guardSurfaceOrdering(input({ gitConfig: { surfaceOrdering: 'enforce', conflictSurfaces: [{ pattern: 'bun.lock', label: LOCK }] } as unknown as WorkspaceGitConfig }), deps);
    expect([v1.blocks, v2.blocks, v3.blocks]).toEqual([false, false, false]);
    expect(touched).toBe(0);
  });

  it('defers a later PR behind an earlier open PR, ledgered with counterpart, head and base', async () => {
    const h = harness({}, { rows: [row(10, MIGRATIONS, 0), row(11, MIGRATIONS, 5)] });
    const v = await guardSurfaceOrdering(input(), h.deps);
    expect(v.blocks).toBe(true);
    if (!v.blocks) throw new Error('unreachable');
    expect(v.kind).toBe('ordering');
    expect(v.counterpartPrNumber).toBe(10);
    expect(v.surface).toBe(MIGRATIONS);
    const r = h.recorded.find((e) => e.gate === 'surface_ordering')!;
    expect(r.outcome).toBe('deferred');
    expect(r.detail).toMatchObject({ kind: 'ordering', surface: MIGRATIONS, counterpartPrNumber: 10, headSha: 'head-1', baseSha: 'base-1', prNumber: 11 });
  });

  it('refreshes this PR\'s surfaces from the actual diff (schema-only diff => migrations)', async () => {
    const h = harness({}, { rows: [] });
    const v = await guardSurfaceOrdering(input(), h.deps);
    expect(v.blocks).toBe(false);
    expect(h.reconciled).toEqual([{ prNumber: 11, surfaces: [MIGRATIONS], baseRef: TRUNK }]);
    if (v.blocks) throw new Error('unreachable');
    expect(v.slot?.surfaces).toEqual([MIGRATIONS]);
    expect(v.slot?.headSha).toBe('head-1');
    expect(v.slot?.baseSha).toBe('base-1');
  });

  it('the earliest PR passes and gets a slot request', async () => {
    const h = harness({}, { rows: [row(11, MIGRATIONS, 0), row(12, MIGRATIONS, 5)] });
    const v = await guardSurfaceOrdering(input(), h.deps);
    expect(v.blocks).toBe(false);
  });

  it('a missed close is reconciled: a blocker GitHub says merged is settled and no longer blocks', async () => {
    const h = harness({}, { rows: [row(10, MIGRATIONS, 0), row(11, MIGRATIONS, 5)], prStates: { 10: 'merged' } });
    const v = await guardSurfaceOrdering(input(), h.deps);
    expect(v.blocks).toBe(false);
    expect(h.settled).toEqual([10]);
  });

  it('a superseded (closed unmerged) blocker is settled the same way', async () => {
    const h = harness({}, { rows: [row(10, MIGRATIONS, 0), row(11, MIGRATIONS, 5)], prStates: { 10: 'closed' } });
    expect((await guardSurfaceOrdering(input(), h.deps)).blocks).toBe(false);
    expect(h.settled).toEqual([10]);
  });

  it('a blocker whose state cannot be read defers (fail closed in enforce)', async () => {
    const h = harness({}, { rows: [row(10, MIGRATIONS, 0), row(11, MIGRATIONS, 5)], prStates: { 10: 'error' } });
    const v = await guardSurfaceOrdering(input(), h.deps);
    expect(v.blocks).toBe(true);
    if (!v.blocks) throw new Error('unreachable');
    expect(v.kind).toBe('unverified');
  });

  it('an intent read failure defers in enforce', async () => {
    const h = harness({ loadOpenIntents: async () => { throw new Error('db down'); } });
    const v = await guardSurfaceOrdering(input(), h.deps);
    expect(v.blocks).toBe(true);
    if (!v.blocks) throw new Error('unreachable');
    expect(v.kind).toBe('unverified');
    expect(h.recorded.at(-1)?.detail).toMatchObject({ kind: 'unverified' });
  });

  it('an incomplete diff read defers in enforce and never reads as an empty diff', async () => {
    const h = harness({}, { scope: { status: 'incomplete', reason: 'truncated', detail: 'cap', headSha: 'head-1', baseSha: 'base-1' } });
    const v = await guardSurfaceOrdering(input(), h.deps);
    expect(v.blocks).toBe(true);
    expect(h.reconciled).toEqual([]);
  });

  it('a closed PR is not this gate\'s business', async () => {
    const h = harness({}, { scope: { status: 'closed', merged: true, headSha: 'h', baseSha: 'b' } });
    expect((await guardSurfaceOrdering(input(), h.deps)).blocks).toBe(false);
  });

  it('shadow records a would-defer as warned and does not block', async () => {
    const h = harness({}, { rows: [row(10, MIGRATIONS, 0), row(11, MIGRATIONS, 5)] });
    const v = await guardSurfaceOrdering(input({ gitConfig: { ...CONFIG, surfaceOrdering: 'shadow' } as WorkspaceGitConfig }), h.deps);
    expect(v.blocks).toBe(false);
    if (v.blocks) throw new Error('unreachable');
    expect(v.slot).toBeNull();
    const r = h.recorded.find((e) => e.gate === 'surface_ordering')!;
    expect(r.outcome).toBe('warned');
    expect(r.detail).toMatchObject({ shadow: true, kind: 'ordering' });
  });

  it('observeOnly computes the answer without writing intents, settling or ledgering', async () => {
    const h = harness({}, { rows: [row(10, MIGRATIONS, 0), row(11, MIGRATIONS, 5)] });
    const v = await guardSurfaceOrdering(input({ observeOnly: true }), h.deps);
    expect(v.blocks).toBe(true);
    expect(h.reconciled).toEqual([]);
    expect(h.settled).toEqual([]);
    expect(h.recorded).toEqual([]);
  });

  it('an explicit override proceeds but is ledgered as bypassed', async () => {
    const h = harness({}, { rows: [row(10, MIGRATIONS, 0), row(11, MIGRATIONS, 5)] });
    const v = await guardSurfaceOrdering(input({ override: true }), h.deps);
    expect(v.blocks).toBe(false);
    expect(h.recorded.find((e) => e.gate === 'surface_ordering')?.outcome).toBe('bypassed');
  });

  it('a cross-surface inversion is reported as a distinct warned row', async () => {
    const h = harness({}, {
      scope: { status: 'complete', files: ['packages/core/db/schema.ts', 'bun.lock'], headSha: 'head-1', baseSha: 'base-1', baseRef: TRUNK },
      rows: [row(10, MIGRATIONS, 0), row(11, MIGRATIONS, 5), row(11, LOCK, 1), row(10, LOCK, 6)],
    });
    const v = await guardSurfaceOrdering(input(), h.deps);
    expect(v.blocks).toBe(true);
    expect(h.recorded.some((e) => e.outcome === 'warned' && e.detail?.kind === 'cross_surface_cycle')).toBe(true);
  });
});

// ── Merge slot (reservation CAS) ─────────────────────────────────────────────

function slotStore() {
  // A faithful in-memory model of the single-statement CAS: a row is taken only
  // when absent, already this PR's, or (with a reconciled token) that exact
  // expired hold.
  // Keyed like the unique index: (base branch, surface) within one workspace + repo.
  const rows = new Map<string, { prNumber: number; token: string; expiresAt: number; headSha: string }>();
  const key = (baseRef: string, surface: string) => `${baseRef}|${surface}`;
  let n = 0;
  return {
    rows,
    has: (surface: string, baseRef = TRUNK) => rows.has(key(baseRef, surface)),
    tryReserve: async (r: { baseRef: string; surface: string; prNumber: number; headSha: string; ttlMs: number; now: number; takeoverToken?: string | null }) => {
      const cur = rows.get(key(r.baseRef, r.surface));
      const takeover = cur && r.takeoverToken && cur.token === r.takeoverToken && cur.expiresAt < r.now;
      if (cur && cur.prNumber !== r.prNumber && !takeover) {
        return { acquired: false as const, holder: { prNumber: cur.prNumber, expiresAt: new Date(cur.expiresAt), token: cur.token } };
      }
      const token = `tok-${++n}`;
      rows.set(key(r.baseRef, r.surface), { prNumber: r.prNumber, token, expiresAt: r.now + r.ttlMs, headSha: r.headSha });
      return { acquired: true as const, token };
    },
    readHolder: async (_ws: string, _repo: string, baseRef: string, surface: string) => {
      const cur = rows.get(key(baseRef, surface));
      return cur ? { prNumber: cur.prNumber, expiresAt: new Date(cur.expiresAt), token: cur.token } : null;
    },
    releaseToken: async (_ws: string, _repo: string, baseRef: string, surface: string, token: string) => {
      if (rows.get(key(baseRef, surface))?.token === token) rows.delete(key(baseRef, surface));
    },
  };
}

const slotReq = (prNumber: number, surfaces = [MIGRATIONS], baseRef = TRUNK, ignorePrs: number[] = []) => ({
  workspaceId: 'ws-1', repoFullName: 'acme/repo', installationId: 1, prNumber, headSha: `head-${prNumber}`, baseSha: 'base-1',
  baseRef, ignorePrs, surfaces, revision: 'rev', taskId: null, workerId: null, door: 'auto-merge', callerOrigin: 'system' as const, gitConfig: CONFIG,
});

describe('acquireMergeSlot', () => {
  it('of two parallel attempts on one surface exactly one reserves', async () => {
    const store = slotStore();
    const h = harness({ ...store, loadOpenIntents: async () => [row(1, MIGRATIONS, 0), row(2, MIGRATIONS, 0)] });
    const [a, b] = await Promise.all([acquireMergeSlot(slotReq(1), h.deps), acquireMergeSlot(slotReq(2), h.deps)]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
  });

  it('a reservation held by a live other PR refuses; the recheck after reserve also defers a newly earlier contender', async () => {
    const store = slotStore();
    const h = harness({ ...store, loadOpenIntents: async () => [row(1, MIGRATIONS, 0)] });
    const first = await acquireMergeSlot(slotReq(1), h.deps);
    expect(first.ok).toBe(true);
    const second = await acquireMergeSlot(slotReq(2), h.deps);
    expect(second.ok).toBe(false);

    // Recheck: PR 3 reserves, but an earlier contender appeared meanwhile.
    const store2 = slotStore();
    const h2 = harness({ ...store2, loadOpenIntents: async () => [row(2, MIGRATIONS, 0), row(3, MIGRATIONS, 5)] });
    const third = await acquireMergeSlot(slotReq(3), h2.deps);
    expect(third.ok).toBe(false);
    expect(store2.rows.size).toBe(0); // released on the failed recheck
  });

  it('release frees the surface for the next PR', async () => {
    const store = slotStore();
    const h = harness({ ...store, loadOpenIntents: async () => [] });
    const a = await acquireMergeSlot(slotReq(1), h.deps);
    if (!a.ok) throw new Error('expected slot');
    await a.release();
    expect((await acquireMergeSlot(slotReq(2), h.deps)).ok).toBe(true);
  });

  it('an expired holder is reconciled against GitHub before reuse: merged holder is settled', async () => {
    const store = slotStore();
    let now = 0;
    const h = harness({ ...store, loadOpenIntents: async () => [], now: () => now }, { prStates: { 1: 'merged' } });
    expect((await acquireMergeSlot(slotReq(1), h.deps)).ok).toBe(true); // never released (door died)
    now = 60 * 60_000;
    expect((await acquireMergeSlot(slotReq(2), h.deps)).ok).toBe(true);
    expect(h.settled).toEqual([1]);
  });

  it('two reconcilers of one expired hold: exactly one takes it over', async () => {
    const store = slotStore();
    let now = 0;
    const h = harness({ ...store, loadOpenIntents: async () => [], now: () => now }, { prStates: { 1: 'open' } });
    await acquireMergeSlot(slotReq(1), h.deps);
    now = 60 * 60_000;
    const [a, b] = await Promise.all([acquireMergeSlot(slotReq(2), h.deps), acquireMergeSlot(slotReq(3), h.deps)]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
  });

  it('an expired holder whose state cannot be read is not reused', async () => {
    const store = slotStore();
    let now = 0;
    const h = harness({ ...store, loadOpenIntents: async () => [], now: () => now }, { prStates: { 1: 'error' } });
    await acquireMergeSlot(slotReq(1), h.deps);
    now = 60 * 60_000;
    expect((await acquireMergeSlot(slotReq(2), h.deps)).ok).toBe(false);
  });

  it('a successful reservation is ledgered as accepted (the denominator)', async () => {
    const store = slotStore();
    const h = harness({ ...store, loadOpenIntents: async () => [] });
    await acquireMergeSlot(slotReq(1), h.deps);
    expect(h.recorded.some((e) => e.gate === 'surface_ordering' && e.outcome === 'accepted')).toBe(true);
  });

  it('multi-surface: a refusal on the second surface releases the first', async () => {
    const store = slotStore();
    const h = harness({ ...store, loadOpenIntents: async () => [] });
    await acquireMergeSlot(slotReq(9, [MIGRATIONS]), h.deps);
    const r = await acquireMergeSlot(slotReq(2, [LOCK, MIGRATIONS]), h.deps);
    expect(r.ok).toBe(false);
    expect(store.has(LOCK)).toBe(false);
  });
});

// ── Closure-driven wakeup ────────────────────────────────────────────────────

describe('settleSurfaceIntentsOnClose', () => {
  it('closes the PR\'s intents and wakes the next contender on each surface it held, once each', async () => {
    const woke: number[] = [];
    let closed: number | null = null;
    const deps = {
      loadOwnOpenSurfaces: async () => ({ surfaces: [MIGRATIONS, LOCK], baseRef: null }),
      closeIntents: async (_ws: string, n: number) => { closed = n; },
      releaseReservations: async () => {},
      loadOpenIntents: async () => [row(11, MIGRATIONS, 5), row(12, MIGRATIONS, 9), row(11, LOCK, 6), row(13, LOCK, 7)],
      loadGitConfig: async () => CONFIG,
      redrive: async (_ws: string, n: number) => { woke.push(n); },
    };
    await settleSurfaceIntentsOnClose({ workspaceId: 'ws-1', prNumber: 10 }, deps);
    expect(closed).toBe(10);
    expect(woke.sort()).toEqual([11]);
  });

  it('with ordering off it still closes intents and wakes nobody', async () => {
    const woke: number[] = [];
    let closed = false;
    await settleSurfaceIntentsOnClose({ workspaceId: 'ws-1', prNumber: 10 }, {
      loadOwnOpenSurfaces: async () => ({ surfaces: [MIGRATIONS], baseRef: TRUNK }),
      closeIntents: async () => { closed = true; },
      releaseReservations: async () => {},
      loadOpenIntents: async () => [row(11, MIGRATIONS, 5)],
      loadGitConfig: async () => ({}) as WorkspaceGitConfig,
      redrive: async (_ws: string, n: number) => { woke.push(n); },
    });
    expect(closed).toBe(true);
    expect(woke).toEqual([]);
  });

  it('a wake failure never throws', async () => {
    await settleSurfaceIntentsOnClose({ workspaceId: 'ws-1', prNumber: 10 }, {
      loadOwnOpenSurfaces: async () => ({ surfaces: [MIGRATIONS], baseRef: TRUNK }),
      closeIntents: async () => {},
      releaseReservations: async () => {},
      loadOpenIntents: async () => [row(11, MIGRATIONS, 5)],
      loadGitConfig: async () => CONFIG,
      redrive: async () => { throw new Error('boom'); },
    });
  });
});

// ── Backstop retained: distinct SQL filenames sharing an index refuse merge ──
import { classifyPullRequestMigrations } from './migration-safety';

describe('migration collision backstop (kept alongside namespace ordering)', () => {
  it('two distinct filenames with the same index still refuse the later PR', () => {
    const verdict = classifyPullRequestMigrations(
      [{ filename: 'packages/core/drizzle/0007_beta.sql', content: 'CREATE INDEX "t_c_idx" ON "t" ("c");' }],
      [{ path: 'packages/core/drizzle/0007_alpha.sql', prNumber: 5 }],
      9,
    );
    expect(verdict.safe).toBe(false);
    if (verdict.safe) throw new Error('unreachable');
    expect(verdict.collision).toMatchObject({ file: '0007_beta.sql', otherFile: '0007_alpha.sql', otherPrNumber: 5 });
  });
});
