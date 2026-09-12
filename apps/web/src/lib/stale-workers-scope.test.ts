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
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workers: { findMany: async () => [] },
      tasks: { findFirst: async () => null, findMany: async () => [] },
      workerHeartbeats: { findFirst: async () => null },
    },
    update: () => ({ set: () => ({ where: async () => undefined }) }),
    select: () => ({ from: () => ({ where: async () => [] }) }),
  },
}));

import {
  neverStartedTeamScope,
  heartbeatOrphanScope,
  heartbeatFreshnessScope,
} from './stale-workers';

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
