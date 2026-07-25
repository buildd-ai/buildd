/**
 * External links — the generic provider mapping between buildd's native tier
 * (initiatives → missions → tasks) and external work trackers (Linear, GitHub).
 *
 * Phase 1 of the Linear integration owns this layer: it makes a link *exist,
 * persist, and stay authenticated* — it does NOT read progress back (Phase 2) or
 * import the external graph (Phase 3).
 *
 * `builddEntityId` is polymorphic (points at one of three tables) so it carries no
 * cross-table FK — existence is enforced by callers on write and orphan rows are
 * harmless (filtered on read). The (provider, externalId) partial-unique index makes
 * the upsert idempotent while permitting many rows with a null externalId.
 *
 * Helpers accept `db` as a parameter so they're trivially testable with a mock; the
 * shared singleton is imported at call sites (`import { db } from './db/client'`).
 */

import { and, eq, sql } from 'drizzle-orm';
import { externalLinks, type ExternalLink } from './db/schema';

// Type-only reference to the shared drizzle instance — erased at runtime so tests can
// pass a mock db without pulling in ./db/client (and its config/env dependencies).
type Db = typeof import('./db/client').db;

export interface LinkExternalInput {
  teamId: string;
  provider: 'linear' | 'github';
  builddEntityType: 'initiative' | 'mission' | 'task';
  builddEntityId: string;
  externalId: string;
  externalUrl?: string | null;
  externalUpdatedAt?: Date | null;
}

/**
 * Idempotent upsert of an external link. Re-linking the same (provider, externalId)
 * updates the URL/watermark in place rather than inserting a duplicate row.
 *
 * The ON CONFLICT target matches the partial-unique index, so `targetWhere` MUST
 * carry the same predicate (`external_id IS NOT NULL`) for the conflict arbiter to
 * resolve against that index. No db.transaction() — neon-http doesn't support it.
 */
export async function linkExternal(db: Db, input: LinkExternalInput): Promise<ExternalLink> {
  const [row] = await db
    .insert(externalLinks)
    .values({
      teamId: input.teamId,
      provider: input.provider,
      builddEntityType: input.builddEntityType,
      builddEntityId: input.builddEntityId,
      externalId: input.externalId,
      externalUrl: input.externalUrl ?? null,
      externalUpdatedAt: input.externalUpdatedAt ?? null,
    })
    .onConflictDoUpdate({
      target: [externalLinks.provider, externalLinks.externalId],
      targetWhere: sql`external_id IS NOT NULL`,
      set: {
        externalUrl: input.externalUrl ?? null,
        externalUpdatedAt: input.externalUpdatedAt ?? null,
        updatedAt: sql`NOW()`,
      },
    })
    .returning();
  return row;
}

/** Reverse lookup — all links for a given buildd entity ("links for this mission"). */
export async function getLinksForEntity(
  db: Db,
  builddEntityType: 'initiative' | 'mission' | 'task',
  builddEntityId: string,
): Promise<ExternalLink[]> {
  return db
    .select()
    .from(externalLinks)
    .where(
      and(
        eq(externalLinks.builddEntityType, builddEntityType),
        eq(externalLinks.builddEntityId, builddEntityId),
      ),
    );
}

/** Look up the single link for a (provider, externalId) pair, or null if none. */
export async function findLinkByExternal(
  db: Db,
  provider: 'linear' | 'github',
  externalId: string,
): Promise<ExternalLink | null> {
  const [row] = await db
    .select()
    .from(externalLinks)
    .where(and(eq(externalLinks.provider, provider), eq(externalLinks.externalId, externalId)))
    .limit(1);
  return row ?? null;
}
