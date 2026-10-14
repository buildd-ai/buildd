import { sql, type SQL } from 'drizzle-orm';

/**
 * The binding attachments revision `n` of a spec is approved with, as a SQL
 * expression for the approving statement (./approval.ts): one row per name
 * (the newest applying row), then binding only, each at its artifact's
 * revision at that moment. `[]` when there are none.
 */
export function approvedAttachmentsSql(specId: string, n: number): SQL {
  return sql`(
    SELECT coalesce(jsonb_agg(jsonb_build_object('attachmentId', x.id, 'name', x.name, 'artifactId', x.artifact_id, 'revision', x.current_revision) ORDER BY x.name), '[]'::jsonb)
    FROM (
      SELECT DISTINCT ON (sa.name) sa.id, sa.name, sa.kind, sa.artifact_id, ar.current_revision
      FROM spec_attachments sa JOIN artifacts ar ON ar.id = sa.artifact_id
      WHERE sa.spec_id = ${specId}::uuid AND sa.added_in_revision <= ${n}
        AND (sa.removed_from_revision IS NULL OR sa.removed_from_revision > ${n})
      ORDER BY sa.name, sa.created_at DESC
    ) x
    WHERE x.kind = 'binding'
  )`;
}
