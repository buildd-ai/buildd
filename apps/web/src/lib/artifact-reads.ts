import { after } from 'next/server';
import { db } from '@buildd/core/db';
import { artifactReads } from '@buildd/core/db/schema';

export type ArtifactReadRow = typeof artifactReads.$inferInsert;

/**
 * Record what an artifact read returned (schema: artifact_reads), after the
 * response. Never fails or delays the read; outside a request scope (tests)
 * it runs detached.
 */
export function recordArtifactRead(row: ArtifactReadRow): void {
  const write = async () => {
    try {
      await db.insert(artifactReads).values(row);
    } catch (err) {
      console.error('[artifact-reads] ledger write failed', err instanceof Error ? err.message : err);
    }
  };
  try {
    after(write);
  } catch {
    void write();
  }
}
