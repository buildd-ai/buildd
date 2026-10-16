import { db } from '@buildd/core/db';
import { artifacts } from '@buildd/core/db/schema';
import { sql } from 'drizzle-orm';

const SHORT_ID = /^[0-9a-f]{8}$/i;

export type ArtifactShortId = { state: 'none' } | { state: 'one'; id: string } | { state: 'ambiguous' };

/**
 * The first 8 hex characters of an artifact id, as a brief cites it. It
 * resolves among the artifacts `canRead` accepts (the caller's own access
 * check), so an artifact the caller cannot reach neither makes the prefix
 * ambiguous nor shows through as a different answer.
 */
export async function resolveArtifactShortId(value: string, canRead: (id: string) => Promise<boolean>): Promise<ArtifactShortId> {
  if (!SHORT_ID.test(value)) return { state: 'none' };
  const hits = await db.select({ id: artifacts.id }).from(artifacts)
    .where(sql`${artifacts.id}::text LIKE ${`${value.toLowerCase()}%`}`).limit(20);
  const visible: string[] = [];
  for (const h of hits) if (await canRead(h.id)) visible.push(h.id);
  if (visible.length > 1) return { state: 'ambiguous' };
  return visible.length === 1 ? { state: 'one', id: visible[0]! } : { state: 'none' };
}
