/**
 * Predicate-level tests for the subject-claim repository.
 *
 * `subject-intake.test.ts` proves the intake ALGORITHM threads the generation it
 * read. That proves nothing about the SQL: a mocked `db` makes every WHERE clause
 * unobservable, so the guard could be missing entirely and the algorithm tests
 * would still pass. This file captures the UPDATE's `set` payload and `where`
 * fragment and renders them with PgDialect, which is the only way to see that
 * `generation` is both the compare and the increment.
 */
import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';

let capturedSet: Record<string, unknown> | null = null;
let capturedWhere: unknown = null;
let updatedTable: unknown = null;

mock.module('@buildd/core/db', () => ({
  db: {
    update: (table: unknown) => {
      updatedTable = table;
      return {
        set: (values: Record<string, unknown>) => {
          capturedSet = values;
          return {
            where: (pred: unknown) => {
              capturedWhere = pred;
              return { returning: () => Promise.resolve([{ id: 'claim-1' }]) };
            },
          };
        },
      };
    },
  },
}));

import { createSubjectIntakeRepository } from './subject-intake-db';
import { taskSubjectClaims } from '@buildd/core/db/schema';

const dialect = new PgDialect();
function render(frag: unknown): { sql: string; params: unknown[] } {
  const query = dialect.sqlToQuery(frag as never);
  return { sql: query.sql.replace(/\s+/g, ' ').trim(), params: query.params };
}

const repository = createSubjectIntakeRepository(async () => {
  throw new Error('createTask is not exercised here');
});

describe('rotateClaim — the generation compare-and-swap', () => {
  beforeEach(() => {
    capturedSet = null;
    capturedWhere = null;
    updatedTable = null;
  });

  it('increments generation in the same statement that matches it', async () => {
    const expiresAt = new Date('2026-01-01T00:00:00.000Z');
    const accepted = await repository.rotateClaim('claim-1', 'successor-1', 'token-1', expiresAt, 7);
    expect(accepted).toBe(true);
    expect(updatedTable).toBe(taskSubjectClaims);

    // The SET must bump the counter relative to the stored value, not to a value
    // computed in JS — `generation: expectedGeneration + 1` would reintroduce the
    // lost update it exists to stop.
    const setSql = render(capturedSet!.generation).sql;
    expect(setSql).toContain('"generation"');
    expect(setSql).toContain('+ 1');

    // Rotation drops the canonical owner and takes a fresh reservation.
    expect(capturedSet).toMatchObject({
      canonicalTaskId: null,
      reservationToken: 'token-1',
      reservationExpiresAt: expiresAt,
    });
  });

  it('matches the generation the caller read, alongside the ownership guards', async () => {
    await repository.rotateClaim('claim-1', 'successor-1', 'token-1', new Date(), 7);
    const { sql, params } = render(capturedWhere);

    // The compare half of the CAS: without this predicate a caller working from
    // state it read before someone else's rotation still passes the guards below
    // (canonical set, token cleared) once that rotation finalizes, and silently
    // rotates away a successor it never saw.
    expect(sql).toContain('"generation" =');
    expect(params).toContain(7);

    // The pre-existing guards must survive: rotation is only legal on a claim
    // that currently has an owner and no live reservation.
    expect(sql).toContain('"canonical_task_id" is not null');
    expect(sql).toContain('"reservation_token" is null');
    expect(sql).toContain('"id" =');
    expect(params).toContain('claim-1');
  });
});
