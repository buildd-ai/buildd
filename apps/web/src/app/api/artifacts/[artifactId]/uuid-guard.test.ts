/**
 * Every handler in this file must reject a non-UUID artifact id before it
 * reaches the database. Same defect class as #2749's guard on
 * /api/workers/[id] — see ../../workers/[id]/uuid-guard.test.ts and
 * @/lib/uuid-guard-checker for the shared structural check.
 */
import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { uuidGuardViolations } from '@/lib/uuid-guard-checker';

const ROUTE_FILE = join(import.meta.dir, 'route.ts');

describe('/api/artifacts/[artifactId] non-UUID guard', () => {
  it('checks isUuid(artifactId) before querying in every handler', () => {
    expect(uuidGuardViolations(readFileSync(ROUTE_FILE, 'utf8'), 'artifactId')).toEqual([]);
  });
});
