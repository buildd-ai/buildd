import { describe, it, expect, mock } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';

/**
 * Scope tests for the stale-worker reaper's WHERE clauses.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM `stale-workers.test.ts`
 * ------------------------------------------------------------
 * `stale-workers.test.ts` does `mock.module('drizzle-orm')` — its `eq` returns
 * a plain `{ field, value }` object — AND mocks the schema as
 * `workers: 'workers'`, because its `db.update` dispatch is keyed on
 * `table === 'workers'`. Under those two mocks the *column* in
 * `eq(workers.accountId, x)` is `undefined`, so which column a predicate is
 * keyed on is completely unobservable there, and enriching the schema mock to
 * recover it would break update routing. A scoping assertion written in that
 * file would assert nothing at all.
 *
 * So: no `drizzle-orm` mock and no schema mock here. Only the db *client* is
 * stubbed (nothing in this file executes a query), which lets the real drizzle
 * builders run and the real `PgDialect` render them to SQL text. Same technique
 * as `apps/web/src/app/api/workers/claim/held-gate.test.ts`.
 */
// Recorded so the failWorkersOfOfflineRunners tests can render the WHERE each
// query was issued with. `freshHeartbeatFor` decides, per account, whether the
// freshness lookup finds a live runner.
const heartbeatLookups: any[] = [];
const workerLookups: any[] = [];
const workerUpdates: any[] = [];
let freshHeartbeatFor = new Set<string>();
let orphanRows: any[] = [];

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workers: {
        findMany: async (args: any) => {
          workerLookups.push(args.where);
          // Only the orphan query selects `branch`; everything else sees none.
          return args.columns?.branch ? orphanRows : [];
        },
      },
      tasks: { findFirst: async () => null, findMany: async () => [] },
      workerHeartbeats: {
        findFirst: async (args: any) => {
          heartbeatLookups.push(args.where);
          const rendered = dialect.sqlToQuery(args.where);
          return rendered.params.some((p: unknown) => freshHeartbeatFor.has(p as string)) ? { id: 'hb' } : null;
        },
      },
    },
    update: () => ({ set: (vals: any) => ({ where: async () => { workerUpdates.push(vals); } }) }),
    select: () => ({ from: () => ({ where: async () => [] }) }),
  },
}));

import {
  neverStartedTeamScope,
  heartbeatOrphanScope,
  heartbeatFreshnessScope,
  staleWorkerScope,
  failWorkersOfOfflineRunners,
  HEARTBEAT_STALE_MS,
} from './stale-workers';
import { INTERACTIVE_WORKER_IDLE_TTL_MS, RUNNER_STALE_CUTOFF_MS } from '@buildd/shared';
import { interactiveAbandonedScope, interactiveTouchScope, INTERACTIVE_TOUCH_THROTTLE_MS } from './interactive-worker-liveness';

const dialect = new PgDialect();

/**
 * Rendered SQL, whitespace-collapsed and lower-cased. Keywords are lower-cased
 * because drizzle's own builders emit `is null` / `in` while hand-written
 * `sql` fragments emit `IS NULL` / `IN`; identifiers are already lower-case, so
 * folding case keeps these assertions about *meaning* rather than about which
 * builder happened to produce a clause.
 */
function render(fragment: any): string {
  return dialect.sqlToQuery(fragment).sql.replace(/\s+/g, ' ').trim().toLowerCase();
}

const THRESHOLD = new Date('2026-01-01T00:00:00.000Z');

describe('neverStartedTeamScope — the widened never-started arm', () => {
  it('scopes to the owning TEAM via a correlated sub-select, not to one account', () => {
    // The invariant: every orphaned never-started worker row must be reachable
    // by the team that owns it. A bare `account_id = $1` here is the bug —
    // a row minted by a runner that died is then only reapable by the very
    // account whose runner is gone, so the task is blocked forever, not for
    // IDLE_STALE_THRESHOLD_MS.
    const sqlText = render(neverStartedTeamScope('account-1', THRESHOLD));

    expect(sqlText).toContain('team_id');
    expect(sqlText).toContain('select');
    // Must be a set membership against team-sibling accounts...
    expect(sqlText).toMatch(/"workers"\."account_id" in \(\s*select/i);
    // ...and must NOT degrade to the single-account predicate.
    expect(sqlText).not.toMatch(/"workers"\."account_id" = \$\d/);
  });

  it('resolves the team from the cleaning account rather than taking a team id argument', () => {
    // A correlated sub-select keeps this on one round-trip. `cleanupStaleWorkers`
    // runs on the claim hot path (POST /api/workers/claim calls it before it
    // even looks for candidate tasks), so resolving the team with an extra
    // `accounts.findFirst` would add a serial query to every single poll.
    const sqlText = render(neverStartedTeamScope('account-1', THRESHOLD));
    expect(sqlText).toMatch(/team_id\s*=\s*\(\s*select/i);
    expect(sqlText).toContain('"accounts"');
  });

  it('is strictly narrower than the plain idle rule: started_at IS NULL and status = idle', () => {
    // `started_at IS NULL` is the ENTIRE safety argument for crossing the
    // account boundary. The pre-existing idle rule does not carry it, which is
    // exactly why that rule must stay account-scoped: without this predicate a
    // cross-account reap could kill a sibling account's *started* session.
    const sqlText = render(neverStartedTeamScope('account-1', THRESHOLD));
    expect(sqlText).toContain('"workers"."started_at" is null');
    expect(sqlText).toContain(`"workers"."status" = 'idle'`);
    // ...and the account predicate here must be the team set, never one account.
    expect(sqlText).not.toMatch(/"workers"\."account_id" = \$\d/);
  });

  it('still applies the idle staleness clock', () => {
    const rendered = dialect.sqlToQuery(neverStartedTeamScope('account-1', THRESHOLD));
    expect(rendered.sql.replace(/\s+/g, ' ').toLowerCase()).toContain('"workers"."updated_at" <');
    // The threshold is bound, not inlined.
    expect(rendered.params).toContain(THRESHOLD);
  });

  it('binds the cleaning account id as a parameter', () => {
    const rendered = dialect.sqlToQuery(neverStartedTeamScope('account-xyz', THRESHOLD));
    expect(rendered.params).toContain('account-xyz');
  });
});

describe('heartbeatOrphanScope — the boundary deliberately NOT crossed', () => {
  /**
   * Mutation-style guard. Widening the heartbeat rule is unsafe in BOTH
   * directions and this test is here to make either mutation loud:
   *
   *  - Widen only this worker query (leaving the `freshHeartbeat` lookup keyed
   *    on one account) and account A's offline runner starts failing account
   *    B's live, working workers.
   *  - Widen the freshness lookup too and the gate only fires when EVERY runner
   *    in the team is offline — a gate that can never fire in practice, which
   *    is worse than no gate because it reads as protection.
   */
  it('stays account-scoped', () => {
    const sqlText = render(heartbeatOrphanScope('account-1', THRESHOLD));
    expect(sqlText).toMatch(/"workers"\."account_id" = \$\d/);
  });

  it('contains no team_id and no sub-select', () => {
    const sqlText = render(heartbeatOrphanScope('account-1', THRESHOLD));
    expect(sqlText).not.toContain('team_id');
    expect(sqlText).not.toContain('select');
  });

  it('keeps its live-status set and staleness clock', () => {
    const sqlText = render(heartbeatOrphanScope('account-1', THRESHOLD));
    expect(sqlText).toContain('"workers"."status" in');
    expect(sqlText).toContain('"workers"."updated_at" <');
  });
});

describe('heartbeatFreshnessScope — must stay account-keyed', () => {
  it('looks up the heartbeat for one account only', () => {
    const sqlText = render(heartbeatFreshnessScope('account-1', THRESHOLD));
    expect(sqlText).toMatch(/"worker_heartbeats"\."account_id" = \$\d/);
    expect(sqlText).not.toContain('team_id');
    expect(sqlText).not.toContain('select');
  });

  it('asserts freshness with a greater-than on last_heartbeat_at', () => {
    const sqlText = render(heartbeatFreshnessScope('account-1', THRESHOLD));
    expect(sqlText).toContain('"worker_heartbeats"."last_heartbeat_at" >');
  });
});

/**
 * Friction 92866723: `claim_task` from an MCP session mints a worker with
 * runner = 'mcp' that no runner ever starts. Every runner rule read it as dead
 * (the idle rule after five minutes, as "never started by a runner") while a
 * person's local agent was still working, and the task was re-queued for a
 * runner to duplicate. Runner rules must skip interactive workers; one arm
 * reaps them on MCP silence alone, after a long TTL.
 */
describe('staleWorkerScope: interactive MCP workers', () => {
  const NOW = new Date('2026-09-28T12:00:00.000Z');

  it('every runner rule excludes runner = mcp; exactly one arm selects it', () => {
    const q = dialect.sqlToQuery(staleWorkerScope('account-1', NOW));
    // generic stale, idle, silent start, never started
    expect(q.sql.match(/"workers"\."runner" <> \$\d+/g)?.length).toBe(4);
    expect(q.sql.match(/"workers"\."runner" = \$\d+/g)?.length).toBe(1);
    expect(q.params.filter(p => p === 'mcp').length).toBe(5);
  });

  it('the interactive arm is account-scoped and waits the full MCP-silence TTL', () => {
    const q = dialect.sqlToQuery(interactiveAbandonedScope('account-1', NOW));
    const text = q.sql.toLowerCase();
    expect(text).toMatch(/"workers"\."account_id" = \$\d/);
    expect(text).toMatch(/"workers"\."runner" = \$\d/);
    expect(text).toContain('"workers"."updated_at" <');
    expect(text).not.toContain('team_id');
    expect(q.params).toEqual(expect.arrayContaining(['account-1', 'mcp', 'idle', 'running', 'starting']));
    // A parked question is governed by the waiting_input sweep, not this arm.
    expect(q.params).not.toContain('waiting_input');
    expect(q.params).toContain(new Date(NOW.getTime() - INTERACTIVE_WORKER_IDLE_TTL_MS).toISOString());
    // And the scope actually includes it.
    expect(dialect.sqlToQuery(staleWorkerScope('account-1', NOW)).params)
      .toContain(new Date(NOW.getTime() - INTERACTIVE_WORKER_IDLE_TTL_MS).toISOString());
  });

  it('the team-scoped never-started arm skips interactive workers', () => {
    const q = dialect.sqlToQuery(neverStartedTeamScope('account-1', THRESHOLD));
    expect(q.sql).toMatch(/"workers"\."runner" <> \$\d/);
    expect(q.params).toContain('mcp');
  });

  it('the runner-heartbeat rule skips interactive workers and stays account-scoped', () => {
    const q = dialect.sqlToQuery(heartbeatOrphanScope('account-1', THRESHOLD));
    expect(q.sql).toMatch(/"workers"\."runner" <> \$\d/);
    expect(q.params).toContain('mcp');
  });
});

describe('interactiveTouchScope: what one MCP call keeps alive', () => {
  const NOW = new Date('2026-09-28T12:00:00.000Z');

  it('only the calling account\'s own live interactive workers, throttled', () => {
    const q = dialect.sqlToQuery(interactiveTouchScope('account-1', null, NOW));
    const text = q.sql.toLowerCase();
    expect(text).toMatch(/"workers"\."account_id" = \$\d/);
    expect(text).toMatch(/"workers"\."runner" = \$\d/);
    expect(text).toContain('"workers"."status" in');
    expect(q.params).toEqual(expect.arrayContaining(['account-1', 'mcp', 'idle', 'running', 'starting']));
    expect(q.params).not.toContain('waiting_input');
    expect(q.params).toContain(new Date(NOW.getTime() - INTERACTIVE_TOUCH_THROTTLE_MS).toISOString());
    expect(text).not.toContain('team_id');
  });
});

describe('failWorkersOfOfflineRunners: the one offline-runner rule', () => {
  const NOW = new Date('2026-09-29T12:00:00.000Z');
  const CUTOFF_ISO = new Date(NOW.getTime() - RUNNER_STALE_CUTOFF_MS).toISOString();

  function reset() {
    heartbeatLookups.length = 0;
    workerLookups.length = 0;
    workerUpdates.length = 0;
    freshHeartbeatFor = new Set();
    orphanRows = [];
  }

  it('uses the not-dead cutoff, derived from the heartbeat cadence', () => {
    // Was a hand-typed 150 min here and 10 min in the cleanup route.
    expect(HEARTBEAT_STALE_MS).toBe(RUNNER_STALE_CUTOFF_MS);
  });

  it('kills nothing on an account that still has one live runner', async () => {
    // The regression: one runner's dead heartbeat row on the account used to
    // fail every running worker under the account's OTHER, live runner.
    reset();
    freshHeartbeatFor = new Set(['account-1']);
    orphanRows = [{ id: 'w1', taskId: null }];

    expect(await failWorkersOfOfflineRunners({ accountIds: ['account-1'] }, NOW)).toBe(0);
    expect(workerLookups).toHaveLength(0);
    expect(workerUpdates).toHaveLength(0);
  });

  it('asks "is any runner on this account alive" with the account key and the not-dead cutoff', async () => {
    reset();
    freshHeartbeatFor = new Set(['account-1']);
    await failWorkersOfOfflineRunners({ accountIds: ['account-1'] }, NOW);

    const q = dialect.sqlToQuery(heartbeatLookups[0]);
    const text = q.sql.replace(/\s+/g, ' ').toLowerCase();
    expect(text).toMatch(/"worker_heartbeats"\."account_id" = \$\d/);
    expect(text).toContain('"worker_heartbeats"."last_heartbeat_at" >');
    expect(q.params).toContain('account-1');
    // 150 min, not the cleanup route's old 10 — an in-flight worker whose
    // runner missed a few beats is not dead.
    expect(q.params).toContain(CUTOFF_ISO);
  });

  it('only when no runner on the account is alive, fails its runner workers idle past the cutoff', async () => {
    reset();
    orphanRows = [{ id: 'w1', taskId: null, startedAt: new Date(), turns: 3 }];

    expect(await failWorkersOfOfflineRunners({ accountIds: ['account-1'] }, NOW)).toBe(1);
    expect(workerLookups).toHaveLength(1);
    const q = dialect.sqlToQuery(workerLookups[0]);
    const text = q.sql.replace(/\s+/g, ' ').toLowerCase();
    expect(text).toMatch(/"workers"\."account_id" = \$\d/);
    expect(text).toContain('"workers"."updated_at" <');
    expect(text).toMatch(/"workers"\."runner" <> \$\d/);
    expect(q.params).toEqual(expect.arrayContaining(['account-1', 'mcp', CUTOFF_ISO]));
    expect(workerUpdates.some(u => u.status === 'failed')).toBe(true);
  });

  it('judges each account on its own runners', async () => {
    reset();
    freshHeartbeatFor = new Set(['account-live']);
    orphanRows = [{ id: 'w1', taskId: null, startedAt: new Date(), turns: 3 }];

    await failWorkersOfOfflineRunners({ accountIds: ['account-live', 'account-dead', 'account-dead'] }, NOW);

    // One freshness lookup per distinct account, one orphan query — for the dead one only.
    expect(heartbeatLookups).toHaveLength(2);
    expect(workerLookups).toHaveLength(1);
    expect(dialect.sqlToQuery(workerLookups[0]).params).toContain('account-dead');
    expect(dialect.sqlToQuery(workerLookups[0]).params).not.toContain('account-live');
  });
});
