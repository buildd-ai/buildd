import { describe, expect, it } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { historyEvidenceFrom, historyEvidenceQuery, eligibleEstimateTasksQuery } from '../task-estimate-evidence';

describe('frozen estimate history diagnostics', () => {
  it('distinguishes an empty repo from unavailable or unmeasured history', () => {
    expect(historyEvidenceFrom([])).toBeNull();
    expect(historyEvidenceFrom([{ total: '0', completed_work: '0', eligible: '0' }])).toEqual({ total: 0, completedWork: 0, eligible: 0, excluded: {} });
    expect(historyEvidenceFrom([{ total: '8', completed_work: '5', eligible: '2', not_completed_work: '3', outcome_after_cutoff: '1', missing_session_actuals: '1', invalid_tokens: '1' }])).toEqual({
      total: 8, completedWork: 5, eligible: 2,
      excluded: { not_completed_work: 3, outcome_after_cutoff: 1, missing_session_actuals: 1, invalid_tokens: 1 },
    });
  });
  it('scopes counts and selected samples identically without kind/role/model/recency filters', () => {
    const dialect = new PgDialect();
    const cutoff = new Date('2026-10-01T00:00:00Z');
    for (const query of [historyEvidenceQuery('workspace-example', cutoff), eligibleEstimateTasksQuery('workspace-example', cutoff)]) {
      const rendered = dialect.sqlToQuery(query);
      expect(rendered.params).toContain('workspace-example');
      expect(rendered.params).toContain(cutoff.toISOString());
      expect(rendered.sql).toContain('t.workspace_id =');
      expect(rendered.sql).toContain("t.task_class = 'work'");
      expect(rendered.sql).toContain("t.status = 'completed'");
      expect(rendered.sql).toContain('w.completed_at >=');
      expect(rendered.sql).toContain('tokens <= 0');
      expect(rendered.sql).not.toMatch(/role_slug|model|interval|t.kind/);
    }
  });
});
