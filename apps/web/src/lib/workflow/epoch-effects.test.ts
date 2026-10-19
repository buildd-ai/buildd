/**
 * The mission epochs' outbox (§6): the statements rendered through PgDialect.
 * Owing, draining and superseding against real Postgres live in
 * apps/web/tests/db/epoch-effects.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import {
  claimDueEpochEffectsSql,
  epochEffectByKeySql,
  oweEpochEffectSql,
  renewEpochEffectSql,
} from './epoch-effects';

const dialect = new PgDialect();
const render = (q: SQL) => dialect.sqlToQuery(q);

describe('SQL', () => {
  test('owing writes an epoch-owned row only while the epoch is open, idempotent on the dedupe key', () => {
    const { sql: text, params } = render(oweEpochEffectSql({
      epochId: 'ep1', kind: 'refresh_mission_branch', dedupeKey: 'k1', payload: { branch: 'b' },
    } as Parameters<typeof oweEpochEffectSql>[0]));
    expect(text).toContain('INSERT INTO workflow_effects (epoch_id, kind, dedupe_key, payload)');
    expect(text).toContain("WHERE ep.id = $4::uuid AND ep.state = 'open'");
    expect(text).toContain('ON CONFLICT (dedupe_key) DO NOTHING');
    expect(params).toEqual(['refresh_mission_branch', 'k1', '{"branch":"b"}', 'ep1']);
  });

  test('the row behind a dedupe key is read only among epoch-owned rows', () => {
    const { sql: text, params } = render(epochEffectByKeySql('k1'));
    expect(text).toContain('WHERE dedupe_key = $1::text AND epoch_id IS NOT NULL');
    expect(params).toEqual(['k1']);
  });

  test('the claim takes due and lease-expired epoch rows with SKIP LOCKED, never a delivery\'s', () => {
    const { sql: text, params } = render(claimDueEpochEffectsSql(5));
    expect(text).toContain('WHERE epoch_id IS NOT NULL');
    expect(text).toContain("(status = 'pending' AND not_before <= now())");
    expect(text).toContain("(status = 'delivering' AND lease_until < now())");
    expect(text).toContain('FOR UPDATE SKIP LOCKED');
    expect(text).toContain('attempt_count = e.attempt_count + 1');
    expect(text).not.toContain('jsonb_array_elements_text');
    expect(params).toEqual([5, 120_000]);
  });

  test('an asking drain claims only the rows it just owed', () => {
    const { sql: text, params } = render(claimDueEpochEffectsSql(5, 120_000, ['e1']));
    expect(text).toContain('AND id IN (SELECT (jsonb_array_elements_text($1::jsonb))::uuid)');
    expect(params).toEqual(['["e1"]', 5, 120_000]);
  });

  test('renewal is fenced to the attempt and re-reads the epoch the row was owed by', () => {
    const { sql: text, params } = render(renewEpochEffectSql('e1', 2));
    expect(text).toContain("WHERE e.id = $2::uuid AND e.status = 'delivering' AND e.attempt_count = $3::int");
    expect(text).toContain("jsonb_build_object('state', ep.state, 'branch', ep.branch, 'mission_id', ep.mission_id)");
    expect(text).toContain('WHERE ep.id = e.epoch_id) AS epoch');
    expect(params).toEqual([120_000, 'e1', 2]);
  });
});
