import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
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
let selectThrows = false;

mock.module('@buildd/core/db', () => ({
  db: {
    select: (fields: Record<string, unknown>) => {
      const call = { fields, where: undefined as SQL | undefined };
      selectCalls.push(call);
      const chain: any = {
        from: () => chain,
        where: (w: SQL) => { call.where = w; return chain; },
        limit: async () => {
          if (selectThrows) throw new Error('db down');
          return selectResult;
        },
      };
      return chain;
    },
  },
}));

import {
  classifyExplicitTaskExclusion,
  diagnoseExplicitTaskExclusion,
  explicitTaskScope,
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

  it('an unexpired claim → already_claimed; an expired one is not', () => {
    const future = new Date(NOW.getTime() + 60_000);
    const past = new Date(NOW.getTime() - 60_000);
    expect(classifyExplicitTaskExclusion(probe({ claimedBy: 'acct', expiresAt: future }), NOW).code).toBe('already_claimed');
    expect(classifyExplicitTaskExclusion(probe({ claimedBy: 'acct', expiresAt: past }), NOW).code).toBe('unknown');
  });

  it('a future startAt → deferred with the timestamp', () => {
    const r = classifyExplicitTaskExclusion(probe({ startAt: new Date('2026-09-28T00:00:00Z') }), NOW);
    expect(r.code).toBe('deferred');
    expect(r.detail).toContain('2026-09-28T00:00:00.000Z');
  });

  it('a held mission → mission_held, and points at the dashboard force-start', () => {
    const r = classifyExplicitTaskExclusion(probe({ gates: { missionHeld: false } }), NOW);
    expect(r.code).toBe('mission_held');
    expect(r.detail).toMatch(/force-start/i);
  });

  it('each failing gate maps to its own code', () => {
    const cases: Array<[keyof ExplicitTaskProbe['gates'], string]> = [
      ['activeWorker', 'active_worker'],
      ['taskHeld', 'task_held'],
      ['missionHeld', 'mission_held'],
      ['deps', 'deps_blocked'],
      ['subject', 'subject_dead'],
      ['runnerPreference', 'runner_preference'],
      ['role', 'role_mismatch'],
      ['runnerCooldown', 'runner_cooldown'],
      ['workspaceCap', 'workspace_cap'],
    ];
    for (const [gate, code] of cases) {
      expect(classifyExplicitTaskExclusion(probe({ gates: { [gate]: false } }), NOW).code).toBe(code as any);
    }
  });

  it('a person hold outranks the mission hold (resume is the fix, not arming)', () => {
    expect(classifyExplicitTaskExclusion(probe({ gates: { taskHeld: false, missionHeld: false } }), NOW).code).toBe('task_held');
  });

  it('every gate passing but still excluded → unknown, never a guess', () => {
    const r = classifyExplicitTaskExclusion(probe({ gates: { missionHeld: true, deps: true } }), NOW);
    expect(r.code).toBe('unknown');
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
    selectThrows = false;
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
