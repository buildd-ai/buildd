import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { PgDialect, QueryBuilder } from 'drizzle-orm/pg-core';
import { tasks } from '@buildd/core/db/schema';
import { sql, type SQL } from 'drizzle-orm';

/**
 * Why an explicitly requested task (claim with `taskId`) came back unclaimed.
 *
 * The claim query folds every gate into one WHERE, so an excluded task simply
 * isn't returned and the route used to answer `no_pending_tasks` — the same
 * reason as an empty queue. For an interactive caller who named the task, that
 * reads as "the task doesn't exist or is done" (friction task 81962c2f).
 *
 * The probe re-evaluates the route's own gate predicates as boolean columns for
 * that one row, so the reason cannot drift from what the claim query enforced.
 * Scoping is the part a mocked db hides, so the WHERE is rendered and asserted.
 */

let selectCalls: Array<{ fields: Record<string, unknown>; where: SQL | undefined }> = [];
let selectResult: any[] = [];
/** Per-call results, consumed in order; falls back to selectResult when empty. */
let selectQueue: any[][] = [];
let selectThrows = false;
/** 1-based select call number that throws, or null. */
let selectThrowOnCall: number | null = null;
let updateCalls: Array<{ set: any; where: SQL | undefined }> = [];

mock.module('@buildd/core/db', () => ({
  db: {
    select: (fields: Record<string, unknown>) => {
      const call = { fields, where: undefined as SQL | undefined };
      selectCalls.push(call);
      const chain: any = {
        from: () => chain,
        where: (w: SQL) => { call.where = w; return chain; },
        limit: async () => {
          if (selectThrows || selectCalls.length === selectThrowOnCall) throw new Error('db down');
          return selectQueue.length > 0 ? selectQueue.shift()! : selectResult;
        },
      };
      return chain;
    },
    update: () => {
      const call = { set: undefined as any, where: undefined as SQL | undefined };
      updateCalls.push(call);
      return {
        set: (v: any) => {
          call.set = v;
          return { where: async (w: SQL) => { call.where = w; } };
        },
      };
    },
  },
}));

import {
  classifyExplicitTaskExclusion,
  describeBlockingDependencies,
  diagnoseExplicitTaskExclusion,
  evaluateForcedGates,
  explicitTaskScope,
  explicitExclusionGateEvent,
  stampLastClaimAttempt,
  type ExplicitTaskProbe,
} from './explicit-task-exclusion';

const dialect = new PgDialect();
const render = (s: SQL) => dialect.sqlToQuery(s);

const NOW = new Date('2026-09-27T12:00:00Z');

function probe(overrides: Partial<ExplicitTaskProbe> = {}): ExplicitTaskProbe {
  return {
    status: 'pending',
    claimedBy: null,
    expiresAt: null,
    startAt: null,
    gates: {},
    ...overrides,
  };
}

describe('classifyExplicitTaskExclusion', () => {
  it('no row in the claimable workspaces → not_found', () => {
    expect(classifyExplicitTaskExclusion(null, NOW).code).toBe('not_found');
  });

  it('a non-pending task names its status', () => {
    const r = classifyExplicitTaskExclusion(probe({ status: 'completed' }), NOW);
    expect(r.code).toBe('not_pending');
    expect(r.detail).toContain('completed');
  });

  it('a claim with no expiry → already_claimed (the query only lets an EXPIRED claim through)', () => {
    expect(classifyExplicitTaskExclusion(probe({ claimedBy: 'acct', expiresAt: null }), NOW).code).toBe('already_claimed');
  });

  it('an unexpired claim → already_claimed; an expired one is not', () => {
    const future = new Date(NOW.getTime() + 60_000);
    const past = new Date(NOW.getTime() - 60_000);
    expect(classifyExplicitTaskExclusion(probe({ claimedBy: 'acct', expiresAt: future }), NOW).code).toBe('already_claimed');
    expect(classifyExplicitTaskExclusion(probe({ claimedBy: 'acct', expiresAt: past }), NOW).code).not.toBe('already_claimed');
  });

  it('a future startAt → deferred with the timestamp', () => {
    const r = classifyExplicitTaskExclusion(probe({ startAt: new Date('2026-09-28T00:00:00Z') }), NOW);
    expect(r.code).toBe('deferred');
    expect(r.detail).toContain('2026-09-28T00:00:00.000Z');
  });

  it('a held mission → mission_held, and points at the override', () => {
    const r = classifyExplicitTaskExclusion(probe({ gates: { missionHeld: false } }), NOW);
    expect(r.code).toBe('mission_held');
    expect(r.detail).toMatch(/Start with override/);
    expect(r.detail).toMatch(/Arm the mission/);
  });

  it('each failing gate maps to its own code', () => {
    const cases: Array<[keyof ExplicitTaskProbe['gates'], string]> = [
      ['activeWorker', 'active_worker'],
      ['taskHeld', 'task_held'],
      ['missionHeld', 'mission_held'],
      ['missionLocal', 'mission_local'],
      ['deps', 'deps_blocked'],
      ['subject', 'subject_dead'],
      ['runnerPreference', 'runner_preference'],
      ['role', 'role_mismatch'],
      ['runnerCooldown', 'runner_cooldown'],
      ['workspaceCap', 'workspace_cap'],
      ['workspaceExecutor', 'workspace_executor'],
      ['workspacePaused', 'workspace_paused'],
    ];
    for (const [gate, code] of cases) {
      expect(classifyExplicitTaskExclusion(probe({ gates: { [gate]: false } }), NOW).code).toBe(code as any);
    }
  });

  it('a local-executor mission → mission_local, naming the local session and how to claim', () => {
    const r = classifyExplicitTaskExclusion(probe({ gates: { missionLocal: false } }), NOW);
    expect(r.code).toBe('mission_local');
    expect(r.detail).toContain('This mission runs in a local session');
    expect(r.detail).toContain('claim_task {taskId}');
    expect(r.detail).toMatch(/Start with override/);
  });

  it('a workspace whose work runs elsewhere → workspace_executor, naming the setting and the override', () => {
    const r = classifyExplicitTaskExclusion(probe({ gates: { workspaceExecutor: false } }), NOW);
    expect(r.code).toBe('workspace_executor');
    expect(r.detail).toContain('gitConfig.executor');
    expect(r.detail).toContain('force: true');
  });

  it('a workspace pausing new starts → workspace_paused, saying it resumes on its own and where to resume it', () => {
    const r = classifyExplicitTaskExclusion(probe({ gates: { workspacePaused: false } }), NOW);
    expect(r.code).toBe('workspace_paused');
    expect(r.detail).toContain('paused new starts');
    expect(r.detail).toContain('Health');
  });

  it('a workspace pause with a known end says until when', () => {
    const r = classifyExplicitTaskExclusion(
      probe({ gates: { workspacePaused: false }, workspacePausedUntil: new Date(NOW.getTime() + 2 * 60 * 60 * 1000) }),
      NOW,
    );
    expect(r.code).toBe('workspace_paused');
    expect(r.detail).toContain(`New starts in this workspace are paused until ${new Date(NOW.getTime() + 2 * 60 * 60 * 1000).toISOString()}.`);
    expect(r.detail).toContain('Health');
  });

  it('a held mission outranks the local executor (held is the pause)', () => {
    expect(classifyExplicitTaskExclusion(probe({ gates: { missionHeld: false, missionLocal: false } }), NOW).code).toBe('mission_held');
  });

  it('a person hold outranks the mission hold (resume is the fix, not arming)', () => {
    expect(classifyExplicitTaskExclusion(probe({ gates: { taskHeld: false, missionHeld: false } }), NOW).code).toBe('task_held');
  });

  // Friction cad81659: the fallback said "Excluded by a claim filter this
  // diagnosis does not cover." With the probe two-valued, every WHERE condition
  // is classified, so passing all of them means the row changed underneath.
  it('every gate passing → state_changed, and names that as the reason', () => {
    const r = classifyExplicitTaskExclusion(probe({ gates: { missionHeld: true, deps: true } }), NOW);
    expect(r.code).toBe('state_changed');
    expect(r.detail).not.toMatch(/does not cover/);
    expect(r.detail).toMatch(/retry/i);
  });

  it('a NULL gate is a failed gate (the claim WHERE excludes NULL exactly like FALSE)', () => {
    const r = classifyExplicitTaskExclusion(probe({ gates: { deps: null as any } }), NOW);
    expect(r.code).toBe('deps_blocked');
  });

  it('the overridable gates point at force: true on claim_task', () => {
    for (const gate of ['missionHeld', 'deps', 'subject', 'workspaceCap'] as const) {
      expect(classifyExplicitTaskExclusion(probe({ gates: { [gate]: false } }), NOW).detail).toContain('force: true');
    }
    expect(classifyExplicitTaskExclusion(probe({ startAt: new Date(NOW.getTime() + 60_000) }), NOW).detail).toContain('force: true');
  });
});

describe('evaluateForcedGates (force-claim audit)', () => {
  beforeEach(() => { selectCalls = []; selectQueue = []; selectResult = []; selectThrows = false; selectThrowOnCall = null; });

  it('returns the codes of the lifted gates that would have excluded the task', async () => {
    selectResult = [{ g_deps: false, g_missionHeld: true, g_subject: null, g_workspaceCap: true, g_startAt: 'f' }];
    const codes = await evaluateForcedGates({
      taskId: 'task-1', workspaceIds: ['ws-a'],
      gates: { deps: sql`a`, missionHeld: sql`b`, subject: sql`c`, workspaceCap: sql`d`, startAt: sql`e` },
    });
    expect(codes.sort()).toEqual(['deferred', 'deps_blocked', 'subject_dead']);
    expect(render(selectCalls[0].fields.g_deps as SQL).sql).toBe('COALESCE((a), false)');
    expect(render(selectCalls[0].where!).params).toEqual(['task-1', 'ws-a']);
  });

  it('never throws; an audit failure records nothing rather than blocking', async () => {
    selectThrows = true;
    expect(await evaluateForcedGates({ taskId: 't', workspaceIds: ['w'], gates: { deps: sql`a`, missionHeld: sql`b`, subject: sql`c`, workspaceCap: sql`d`, startAt: sql`e` } })).toEqual([]);
  });
});

describe('describeBlockingDependencies', () => {
  it('names a missing dependency', () => {
    const d = describeBlockingDependencies(null, ['gone-1234-5678'], []);
    expect(d).toContain('gone-123');
    expect(d).toMatch(/not found/);
  });

  it('only calls an edge inferred when both manifests declare overlapping concrete paths', () => {
    const inferred = describeBlockingDependencies(['a.ts'], ['d1'], [
      { id: 'd1', title: 'T', status: 'in_progress', pathManifest: ['a.ts'], satisfied: false, openPrNumber: null },
    ]);
    expect(inferred).toMatch(/pathManifest/);
    const declared = describeBlockingDependencies(['a.ts'], ['d1'], [
      { id: 'd1', title: 'T', status: 'in_progress', pathManifest: ['b.ts'], satisfied: false, openPrNumber: null },
    ]);
    expect(declared).not.toMatch(/pathManifest/);
    expect(declared).toContain('in_progress');
  });
});

describe('explicitTaskScope', () => {
  it('pins the row to the task id AND the workspaces this caller can claim from', () => {
    const q = render(explicitTaskScope('task-1', ['ws-a', 'ws-b']));
    expect(q.sql).toContain('"tasks"."id" = $1');
    expect(q.sql).toMatch(/"tasks"\."workspace_id" in \(\$2, \$3\)/);
    expect(q.params).toEqual(['task-1', 'ws-a', 'ws-b']);
  });
});

describe('diagnoseExplicitTaskExclusion', () => {
  beforeEach(() => {
    selectCalls = [];
    selectResult = [];
    selectQueue = [];
    selectThrows = false;
    selectThrowOnCall = null;
  });

  it('scopes the probe query and selects each supplied gate as a column', async () => {
    selectResult = [{ status: 'pending', claimedBy: null, expiresAt: null, startAt: null, g_missionHeld: false, g_deps: true }];
    const r = await diagnoseExplicitTaskExclusion({
      taskId: 'task-1',
      workspaceIds: ['ws-a'],
      gates: { missionHeld: sql`false`, deps: sql`true` },
      now: NOW,
    });

    expect(r?.code).toBe('mission_held');
    expect(selectCalls).toHaveLength(1);
    expect(Object.keys(selectCalls[0].fields)).toEqual(
      expect.arrayContaining(['status', 'claimedBy', 'expiresAt', 'startAt', 'g_missionHeld', 'g_deps']),
    );
    const where = render(selectCalls[0].where!);
    expect(where.sql).toContain('"tasks"."id" = $1');
    expect(where.sql).toContain('"tasks"."workspace_id" in ($2)');
  });

  it('coalesces every gate column to FALSE so a NULL predicate is still named', async () => {
    selectResult = [{ status: 'pending', claimedBy: null, expiresAt: null, startAt: null, g_deps: false }];
    await diagnoseExplicitTaskExclusion({
      taskId: 'task-1', workspaceIds: ['ws-a'], gates: { deps: sql`x IS NULL` }, now: NOW,
    });
    const col = render(selectCalls[0].fields.g_deps as SQL).sql;
    expect(col).toBe('COALESCE((x IS NULL), false)');
  });

  it('a NULL gate value in the row reads as failed, not as "not evaluated"', async () => {
    selectResult = [{ status: 'pending', claimedBy: null, expiresAt: null, startAt: null, g_deps: null }];
    const r = await diagnoseExplicitTaskExclusion({
      taskId: 'task-1', workspaceIds: ['ws-a'], gates: { deps: sql`true` }, now: NOW,
    });
    expect(r?.code).toBe('deps_blocked');
  });

  // Case (a)/(b) of friction cad81659: POST /api/tasks adds a dependsOn edge
  // to every in-flight task whose pathManifest overlaps. The caller never
  // declared it, so "a dependency is not satisfied" read as wrong; the reply
  // must name the dependency, its state, and where the edge came from.
  it('deps_blocked names each unsatisfied dependency and flags inferred overlap edges', async () => {
    selectQueue = [
      [{
        status: 'pending', claimedBy: null, expiresAt: null, startAt: null, g_deps: false, workspaceId: 'ws-a',
        dependsOn: ['dep-aaaa1111-0000', 'dep-bbbb2222-0000'], pathManifest: ['apps/web/src/a.ts'],
      }],
      [
        { id: 'dep-aaaa1111-0000', title: 'Upstream A', status: 'completed', pathManifest: ['apps/web/src/a.ts'], satisfied: false, openPrNumber: 41 },
        { id: 'dep-bbbb2222-0000', title: 'Upstream B', status: 'cancelled', pathManifest: null, satisfied: true, openPrNumber: null },
      ],
    ];
    const r = await diagnoseExplicitTaskExclusion({
      taskId: 'task-1', workspaceIds: ['ws-a'], gates: { deps: sql`false` }, now: NOW,
    });
    expect(r?.code).toBe('deps_blocked');
    expect(r?.detail).toContain('dep-aaaa');
    expect(r?.detail).toContain('Upstream A');
    expect(r?.detail).toContain('PR #41');
    expect(r?.detail).toMatch(/pathManifest/);
    expect(r?.detail).not.toContain('Upstream B');
    expect(r?.detail).toContain('force: true');
    // The dependency lookup is scoped to the ids on this task.
    const depWhere = render(selectCalls[1].where!);
    // Scoped to the task's ids AND the task's own workspace (review of #3053).
    expect(depWhere.params).toEqual(['dep-aaaa1111-0000', 'dep-bbbb2222-0000', 'ws-a']);
    expect(depWhere.sql).toMatch(/"tasks"\."workspace_id" = \$3/);
    // Correlated to the dependency row: a bare "id" in a select field would bind
    // to the subquery's own table and silently read the wrong rows.
    // Rendered as a real select (a field rendered alone is always qualified).
    const selectSql = new QueryBuilder().select(selectCalls[1].fields as any).from(tasks).toSQL().sql;
    expect(selectSql).not.toMatch(/w\.task_id = "id"|t2\.id = "id"/);
    expect(selectSql).toContain('w.task_id = "tasks"."id"');
    expect(selectSql).toContain('t2.id = "tasks"."id"');
  });

  it('a dependency in another workspace is described only as "(not found)"', async () => {
    selectQueue = [
      [{ status: 'pending', claimedBy: null, expiresAt: null, startAt: null, g_deps: false, workspaceId: 'ws-a', dependsOn: ['dep-elsewhere-0000'], pathManifest: null }],
      [], // the workspace-scoped lookup finds nothing
    ];
    const r = await diagnoseExplicitTaskExclusion({ taskId: 'task-1', workspaceIds: ['ws-a'], gates: { deps: sql`false` }, now: NOW });
    expect(r?.detail).toContain('dep-else (not found)');
  });

  it('a failed dependency lookup still returns deps_blocked', async () => {
    selectQueue = [[{ status: 'pending', claimedBy: null, expiresAt: null, startAt: null, g_deps: false, dependsOn: ['d1'], pathManifest: null, workspaceId: 'ws-a' }]];
    selectThrowOnCall = 2;
    const r = await diagnoseExplicitTaskExclusion({
      taskId: 'task-1', workspaceIds: ['ws-a'], gates: { deps: sql`false` }, now: NOW,
    });
    expect(r?.code).toBe('deps_blocked');
    expect(selectCalls).toHaveLength(2);
  });

  it('a task outside the caller\'s workspaces reads as not_found (no cross-tenant detail)', async () => {
    selectResult = [];
    const r = await diagnoseExplicitTaskExclusion({ taskId: 'task-x', workspaceIds: ['ws-a'], gates: {}, now: NOW });
    expect(r?.code).toBe('not_found');
  });

  it('a probe failure returns null so the claim response is never affected', async () => {
    selectThrows = true;
    const r = await diagnoseExplicitTaskExclusion({ taskId: 'task-1', workspaceIds: ['ws-a'], gates: {}, now: NOW });
    expect(r).toBeNull();
  });
});

// Reviewer follow-up on #2942: the fire-and-forget lastClaimAttempt write on an
// empty explicit claim filtered on tasks.id alone, so a caller could stamp a
// task in a workspace it cannot claim from. It must carry the same workspace
// scope as the claim query.
describe('stampLastClaimAttempt', () => {
  beforeEach(() => { updateCalls = []; });

  it('scopes the write to the task id AND the caller\'s claimable workspaces', async () => {
    await stampLastClaimAttempt({ taskId: 'task-1', workspaceIds: ['ws-a', 'ws-b'], reason: 'no_slots', now: NOW });
    expect(updateCalls).toHaveLength(1);
    const q = render(updateCalls[0].where!);
    expect(q.sql).toContain('"tasks"."id" = $1');
    expect(q.sql).toMatch(/"tasks"\."workspace_id" in \(\$2, \$3\)/);
    expect(q.params).toEqual(['task-1', 'ws-a', 'ws-b']);
  });

  it('writes nothing when the caller has no claimable workspaces', async () => {
    await stampLastClaimAttempt({ taskId: 'task-1', workspaceIds: [], reason: 'no_workspaces', now: NOW });
    expect(updateCalls).toHaveLength(0);
  });

  it('stamps the exact exclusion beside the coarse reason', async () => {
    await stampLastClaimAttempt({
      taskId: 'task-1', workspaceIds: ['ws-a'], reason: 'no_pending_tasks', now: NOW,
      exclusion: { code: 'workspace_cap', detail: 'cap' },
    });
    const q = render(updateCalls[0].set.context);
    const stamped = JSON.parse(q.params.find((p): p is string => typeof p === 'string' && p.includes('lastClaimAttempt'))!);
    expect(stamped).toMatchObject({
      lastClaimAttemptReason: 'no_pending_tasks',
      lastClaimAttemptExclusion: { code: 'workspace_cap', detail: 'cap' },
    });
  });

  it('never throws, even when the write fails', async () => {
    const failing = stampLastClaimAttempt({ taskId: 'task-1', workspaceIds: ['ws-a'], reason: 'x', now: NOW, deferrals: { mission_paced: 1 } });
    await expect(failing).resolves.toBeUndefined();
  });
});

// A runner's wake claim names its task. When a WHERE gate drops it, the runner
// gets `no_pending_tasks` and — before this — nothing was written to the gate
// ledger, so the task's gate history was empty and `explain` could only read
// the pending reviewer as a self-resolving wait (PR #3678: refused by the
// workspace cap on every wake for hours, with an idle runner).
describe('explicitExclusionGateEvent', () => {
  it('records a gate refusal as a claim_loop_deferral on the task, reason = the exclusion code', () => {
    const event = explicitExclusionGateEvent({
      taskId: 'task-1',
      exclusion: { code: 'workspace_cap', detail: 'The workspace is at its concurrent-task cap.' },
      workspaceId: 'ws-a',
    });
    expect(event).toMatchObject({
      gate: 'claim_loop_deferral',
      outcome: 'deferred',
      reason: 'workspace_cap',
      taskId: 'task-1',
      workspaceId: 'ws-a',
      detail: { explicitClaim: true, detail: 'The workspace is at its concurrent-task cap.' },
    });
  });

  it('records nothing when the task was not claimable at all (gone, done, running, changed)', () => {
    for (const code of ['not_found', 'not_pending', 'already_claimed', 'active_worker', 'state_changed'] as const) {
      expect(explicitExclusionGateEvent({ taskId: 'task-1', exclusion: { code, detail: '' }, workspaceId: null })).toBeNull();
    }
  });
});


describe('browser role claim diagnostics', () => {
  it('names the missing browser capability for a refused visual auditor', () => {
    const result = classifyExplicitTaskExclusion(probe({ roleSlug: 'visual-auditor', gates: { role: false } }), NOW);
    expect(result.code).toBe('role_mismatch');
    expect(result.detail).toContain('browser capability');
    expect(result.detail).toContain('provider');
  });
  it('retains the skill explanation for non-browser roles', () => {
    const result = classifyExplicitTaskExclusion(probe({ roleSlug: 'builder', gates: { role: false } }), NOW);
    expect(result.detail).toContain('skill match');
    expect(result.detail).not.toContain('browser capability');
  });
});


it('records a failed browser probe within the same scoped write with a minute throttle', async () => {
  updateCalls = [];
  selectThrows = false;
  await stampLastClaimAttempt({ taskId: 'task-a', workspaceIds: ['ws-a'], reason: 'no_pending_tasks', exclusion: { code: 'role_mismatch', detail: 'missing browser capability' }, browserProvider: { provider: 'cloudflare', ok: false, checkedAt: NOW.toISOString(), code: 'provider_missing' }, now: NOW });
  const context = render(updateCalls[0].set.context);
  expect(context.sql).toContain('lastBrowserRefusal');
  expect(context.sql).toContain('CASE WHEN');
  expect(context.params.join(' ')).toContain('provider_missing');
  expect(render(updateCalls[0].where!).params).toEqual(['task-a', 'ws-a']);
});
