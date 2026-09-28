import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockRequireSessionUser = mock(() => Promise.resolve(null as any));
mock.module('@/lib/auth-helpers', () => ({ requireSessionUser: mockRequireSessionUser }));

const mockTeamMembersFindFirst = mock(() => null as any);
const mockTeamInvitationsFindFirst = mock(() => null as any);
let deleteCalls = 0;

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      teamMembers: { findFirst: mockTeamMembersFindFirst },
      teamInvitations: { findFirst: mockTeamInvitationsFindFirst },
    },
    delete: () => ({ where: () => { deleteCalls++; return Promise.resolve(); } }),
  },
}));
mock.module('drizzle-orm', () => ({
  eq: (a: any, b: any) => ({ type: 'eq', a, b }),
  and: (...args: any[]) => ({ type: 'and', args }),
}));
mock.module('@buildd/core/db/schema', () => ({
  teamInvitations: { id: 'id', teamId: 'teamId' },
  teamMembers: { teamId: 'teamId', userId: 'userId' },
}));

import { DELETE } from './route';

const TEAM_ID = '11111111-1111-4111-8111-111111111111';
const INVITATION_ID = '22222222-2222-4222-8222-222222222222';

const req = () => new NextRequest('http://localhost:3000/api/teams/x/invitations/y', { method: 'DELETE' });
const ctx = (id: string, invitationId: string) => ({ params: Promise.resolve({ id, invitationId }) });

beforeEach(() => {
  mockRequireSessionUser.mockReset();
  mockTeamMembersFindFirst.mockReset();
  mockTeamInvitationsFindFirst.mockReset();
  deleteCalls = 0;

  mockRequireSessionUser.mockResolvedValue({ user: { id: 'user-1' } });
  mockTeamMembersFindFirst.mockResolvedValue({ teamId: TEAM_ID, userId: 'user-1', role: 'admin' });
  mockTeamInvitationsFindFirst.mockResolvedValue({ id: INVITATION_ID, teamId: TEAM_ID });
});

describe('DELETE /api/teams/[id]/invitations/[invitationId]', () => {
  it('returns 404 for a non-UUID team id without querying the db', async () => {
    const res = await DELETE(req(), ctx('not-a-uuid', INVITATION_ID));
    expect(res.status).toBe(404);
    expect(mockRequireSessionUser).not.toHaveBeenCalled();
    expect(mockTeamMembersFindFirst).not.toHaveBeenCalled();
  });

  it('returns 404 for a non-UUID invitation id without querying the db', async () => {
    const res = await DELETE(req(), ctx(TEAM_ID, 'not-a-uuid'));
    expect(res.status).toBe(404);
    expect(mockRequireSessionUser).not.toHaveBeenCalled();
    expect(mockTeamMembersFindFirst).not.toHaveBeenCalled();
  });

  it('revokes the invitation', async () => {
    const res = await DELETE(req(), ctx(TEAM_ID, INVITATION_ID));
    expect(res.status).toBe(200);
    expect(deleteCalls).toBe(1);
  });
});
