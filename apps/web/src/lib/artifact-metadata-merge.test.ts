import { describe, expect, it } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { artifactMetadataMergeSql, mergeArtifactMetadata } from './artifact-metadata-merge';

/**
 * The artifact PATCH merges metadata in SQL, against the row as the UPDATE
 * sees it, so two overlapping PATCHes of one shot (an auditor qa.fixTaskId
 * link and a caption edit) cannot lose either update. Rendered through
 * PgDialect: a mocked db would hide the expression entirely.
 */
const dialect = new PgDialect();
const render = (patch: Record<string, unknown>) => {
  const q = dialect.sqlToQuery(artifactMetadataMergeSql(patch));
  return { sql: q.sql.replace(/\s+/g, ' ').trim(), params: q.params };
};

describe('artifactMetadataMergeSql', () => {
  it('merges onto the stored column in SQL, not onto a value read earlier', () => {
    const { sql, params } = render({ note: 'x' });
    expect(sql).toContain('"artifacts"."metadata"');
    expect(sql).toContain('||');
    expect(sql).toMatch(/jsonb_typeof\("artifacts"\."metadata"\) = 'object'/);
    expect(sql).not.toContain('jsonb_set');
    expect(params).toEqual([JSON.stringify({ note: 'x' })]);
  });

  it('deep-merges qa one level with jsonb_set over the stored qa object', () => {
    const { sql, params } = render({ qa: { fixTaskId: 'fix-1' }, filename: 'a.png' });
    expect(sql).toContain("jsonb_set(");
    expect(sql).toContain("'{qa}'");
    expect(sql).toContain(`"artifacts"."metadata" -> 'qa'`);
    expect(params).toEqual([JSON.stringify({ qa: { fixTaskId: 'fix-1' }, filename: 'a.png' }), JSON.stringify({ fixTaskId: 'fix-1' })]);
  });

  it('replaces qa outright when the patch qa is not an object', () => {
    const { sql } = render({ qa: null });
    expect(sql).not.toContain('jsonb_set');
  });
});

describe('mergeArtifactMetadata (the same semantics, in JS)', () => {
  const stored = { qa: { route: '/a', viewport: 'mobile', finding: 'f', verdict: 'issue' }, filename: 'a.png' };
  it('keeps route, viewport, finding and filename on a qa.fixTaskId patch', () => {
    expect(mergeArtifactMetadata(stored, { qa: { fixTaskId: 'fix-1' } })).toEqual({
      qa: { route: '/a', viewport: 'mobile', finding: 'f', verdict: 'issue', fixTaskId: 'fix-1' },
      filename: 'a.png',
    });
  });
  it('shallow-merges top-level keys and treats non-object stored metadata as empty', () => {
    expect(mergeArtifactMetadata(stored, { filename: 'b.png' }).filename).toBe('b.png');
    expect(mergeArtifactMetadata(null, { qa: { fixTaskId: 'x' } })).toEqual({ qa: { fixTaskId: 'x' } });
  });
});
