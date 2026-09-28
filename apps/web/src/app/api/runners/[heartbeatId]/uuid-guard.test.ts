/**
 * Every handler under /api/runners/[heartbeatId] must reject a non-UUID
 * heartbeat id before it reaches the database — Postgres throws 22P02
 * comparing a short id to a uuid column, which escapes as a 500. Same defect
 * class as #2749 (workers/[id]) and #2958
 * (accounts/connectors/discrepancies/artifacts); see @/lib/uuid-guard-checker
 * for the shared structural check.
 */
import { describe, it, expect } from 'bun:test';
import { readFileSync, readdirSync } from 'fs';
import { join, relative } from 'path';
import { uuidGuardViolations } from '@/lib/uuid-guard-checker';

function routeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? routeFiles(join(dir, e.name)) : e.name === 'route.ts' ? [join(dir, e.name)] : [],
  );
}

describe('/api/runners/[heartbeatId] non-UUID guard', () => {
  for (const file of routeFiles(import.meta.dir)) {
    it(`${relative(import.meta.dir, file)} checks isUuid(heartbeatId) before querying`, () => {
      expect(uuidGuardViolations(readFileSync(file, 'utf8'), 'heartbeatId')).toEqual([]);
    });
  }
});
