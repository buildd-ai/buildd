import { describe, it, expect } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';

// No db mock here on purpose: this module is a WHERE fragment and a predicate,
// nothing else. A mocked `db` makes a predicate unobservable (that is how the
// queue-depth double count survived), so the fragment is rendered with the real
// dialect and asserted as SQL text + params.
import {
  isMissionIntegrationMerge,
  notMissionIntegrationMerge,
} from '../release-queue-scope';

const dialect = new PgDialect();
function render(frag: unknown): { sql: string; params: unknown[] } {
  const q = dialect.sqlToQuery(frag as never);
  return { sql: q.sql.replace(/\s+/g, ' ').trim(), params: q.params };
}

describe('isMissionIntegrationMerge', () => {
  it('is true for a merge whose base is a mission integration branch', () => {
    expect(isMissionIntegrationMerge('mission/some-goal-1a2b3c4d')).toBe(true);
  });

  it('is false for a trunk base ref', () => {
    expect(isMissionIntegrationMerge('dev')).toBe(false);
    expect(isMissionIntegrationMerge('main')).toBe(false);
  });

  it('is false for an unknown base ref — unknown is never quarantined', () => {
    // Mirrors `isMissionIntegrationBase`: "we do not know where this PR landed"
    // must degrade to the existing behaviour (counted), never to "hidden".
    expect(isMissionIntegrationMerge(null)).toBe(false);
    expect(isMissionIntegrationMerge(undefined)).toBe(false);
    expect(isMissionIntegrationMerge('')).toBe(false);
  });
});

describe('notMissionIntegrationMerge', () => {
  it('renders a NULL-tolerant NOT LIKE on the base ref', () => {
    const { sql, params } = render(notMissionIntegrationMerge());

    // NULL must survive the filter: pre-`pr_base_ref` merged rows carry null and
    // dropping them would silently zero every workspace's release queue.
    expect(sql).toContain('"pr_base_ref" is null');
    expect(sql.toLowerCase()).toContain('not like');
    expect(sql.toLowerCase()).toContain(' or ');
    expect(params).toEqual(['mission/%']);
  });

  it('names the real column, so the fragment can only be applied to workers', () => {
    expect(render(notMissionIntegrationMerge()).sql).toContain('"workers"."pr_base_ref"');
  });
});
