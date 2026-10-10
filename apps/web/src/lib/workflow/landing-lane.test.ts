/**
 * The landing lane's SQL, rendered (the lane itself runs against real Postgres
 * in apps/web/tests/db/workflow-scenarios-lane.test.ts).
 */
import { describe, expect, test } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import {
  acquireLaneSql, laneHolderSql, laneOutcome, releaseSettledLanesSql, resolveLandingLaneMode, wakeNextWaiterSql,
  LANE_HOLD_MS, LANE_PARKED_OUTCOME,
} from './landing-lane';

const render = (q: SQL) => new PgDialect().sqlToQuery(q);
const HOLDING = "hd.state IN ('APPROVED', 'LANDING') OR (hd.state = 'REPAIRING' AND hd.state_reason = 'behind')";
const key = { repoFullName: 'acme/x', baseRef: 'dev' };

describe('landing lane SQL', () => {
  test('acquire takes a free or settled lane, or renews its own, by compare-and-set', () => {
    const { sql, params } = render(acquireLaneSql({ ...key, deliveryId: 'd1', headSha: 'H1' }));
    expect(sql).toContain('ON CONFLICT (repo_full_name, base_ref) DO UPDATE');
    expect(sql).toContain('WHERE l.delivery_id = EXCLUDED.delivery_id OR NOT (l.lease_until > now() AND EXISTS');
    expect(sql).toContain(HOLDING);
    expect(sql).toContain('RETURNING l.delivery_id');
    expect(params).toEqual(['acme/x', 'dev', 'd1', 'H1', LANE_HOLD_MS]);
  });

  test('the holder read, the release and the wake share the one holding rule', () => {
    expect(render(laneHolderSql(key)).sql).toContain(HOLDING);
    const rel = render(releaseSettledLanesSql('d1'));
    expect(rel.sql).toContain('DELETE FROM landing_lanes l WHERE l.delivery_id = $1::uuid AND NOT (l.lease_until > now()');
    expect(rel.sql).toContain(HOLDING);
    const wake = render(wakeNextWaiterSql(key));
    expect(wake.sql).toContain("e.kind = 'refresh_branch' AND e.status = 'pending' AND e.outcome LIKE $1::text");
    expect(wake.sql).toContain('ORDER BY e.created_at, e.id');
    expect(wake.params).toEqual([`${LANE_PARKED_OUTCOME}%`, 'acme/x', 'dev']);
  });

  test('off unless a workspace opts in', () => {
    for (const v of [undefined, null, {}, { landingLane: 'off' }, { landingLane: true }, { landingLane: 'on' }]) expect(resolveLandingLaneMode(v)).toBe('off');
    expect(resolveLandingLaneMode({ landingLane: 'shadow' })).toBe('shadow');
    expect(resolveLandingLaneMode({ landingLane: 'enforce' })).toBe('enforce');
  });

  test('a parked outcome names the holder', () => {
    expect(laneOutcome(LANE_PARKED_OUTCOME, { prNumber: 7 })).toBe('parked:lane_busy:#7');
    expect(laneOutcome('lane:would_wait', null)).toBe('lane:would_wait:unknown');
  });
});
