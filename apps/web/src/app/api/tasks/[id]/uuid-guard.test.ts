/**
 * Every handler under /api/tasks/[id] must reject a non-UUID id before it
 * reaches the database — Postgres throws 22P02 comparing a short id to a uuid
 * column, which escapes as a 500. Same defect class as #2749 (workers/[id])
 * and #2958 (accounts/connectors/discrepancies/artifacts); see
 * @/lib/uuid-guard-checker for the shared structural check.
 *
 * Excluded from this generic scan, not unguarded:
 * - `route.ts` already had its own `validateTaskId` (distinguishes a UUID
 *   prefix from garbage and 400s with a specific message) for GET/PATCH; the
 *   DELETE handler was the actual gap and now reuses that same helper instead
 *   of introducing a second, inconsistent guard in the same file.
 * - `path-claim/route.ts` has its own `FULL_UUID_REGEX` check for the same
 *   reason.
 * - `error-traces/route.ts` deliberately accepts an 8+ char id PREFIX
 *   (resolved via `resolveTaskIdForCaller`), which already rejects anything
 *   that is neither a full UUID nor a valid hex prefix before querying.
 * - `reassign/route.ts`, `start/route.ts`, `workers/route.ts` are out of
 *   scope for this fix (not covered by task 5b47a423's slices).
 */
import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { uuidGuardViolations } from '@/lib/uuid-guard-checker';

const ROOT = import.meta.dir;

const ID_GUARDED_FILES = [
  'approve-plan/route.ts',
  'messages/route.ts',
  'notes/route.ts',
  'notes/[noteId]/reply/route.ts',
  'reject-plan/route.ts',
  'summary/route.ts',
];

describe('/api/tasks/[id] non-UUID guard', () => {
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
