import { db } from '@buildd/core/db';
import { artifacts } from '@buildd/core/db/schema';
import { sql } from 'drizzle-orm';

const SHORT_ID = /^[0-9a-f]{8}$/i;

export type ArtifactShortId = { state: 'none' } | { state: 'one'; id: string } | { state: 'ambiguous' };

/** The first 8 hex characters of an artifact id, as a brief cites it. Callers still run their own access checks on the id returned. */
export async function resolveArtifactShortId(value: string): Promise<ArtifactShortId> {
  if (!SHORT_ID.test(value)) return { state: 'none' };
  const hits = await db.select({ id: artifacts.id }).from(artifacts)
    .where(sql`${artifacts.id}::text LIKE ${`${value.toLowerCase()}%`}`).limit(2);
  if (hits.length > 1) return { state: 'ambiguous' };
  return hits.length === 1 ? { state: 'one', id: hits[0]!.id } : { state: 'none' };
}
