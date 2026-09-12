import { describe, it, expect, mock } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';

/**
 * Scope tests for the readout's cohort filters.
 *
 * WHY THESE ASSERTIONS RENDER SQL INSTEAD OF INSPECTING CALLS
 * ----------------------------------------------------------
 * An aggregation over the wrong cohort is the exact failure this readout
 * exists to prevent, and it is invisible to a test that mocks `db`: under a
 * mocked client the predicate builders return opaque objects, so which COLUMN
 * a filter is keyed on cannot be observed at all. A test could then prove the
 * arithmetic is right while the rows it ran on were pooled across policy
 * versions — which is precisely the contaminated analysis, reproduced by a
 * green test suite.
 *
 * So: no `drizzle-orm` mock and no `./db/schema` mock here (which rules out the
 * shared `_db-mock`, since it stubs the schema). Only the db *client* is
 * stubbed — nothing in this file executes a query — which lets the real drizzle
 * builders run and the real `PgDialect` render them to SQL text. Same technique
 * as `apps/web/src/lib/stale-workers-scope.test.ts`.
 */
mock.module('../db', () => ({
  db: {
    select: () => ({ from: () => ({ where: async () => [], limit: async () => [] }) }),
    selectDistinct: () => ({ from: () => ({ where: async () => [] }) }),
    insert: () => ({
      values: () => ({
        onConflictDoUpdate: async () => undefined,
        onConflictDoNothing: () => ({ returning: async () => [] }),
      }),
    }),
  },
}));

import * as source from '../memory-digest-readout-source';
import {
  compositionCohortScope,
  sessionScope,
  notifiedKey,
  READOUT_CACHE_KEY,
  READOUT_NOTIFIED_KEY_PREFIX,
  RECALL_TOOL,
} from '../memory-digest-readout-source';

const dialect = new PgDialect();

/** Rendered SQL, whitespace-collapsed and lower-cased (meaning, not phrasing). */
function render(fragment: any): string {
  return dialect.sqlToQuery(fragment).sql.replace(/\s+/g, ' ').trim().toLowerCase();
}

const TASK_IDS = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'];

describe('compositionCohortScope', () => {
  const sql = render(compositionCohortScope('memory-digest-v4'));

  it('filters on policy_version — the predicate that must never be missing', () => {
    // Pooling two policy versions is not a noisier comparison, it is a
    // meaningless one: a bump redefines the arms AND re-randomises assignment.
    expect(sql).toContain('"policy_version"');
    expect(sql).toMatch(/"policy_version" = \$\d/);
  });

  it('reads from the prompt-composition table and nothing else', () => {
    expect(sql).toContain('worker_prompt_composition_events');
    expect(sql).not.toContain('worker_action_events');
    expect(sql).not.toContain('"workers"');
  });

  it('drops builds with no task id rather than counting them as observations', () => {
    expect(sql).toContain('"task_id" is not null');
  });

  it('does NOT filter backend in SQL — the exclusion has to stay countable', () => {
    // Segmented in the pure layer instead, so "how many rows had no backend
    // recorded" is a number on the readout rather than rows that vanished.
    expect(sql).not.toContain('"backend"');
  });

  it('binds the policy version as a parameter, never interpolated', () => {
    const { params } = dialect.sqlToQuery(compositionCohortScope('memory-digest-v4') as any);
    expect(params).toContain('memory-digest-v4');
    expect(render(compositionCohortScope('memory-digest-v4'))).not.toContain('memory-digest-v4');
  });
});

describe('sessionScope', () => {
  const sql = render(sessionScope(TASK_IDS));

  it('scopes sessions to the cohort tasks', () => {
    expect(sql).toContain('"task_id" in');
    const { params } = dialect.sqlToQuery(sessionScope(TASK_IDS) as any);
    expect(params).toEqual(expect.arrayContaining(TASK_IDS));
  });

  it('excludes never-started workers, which would be fabricated observations', () => {
    // A never-started row is a claim-time bookkeeping artifact. Counted, it
    // adds a task with zero turns and zero reads to whichever arm it fell in.
    expect(sql).toContain('"started_at" is not null');
  });

  it('reads the workers table, not the event tables', () => {
    expect(sql).toContain('"task_id"');
    expect(sql).not.toContain('worker_prompt_composition_events');
  });
});

describe('recall is not sourced from worker_action_events', () => {
  it('exposes no action-table scope for recall, and names the tool it is counted under', () => {
    // `worker_action_events` records the bare action name off the `buildd` MCP
    // call. `recall` is a separate top-level tool, so it has never appeared
    // there — a scope filtering action='recall' returns zero rows in both arms
    // for ever and renders as a measured 0%. It is read off the session's tool
    // histogram instead, which keys on the fully-qualified name.
    expect(source).not.toHaveProperty('recallScope');
    expect(RECALL_TOOL).toBe('mcp__buildd__recall');
    expect(RECALL_TOOL).toContain('mcp__');
  });
});

describe('persistence keys', () => {
  it('keeps the readout row and the notification claim on separate keys', () => {
    // One row is a record that gets overwritten every run; the other is a
    // once-ever claim. Sharing a key would make each destroy the other.
    expect(notifiedKey('memory-digest-v4:powered')).not.toBe(READOUT_CACHE_KEY);
    expect(notifiedKey('memory-digest-v4:powered')).toStartWith(READOUT_NOTIFIED_KEY_PREFIX);
  });

  it('gives distinct verdicts distinct claims, so each pages once on its own', () => {
    expect(notifiedKey('memory-digest-v4:powered')).not.toBe(notifiedKey('memory-digest-v4:stalled'));
  });
});
