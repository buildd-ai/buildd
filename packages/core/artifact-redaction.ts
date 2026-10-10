import { sql } from 'drizzle-orm';
import { db } from './db';

/**
 * Remove a value (a leaked secret, personal data) from artifact bodies,
 * history included. Rewriting `artifacts.content` alone is not enough once
 * bodies have revisions: the revision trigger keeps the pre-redaction body
 * (and snapshots a legacy one on this very UPDATE), and the immutability
 * trigger refuses rewriting a revision. So the current body is rewritten,
 * which records a redacted revision, and then every revision still holding
 * the value is deleted. `strpos`, not LIKE: a `_` or `%` in the value must not
 * widen what is deleted.
 */
export async function redactArtifactText(value: string, replacement: string): Promise<{ bodies: number; revisionsDeleted: number }> {
  if (value.length < 4) throw new Error('refusing to redact a value shorter than 4 characters');
  const bodies = await db.execute(sql`
    UPDATE artifacts SET content = replace(content, ${value}, ${replacement})
    WHERE strpos(content, ${value}) > 0
    RETURNING id`);
  const deleted = await db.execute(sql`
    DELETE FROM artifact_revisions WHERE strpos(content, ${value}) > 0 RETURNING id`);
  const count = (r: unknown) => ((r as { rows?: unknown[] }).rows ?? []).length;
  return { bodies: count(bodies), revisionsDeleted: count(deleted) };
}
