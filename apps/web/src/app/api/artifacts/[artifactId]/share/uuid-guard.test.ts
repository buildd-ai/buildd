/**
 * Every handler in /api/artifacts/[artifactId]/share must reject a non-UUID
 * artifact id before it reaches the database — Postgres throws 22P02 comparing
 * a short id to a uuid column, which escapes as a 500. Same defect class as
 * #2749; see @/lib/uuid-guard-checker for the shared structural check.
 */
import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { uuidGuardViolations } from '@/lib/uuid-guard-checker';

const ROUTE_FILE = join(import.meta.dir, 'route.ts');

describe('/api/artifacts/[artifactId]/share non-UUID guard', () => {
  it('checks isUuid(artifactId) before querying in every handler', () => {
    expect(uuidGuardViolations(readFileSync(ROUTE_FILE, 'utf8'), 'artifactId')).toEqual([]);
  });
});
