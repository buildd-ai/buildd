/**
 * Every handler covered here must reject a non-UUID id before it reaches the
 * database — Postgres throws 22P02 comparing a short id to a uuid column,
 * which escapes as a 500. Same defect class as #2749 (workers/[id]) and #2958
 * (accounts/connectors/discrepancies/artifacts); see @/lib/uuid-guard-checker
 * for the shared structural check.
 *
 * Scoped to `route.ts` and `invitations/[invitationId]/route.ts` (task
 * 5b47a423 slice 4). `notifications/route.ts`, `backend-readiness/route.ts`,
 * `members/route.ts`, `invitations/route.ts` and `members/[userId]/route.ts`
 * are out of scope for this slice — not guarded here.
 */
import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { uuidGuardViolations } from '@/lib/uuid-guard-checker';

const ROOT = import.meta.dir;

describe('/api/teams/[id] non-UUID guard', () => {
  it('route.ts checks isUuid(id) before querying', () => {
    const src = readFileSync(join(ROOT, 'route.ts'), 'utf8');
    expect(uuidGuardViolations(src, 'id')).toEqual([]);
  });

  it('litellm-gateway/route.ts checks isUuid before querying', () => {
    const src = readFileSync(join(ROOT, 'litellm-gateway/route.ts'), 'utf8');
    expect(uuidGuardViolations(src, 'id')).toEqual([]);
  });

  it('ownership/route.ts checks isUuid(id) before querying', () => {
    const src = readFileSync(join(ROOT, 'ownership/route.ts'), 'utf8');
    expect(uuidGuardViolations(src, 'id')).toEqual([]);
  });

  it('invitations/[invitationId]/route.ts checks isUuid(id) before querying', () => {
    const src = readFileSync(join(ROOT, 'invitations/[invitationId]/route.ts'), 'utf8');
    expect(uuidGuardViolations(src, 'id')).toEqual([]);
  });

  it('invitations/[invitationId]/route.ts also checks isUuid(invitationId) before querying', () => {
    const src = readFileSync(join(ROOT, 'invitations/[invitationId]/route.ts'), 'utf8');
    expect(uuidGuardViolations(src, 'invitationId')).toEqual([]);
  });
});
