/**
 * The artifact read ledger (apps/web/src/lib/artifact-reads.ts), against real
 * Postgres: a read records exactly what it returned, and a failing ledger
 * write never fails the read.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { assertDbConfigured, q, seedWorkspace } from './harness';

const { recordArtifactRead } = await import('../../src/lib/artifact-reads');

let workspaceId: string;
beforeAll(async () => {
  assertDbConfigured();
  ({ workspaceId } = await seedWorkspace());
});

const settle = async (artifactId: string) => {
  for (let i = 0; i < 50; i++) {
    const rows = await q<{ view: string; selector: unknown; returned_chars: number; total_chars: number; revision: number }>(
      sql`SELECT view, selector, returned_chars, total_chars, revision FROM artifact_reads WHERE artifact_id = ${artifactId}::uuid`);
    if (rows.length) return rows;
    await new Promise((r) => setTimeout(r, 20));
  }
  return [];
};

describe('recordArtifactRead', () => {
  test('records the view, selector and characters returned', async () => {
    const artifactId = crypto.randomUUID();
    recordArtifactRead({ artifactId, revision: 3, workspaceId, view: 'section', selector: { section: 's7' }, returnedChars: 3_210, totalChars: 650_000 });
    expect(await settle(artifactId)).toEqual([{ view: 'section', selector: { section: 's7' }, returned_chars: 3_210, total_chars: 650_000, revision: 3 }]);
  });

  test('a write that cannot land is swallowed, not thrown', async () => {
    expect(() => recordArtifactRead({ artifactId: 'not-a-uuid', revision: 1, view: 'full', returnedChars: 1, totalChars: 1 })).not.toThrow();
    await new Promise((r) => setTimeout(r, 100));
  });
});
