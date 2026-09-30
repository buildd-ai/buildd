/**
 * The fleet-idle pass's pending-task scan, rendered to real SQL.
 *
 * route.test.ts mocks drizzle and the gate builders, which proves the scan
 * CALLS the claim route's predicates but not what they say. This file renders
 * the actual WHERE clause through PgDialect so a task in a held mission, a
 * local-executor mission, or held on its own is visibly excluded — the gap
 * that let the dispatch-stall responder page over work no runner may claim.
 */
import { describe, it, expect, mock } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';

mock.module('@buildd/core/db', () => ({ db: { query: {} } }));
mock.module('@buildd/core/report-ops', () => ({ reportOps: mock(() => Promise.resolve()) }));

import { claimablePendingWhere } from './fleet-idle';
import { missionNotHeld, missionNotLocal, taskNotHeld } from '@/app/api/workers/claim/held-gate';

const dialect = new PgDialect();
// Placeholders are renumbered to `$?`: a fragment renders from $1 alone but
// from a later index once embedded in the larger clause.
const render = (q: Parameters<PgDialect['sqlToQuery']>[0]) =>
  dialect.sqlToQuery(q).sql.replace(/\$\d+/g, '$?');

describe('fleet-idle claimable scan — SQL', () => {
  const where = render(claimablePendingWhere(new Date('2026-01-01T00:00:00Z')));

  it('excludes tasks whose mission is held', () => {
    expect(where).toContain('m.is_held = true');
  });

  it('excludes tasks whose mission runs from a local session', () => {
    expect(where).toContain("m.executor = 'local'");
  });

  it('excludes a task held on its own', () => {
    expect(where).toContain(`->'heldBy') IS NULL`);
  });

  it('embeds the claim route predicates verbatim, not a re-derived copy', () => {
    for (const gate of [missionNotHeld(), missionNotLocal(), taskNotHeld()]) {
      expect(where).toContain(render(gate));
    }
  });

  it('still carries the pending / age / startAt conditions', () => {
    expect(where).toContain('"tasks"."status" = $');
    expect(where).toContain('"tasks"."created_at" <= $');
    expect(where).toContain('"tasks"."start_at" is null');
  });
});
