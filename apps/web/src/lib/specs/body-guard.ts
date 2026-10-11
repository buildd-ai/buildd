import { db } from '@buildd/core/db';
import { specs } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';

/**
 * A spec's body is an artifact (specs.body_artifact_id), but it changes only
 * through a spec revise: that write moves the body, the spec version and the
 * revision that pins the body in one statement. A generic artifact write would
 * move the body alone, and every later revise would be refused, so generic
 * write paths refuse a spec body (writeArtifactBody, PATCH /api/artifacts/[id]).
 */
export const SPEC_BODY_WRITE_REFUSED =
  'This artifact is the body of a Living Spec. Change it with manage_specs action=revise (or PATCH /api/specs/[specId]), which keeps the spec version, its revisions and its approval in step.';

/** The spec whose body this artifact is, or null for any other artifact. */
export async function specIdForBodyArtifact(artifactId: string): Promise<string | null> {
  const [row] = await db.select({ id: specs.id }).from(specs).where(eq(specs.bodyArtifactId, artifactId)).limit(1);
  return row?.id ?? null;
}
