import { describe, expect, it, mock } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';

// Only the db client is stubbed; the real drizzle builders and schema run so
// the rendered SQL says what the predicates actually are.
mock.module('@buildd/core/db', () => ({ db: {} }));

import {
  PARK_MAX_MS,
  ownedByCaller,
  PARK_MISSION_MAX_MS,
  notParkedScope,
  parkWhere,
  parkedUntilFor,
  reattachWhere,
  unparkWhere,
} from './worker-park';

const dialect = new PgDialect();
function render(fragment: any): { sql: string; params: unknown[] } {
  const q = dialect.sqlToQuery(fragment);
  return { sql: q.sql.replace(/\s+/g, ' ').trim().toLowerCase(), params: q.params };
}

const NOW = new Date('2026-01-01T12:00:00.000Z');
const WORKER = '33333333-3333-4333-8333-333333333333';
const ACCOUNT = '44444444-4444-4444-8444-444444444444';
const KEY = { id: ACCOUNT };

describe('park TTL', () => {
  it('24 h for a standalone task, 4 h for a mission task (the waiting_input timeouts)', () => {
    expect(PARK_MAX_MS).toBe(24 * 60 * 60 * 1000);
    expect(PARK_MISSION_MAX_MS).toBe(4 * 60 * 60 * 1000);
    expect(parkedUntilFor(NOW, false).getTime()).toBe(NOW.getTime() + PARK_MAX_MS);
    expect(parkedUntilFor(NOW, true).getTime()).toBe(NOW.getTime() + PARK_MISSION_MAX_MS);
  });
});

describe('reattachWhere: the only way a second process takes over a worker', () => {
  const r = render(reattachWhere(WORKER, KEY, NOW));

  it('is keyed on the worker AND the calling account', () => {
    expect(r.sql).toContain('"workers"."id" = $');
    expect(r.sql).toContain('"workers"."account_id" = $');
    expect(r.params).toContain(WORKER);
    expect(r.params).toContain(ACCOUNT);
  });

  it('requires a live park (parked_until > now), so one reattach clears it and the next finds nothing', () => {
    expect(r.sql).toContain('"workers"."parked_until" > $');
    expect(r.params).toContain(NOW.toISOString());
  });

  it('only a parked question or an orphan-parked run can be re-attached', () => {
    expect(r.sql).toMatch(/"workers"\."status" in \(\$\d+, \$\d+\)/);
    expect(r.params).toContain('waiting_input');
    expect(r.params).toContain('running');
  });
});

describe('parkWhere / unparkWhere', () => {
  it('park: own worker, live status only', () => {
    const r = render(parkWhere(WORKER, KEY));
    expect(r.sql).toContain('"workers"."id" = $');
    expect(r.sql).toContain('"workers"."account_id" = $');
    expect(r.params).toEqual(expect.arrayContaining([WORKER, ACCOUNT, 'waiting_input', 'running']));
  });

  it('unpark: own worker only', () => {
    const r = render(unparkWhere(WORKER, KEY));
    expect(r.sql).toContain('"workers"."account_id" = $');
    expect(r.params).toEqual(expect.arrayContaining([WORKER, ACCOUNT]));
  });
});

describe('notParkedScope: what the sweeps exempt', () => {
  it('a NULL park or one that has expired', () => {
    const r = render(notParkedScope(NOW));
    expect(r.sql).toContain('"workers"."parked_until" is null');
    expect(r.sql).toContain('"workers"."parked_until" <= $');
    expect(r.sql).toContain(' or ');
    expect(r.params).toContain(NOW.toISOString());
  });
});

describe('task-scoped callers (per-task token): confined to their own task', () => {
  const TASK = '66666666-6666-4666-8666-666666666666';

  it('adds a task_id predicate to all three when a task is given', () => {
    for (const r of [render(parkWhere(WORKER, { id: ACCOUNT, taskScope: { taskId: TASK } })), render(unparkWhere(WORKER, { id: ACCOUNT, taskScope: { taskId: TASK } })), render(reattachWhere(WORKER, { id: ACCOUNT, taskScope: { taskId: TASK } }, NOW))]) {
      expect(r.sql).toContain('"workers"."task_id" = $');
      expect(r.params).toContain(TASK);
    }
  });

  it('adds nothing for an account key', () => {
    for (const r of [render(parkWhere(WORKER, KEY)), render(unparkWhere(WORKER, KEY)), render(reattachWhere(WORKER, KEY, NOW))]) {
      expect(r.sql).not.toContain('task_id');
    }
  });
});

// Same rule as callerOwnsWorker (lib/worker-owner.ts), in SQL: an OAuth session
// resolves to an account its whole team shares, so the predicate also pins the
// claimer. Every UPDATE above goes through it.
describe('ownedByCaller: only the principal that claimed', () => {
  const USER = '77777777-7777-4777-8777-777777777777';
  const session = { id: ACCOUNT, teamId: 'team-1', sessionUserId: USER };

  it('a bld_ key: its account, and only a worker no session claimed', () => {
    const r = render(ownedByCaller(KEY));
    expect(r.sql).toContain('"workers"."account_id" = $');
    expect(r.sql).toContain('"workers"."claimed_by_user_id" is null');
    expect(r.params).toContain(ACCOUNT);
  });

  it('an OAuth session: its account AND its own user as the claimer', () => {
    const r = render(ownedByCaller(session));
    expect(r.sql).toContain('"workers"."account_id" = $');
    expect(r.sql).toContain('"workers"."claimed_by_user_id" = $');
    expect(r.sql).toContain('"workers"."workspace_id" is not null');
    expect(r.params).toEqual(expect.arrayContaining([ACCOUNT, USER]));
  });

  it('every park predicate carries it', () => {
    for (const r of [render(parkWhere(WORKER, session)), render(unparkWhere(WORKER, session)), render(reattachWhere(WORKER, session, NOW))]) {
      expect(r.sql).toContain('"workers"."claimed_by_user_id" = $');
      expect(r.params).toContain(USER);
    }
  });

  it('matches no row on a missing account id or a session with no team id', () => {
    expect(render(ownedByCaller({ id: '' })).sql).toBe('false');
    expect(render(ownedByCaller({ ...session, teamId: null })).sql).toBe('false');
    expect(render(parkWhere(WORKER, { ...session, teamId: undefined })).sql).toContain('false');
  });
});
