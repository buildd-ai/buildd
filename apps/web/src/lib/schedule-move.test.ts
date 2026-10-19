import { describe, it, expect, vi } from 'vitest';

vi.mock('@buildd/core/db', () => ({ db: {} }));
vi.mock('./caller-cache', () => ({ clearCallerCache: vi.fn(), callerDep: { workspaceSchedules: (id: string) => `schedules:${id}` } }));

import { delegationAfterMove } from './schedule-move';

const A = '00000000-0000-0000-0000-00000000000a';
const B = '00000000-0000-0000-0000-00000000000b';
const C = '00000000-0000-0000-0000-00000000000c';
const actor = { userId: 'u1', accountId: null, now: new Date('2026-10-19T00:00:00Z') };
const grant = (workspaceId: string, capabilities: string[]) => ({ workspaceId, capabilities });
const delegation = (grants: unknown[]) => ({ grants, grantedByUserId: 'old', grantedByAccountId: null, grantedAt: '2026-01-01T00:00:00.000Z' });

describe('delegationAfterMove (I-27)', () => {
  it('drops the grant that names the new home, keeps the rest and their granter', () => {
    const out = delegationAfterMove(delegation([grant(B, ['analytics:read']), grant(C, ['tasks:create'])]), { from: A, to: B, grantOldHome: false }, actor);
    expect(out?.grants).toEqual([grant(C, ['tasks:create'])]);
    expect(out?.grantedByUserId).toBe('old');
  });

  it('is null when nothing is left', () => {
    expect(delegationAfterMove(delegation([grant(B, ['analytics:read'])]), { from: A, to: B, grantOldHome: false }, actor)).toBeNull();
    expect(delegationAfterMove(null, { from: A, to: B, grantOldHome: false }, actor)).toBeNull();
  });

  it('accept + read grant keeps the old home readable, stamped by the person who accepted', () => {
    const out = delegationAfterMove(null, { from: A, to: B, grantOldHome: true }, actor);
    expect(out?.grants).toEqual([grant(A, ['analytics:read'])]);
    expect(out?.grantedByUserId).toBe('u1');
    expect(out?.grantedAt).toBe('2026-10-19T00:00:00.000Z');
  });

  it('adds analytics:read to an existing grant on the old home without losing its capabilities', () => {
    const out = delegationAfterMove(delegation([grant(A, ['tasks:create'])]), { from: A, to: B, grantOldHome: true }, actor);
    expect(out?.grants).toEqual([grant(A, ['tasks:create', 'analytics:read'])]);
  });
});
