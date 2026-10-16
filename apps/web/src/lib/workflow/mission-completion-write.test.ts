/**
 * S4b: the one automated mission-completion write, rendered through the real PgDialect. Behaviour
 * on Postgres is tests/db/mission-completion-writer.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { completeMissionSql, missionEpochFingerprintSql } from './mission-completion-write';

const render = (q: Parameters<PgDialect['sqlToQuery']>[0]) => new PgDialect().sqlToQuery(q);

describe('mission completion write', () => {
  test('the fingerprint is every epoch\'s id, version and state, in epoch order; NULL with none', () => {
    const { sql: f } = render(missionEpochFingerprintSql(sql`m.id`));
    expect(f).toContain("string_agg(e.id::text || ':' || e.version::text || ':' || e.state, ',' ORDER BY e.epoch, e.id)");
    expect(f).toContain('FROM workflow_mission_epochs e WHERE e.mission_id = m.id');
  });

  test('active to completed, compare-and-set on the fingerprint the decision read', () => {
    const at = new Date('2026-10-15T00:00:00Z');
    const { sql: q, params } = render(completeMissionSql('m-1', 'e:1:retired', at));
    expect(q).toContain("UPDATE missions m SET status = 'completed', completed_at = $1::timestamptz, updated_at = $2::timestamptz");
    expect(q).toContain("WHERE m.id = $3::uuid AND m.status = 'active'");
    expect(q).toContain('IS NOT DISTINCT FROM $4::text');
    expect(q).toContain('RETURNING m.id, m.schedule_id');
    // A concurrent writer of the row (every epoch transition touches it) makes this re-check fail.
    expect(q).toContain('AND m.xmin::text = (SELECT xmin::text FROM missions WHERE id = $5::uuid)');
    expect(params).toEqual([at.toISOString(), at.toISOString(), 'm-1', 'e:1:retired', 'm-1']);
    // No delivery records: NULL, which matches only a mission that still has none.
    expect(render(completeMissionSql('m-1', null, at)).params[3]).toBeNull();
  });
});
