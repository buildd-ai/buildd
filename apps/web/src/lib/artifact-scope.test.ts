import { describe, it, expect } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { reviewArtifactScope, workspaceArtifactScope } from './artifact-scope';

/**
 * SQL-level tests for the artifact scoping predicates.
 *
 * No `drizzle-orm` mock and no schema mock here, and nothing in this file
 * executes a query: the real builders run and the real `PgDialect` renders
 * them, so the *columns* a predicate is keyed on are observable. Mocking `db`
 * (the usual shortcut) makes every WHERE clause unobservable — which is
 * exactly how the worker-only artifact scope survived unnoticed.
 */
const dialect = new PgDialect();

function render(fragment: any): { sql: string; params: unknown[] } {
  const q = dialect.sqlToQuery(fragment);
  return { sql: q.sql.replace(/\s+/g, ' ').trim().toLowerCase(), params: q.params };
}

describe('workspaceArtifactScope — tenancy', () => {
  // Resolves the worker arm in SQL: the /app/artifacts page used to load
  // every worker in the user's workspaces just to build that arm.
  it('reaches non-worker artifacts through workspace_id, not only worker_id', () => {
    // The original bug: a worker-only scope. Mission- and initiative-level
    // artifacts have worker_id NULL, so they could never appear.
    const { sql } = render(workspaceArtifactScope(['ws-1', 'ws-2']));
    expect(sql).toContain('"artifacts"."workspace_id" in');
    expect(sql).toContain('"artifacts"."worker_id" in');
    expect(sql).toContain(' or ');
  });

  it('binds only the caller-supplied workspace ids — no unanchored arm', () => {
    // Every OR arm must be anchored to an id the caller vouched for. An arm
    // like `mission_id is not null` would return another team's artifacts.
    const { sql, params } = render(workspaceArtifactScope(['ws-1', 'ws-2']));
    expect(params).toEqual(['ws-1', 'ws-2', 'ws-1', 'ws-2']);
    expect(sql).not.toContain('mission_id');
    expect(sql).not.toContain('initiative_id');
    expect(sql).not.toContain('is not null');
  });

  it('anchors both arms to the caller-supplied workspaces via a workers subquery', () => {
    // Full-shape lock, deliberately exact: no arm can be added without this
    // assertion failing.
    const { sql, params } = render(workspaceArtifactScope(['ws-mine']));
    expect(sql).toBe(
      '("artifacts"."workspace_id" in ($1) or "artifacts"."worker_id" in (select "workers"."id" from "workers" where "workers"."workspace_id" in ($2)))',
    );
    expect(params).toEqual(['ws-mine', 'ws-mine']);
  });

  it('matches nothing when the user has no accessible workspaces', () => {
    const { sql, params } = render(workspaceArtifactScope([]));
    expect(sql).toBe('false');
    expect(params).toEqual([]);
  });
});

describe('reviewArtifactScope — SQL mirror of isReviewArtifact', () => {
  it('admits review-shaped types, public rows, and keyed/container-scoped rows', () => {
    const { sql, params } = render(reviewArtifactScope());
    expect(sql).toMatch(/"artifacts"\."visibility" = \$\d+/);
    expect(params).toContain('public');
    expect(sql).toContain('"artifacts"."type" in');
    expect(sql).toContain('"artifacts"."key" is not null');
    expect(sql).toContain('"artifacts"."mission_id" is not null');
    expect(sql).toContain('"artifacts"."initiative_id" is not null');
  });

  it('excludes byproduct types from the keyed/container arm', () => {
    const { sql } = render(reviewArtifactScope());
    expect(sql).toContain('"artifacts"."type" not in');
  });

  it('carries the type lists from the shared prominence constants', async () => {
    const { REVIEW_ARTIFACT_TYPES, BYPRODUCT_ARTIFACT_TYPES } = await import('./artifact-prominence');
    const { params } = render(reviewArtifactScope());
    for (const t of [...REVIEW_ARTIFACT_TYPES, ...BYPRODUCT_ARTIFACT_TYPES]) {
      expect(params).toContain(t);
    }
  });
});
