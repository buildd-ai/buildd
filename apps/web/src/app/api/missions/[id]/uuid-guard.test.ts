/**
 * Every handler under /api/missions/[id] must reject a non-UUID id before it
 * reaches the database — Postgres throws 22P02 comparing a short id to a uuid
 * column, which escapes as a 500. Same defect class as #2749 (workers/[id])
 * and #2958 (accounts/connectors/discrepancies/artifacts); see
 * @/lib/uuid-guard-checker for the shared structural check.
 *
 * `notes/route.ts` is deliberately excluded — task 632ef2f1's branch owns that
 * file and it is not guarded here.
 */
import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { uuidGuardViolations } from '@/lib/uuid-guard-checker';

const ROOT = import.meta.dir;

const ID_GUARDED_FILES = [
  'route.ts',
  'artifacts/route.ts',
  'artifacts/content/route.ts',
  'evaluate/route.ts',
  'link/route.ts',
  'reconcile/route.ts',
  'run/route.ts',
  'tracker-progress/route.ts',
  'notes/[noteId]/reply/route.ts',
];

describe('/api/missions/[id] non-UUID guard', () => {
  for (const rel of ID_GUARDED_FILES) {
    it(`${rel} checks isUuid(id) before querying`, () => {
      const src = readFileSync(join(ROOT, rel), 'utf8');
      expect(uuidGuardViolations(src, 'id')).toEqual([]);
    });
  }

  it('notes/[noteId]/reply/route.ts also checks isUuid(noteId) before querying', () => {
    const src = readFileSync(join(ROOT, 'notes/[noteId]/reply/route.ts'), 'utf8');
    expect(uuidGuardViolations(src, 'noteId')).toEqual([]);
  });
});
