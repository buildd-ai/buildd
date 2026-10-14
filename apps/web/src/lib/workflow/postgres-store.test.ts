/**
 * The Postgres store adapter: the one statement it adds (a fact read with its
 * payload, for decision replay) rendered through the real PgDialect, and the
 * row mapping of the outbox and transition statements against a scripted
 * executor. The adapter's behaviour end to end is the conformance suite on
 * real Postgres (apps/web/tests/db/workflow-kernel-conformance.test.ts).
 */
import { describe, expect, test } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { findFactRecordSql, isUniqueViolation, linkAttemptTaskSql, linkRoundReviewerSql, postgresStore, toClaimedEffect } from './postgres-store';
import type { Exec } from './kernel';

const render = (q: SQL) => new PgDialect().sqlToQuery(q);
const tagOf = (q: SQL) => render(q).sql.split('\n')[0]!.replace('-- workflow:', '');

describe('findFactRecordSql', () => {
  test('reads one fact by (workspace, key) with its payload; writes nothing', () => {
    const { sql: text, params } = render(findFactRecordSql('w1', 'decide:visual_impact:d1:H1'));
    expect(text).toContain('SELECT id, applied_transition_id, payload FROM workflow_facts');
    expect(text).toContain('WHERE workspace_id = $1::uuid AND fact_key = $2::text');
    expect(text).not.toMatch(/INSERT|UPDATE|DELETE/);
    expect(params).toEqual(['w1', 'decide:visual_impact:d1:H1']);
  });
});

describe('linkAttemptTaskSql', () => {
  test('binds only a ledger row with no task yet', () => {
    const { sql: text, params } = render(linkAttemptTaskSql('a1', 't1'));
    expect(text).toContain('UPDATE workflow_attempts SET task_id = $1::uuid, updated_at = now()');
    expect(text).toContain('WHERE id = $2::uuid AND task_id IS NULL');
    expect(params).toEqual(['t1', 'a1']);
  });
});

describe('linkRoundReviewerSql', () => {
  test('binds only a round with no reviewer yet', () => {
    const { sql: text, params } = render(linkRoundReviewerSql('r1', 't1'));
    expect(text).toContain('UPDATE workflow_review_rounds SET reviewer_task_id = $1::uuid, updated_at = now()');
    expect(text).toContain('WHERE id = $2::uuid AND reviewer_task_id IS NULL');
    expect(params).toEqual(['t1', 'r1']);
  });
});

describe('row mapping', () => {
  test('a claimed row maps authority, delivery and transition exactly as the drain reads them', () => {
    const e = toClaimedEffect({
      id: 'e1', delivery_id: 'd1', transition_id: 't1', kind: 'dispatch_fix', dedupe_key: 'k', payload: null, attempt_count: '2',
      delivery: { state: 'FIXING', version: '4', workspace_id: 'w1' }, transition: { to_state: 'FIXING', to_version: 4 }, authority: 'legacy',
    });
    expect(e).toEqual({
      id: 'e1', deliveryId: 'd1', transitionId: 't1', kind: 'dispatch_fix', dedupeKey: 'k', payload: {}, attemptCount: 2,
      delivery: { state: 'FIXING', version: 4, workspaceId: 'w1' }, transition: { toState: 'FIXING', toVersion: 4 }, authority: 'legacy',
    });
    // The store reports only the row's own authority: the kill switch is the drain's Policy.
    expect(toClaimedEffect({ id: 'e', delivery_id: 'd', transition_id: 't', kind: 'notify', dedupe_key: 'k', delivery: null, transition: null, authority: 'switched_off' }).authority).toBe('kernel');
    expect(toClaimedEffect({ id: 'e', delivery_id: 'd', transition_id: 't', kind: 'notify', dedupe_key: 'k', delivery: null, transition: null, authority: null }))
      .toMatchObject({ delivery: null, transition: null, authority: 'kernel' });
  });

  test('a transition write: a row is applied, no row is a guard conflict, a unique violation is a unique conflict, anything else throws', async () => {
    const answer = (fn: () => Promise<{ rows?: unknown[] }>): Exec => async (q) => { expect(tagOf(q)).toBe('transition'); return fn(); };
    const fake = { create: { workspaceId: 'w1', ownerTaskId: 't1', maxRounds: 3 }, toState: 'WORKING', fromState: null, command: 'DeliveryOpened', idempotencyKey: 'k', evidence: {}, patch: {}, effects: [], rounds: [], attempts: [], guard: { version: 0, states: [] } } as never;
    expect(await postgresStore(answer(async () => ({ rows: [{ transition_id: 'tr', delivery_id: 'd', version: '1' }] }))).applyTransition(fake, { deliveryId: null }))
      .toEqual({ status: 'applied', transitionId: 'tr', deliveryId: 'd', version: 1 });
    expect(await postgresStore(answer(async () => ({ rows: [] }))).applyTransition(fake, { deliveryId: null })).toEqual({ status: 'conflict', cause: 'guard' });
    expect(await postgresStore(answer(async () => { throw Object.assign(new Error('x'), { code: '23505' }); })).applyTransition(fake, { deliveryId: null }))
      .toEqual({ status: 'conflict', cause: 'unique' });
    await expect(postgresStore(answer(async () => { throw new Error('connection reset'); })).applyTransition(fake, { deliveryId: null })).rejects.toThrow('connection reset');
    expect(isUniqueViolation({ cause: { code: '23505' } })).toBe(true);
    expect(isUniqueViolation(new Error('duplicate key value violates unique constraint "x"'))).toBe(true);
  });
});
