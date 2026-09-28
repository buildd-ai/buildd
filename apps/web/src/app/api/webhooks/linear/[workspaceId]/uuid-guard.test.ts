/**
 * POST must reject a non-UUID workspaceId before it reaches the database —
 * Postgres throws 22P02 comparing a short id to a uuid column, which escapes
 * as a 500. Same defect class as #2749 (workers/[id]) and #2958
 * (accounts/connectors/discrepancies/artifacts); see @/lib/uuid-guard-checker
 * for the shared structural check.
 *
 * This is an external webhook (Linear), not a buildd API consumer — 404 is
 * still the right answer here: the route already returns the identical
 * `{ error: 'Unknown workspace' }` 404 for a well-formed but unrecognized
 * workspace id, so a malformed one gets the same treatment instead of a new
 * response shape. Linear does not retry a 404.
 */
import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { uuidGuardViolations } from '@/lib/uuid-guard-checker';

const ROUTE_FILE = join(import.meta.dir, 'route.ts');

describe('/api/webhooks/linear/[workspaceId] non-UUID guard', () => {
  it('checks isUuid(workspaceId) before querying in every handler', () => {
    expect(uuidGuardViolations(readFileSync(ROUTE_FILE, 'utf8'), 'workspaceId')).toEqual([]);
  });
});
