import { describe, expect, it } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { checkContextArtifactIds, contextArtifactsWhere, MAX_CONTEXT_ARTIFACT_IDS } from './context-artifact-ids';

// The access rules themselves run against real Postgres in
// apps/web/tests/db/context-artifact-ids.test.ts; this pins the rendered read
// predicate and the input checks that never reach the database.
describe('contextArtifactsWhere', () => {
  it('scopes the ids to workspaces of the team, with identifiers a relational query cannot re-alias', () => {
    const q = new PgDialect().sqlToQuery(contextArtifactsWhere(['a1', 'a2'], 'team-1'));
    expect(q.sql).toContain('"artifacts"."id" in ($1, $2)');
    expect(q.sql).toContain('in (select ctx_ws.id from workspaces ctx_ws where ctx_ws.team_id = $3)');
    expect(q.params).toEqual(['a1', 'a2', 'team-1']);
  });
});

describe('checkContextArtifactIds input', () => {
  const caller = { userId: 'u1' };
  it('absent is empty, and an empty array needs no lookup', async () => {
    expect(await checkContextArtifactIds(undefined, caller, 't')).toEqual({ ok: true, ids: [] });
    expect(await checkContextArtifactIds([], caller, 't')).toEqual({ ok: true, ids: [] });
  });
  it('refuses a non-array, a non-string id and too many ids', async () => {
    expect((await checkContextArtifactIds('x', caller, 't')).ok).toBe(false);
    expect((await checkContextArtifactIds([1], caller, 't')).ok).toBe(false);
    const many = Array.from({ length: MAX_CONTEXT_ARTIFACT_IDS + 1 }, (_, i) => `id-${i}`);
    expect((await checkContextArtifactIds(many, caller, 't')).ok).toBe(false);
  });
});
