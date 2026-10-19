import { describe, it, expect, vi, beforeEach } from 'vitest';

const selectRows = vi.fn();
vi.mock('@buildd/core/db', () => ({
  db: {
    query: { taskSchedules: { findFirst: vi.fn() }, workspaces: { findFirst: vi.fn() } },
    select: vi.fn(() => ({ from: () => ({ where: () => ({ limit: () => selectRows() }) }) })),
  },
}));
vi.mock('@/lib/auth-helpers', () => ({ getCurrentUser: vi.fn() }));
vi.mock('@/lib/api-auth', () => ({ authenticateApiKey: vi.fn() }));
vi.mock('@/lib/token-route-policy', () => ({ hasTokenRouteAdminAccess: vi.fn(() => true) }));
vi.mock('@/lib/team-access', () => ({ verifyWorkspaceAccess: vi.fn(), verifyAccountWorkspaceAccess: vi.fn() }));
vi.mock('@/lib/permissions', () => ({ can: vi.fn() }));
vi.mock('@/lib/schedule-move', () => ({
  validateScheduleMove: vi.fn(),
  applyScheduleMove: vi.fn(),
  keepScheduleHome: vi.fn(),
}));

import { POST } from './route';
import { db } from '@buildd/core/db';
import { getCurrentUser } from '@/lib/auth-helpers';
import { verifyWorkspaceAccess } from '@/lib/team-access';
import { can } from '@/lib/permissions';
import { applyScheduleMove, keepScheduleHome, validateScheduleMove } from '@/lib/schedule-move';
import { NextRequest } from 'next/server';

const HOME = '00000000-0000-0000-0000-000000000001';
const SCHEDULE = '00000000-0000-0000-0000-000000000002';
const TARGET = '00000000-0000-0000-0000-000000000003';
const PROPOSAL = '00000000-0000-0000-0000-000000000005';
const params = Promise.resolve({ id: HOME, scheduleId: SCHEDULE, proposalId: PROPOSAL });
const schedule = { id: SCHEDULE, workspaceId: HOME, delegation: null };
const proposal = { id: PROPOSAL, scheduleId: SCHEDULE, fromWorkspaceId: HOME, toWorkspaceId: TARGET, status: 'open', reason: 'r' };

const post = (body: unknown) => new NextRequest(`http://localhost/x`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

beforeEach(() => {
  vi.clearAllMocks();
  (getCurrentUser as any).mockResolvedValue({ id: 'user-1' });
  (verifyWorkspaceAccess as any).mockResolvedValue({ teamId: 'team', role: 'admin' });
  (db.query.workspaces.findFirst as any).mockResolvedValue({ teamId: 'team' });
  (db.query.taskSchedules.findFirst as any).mockResolvedValue(schedule);
  (can as any).mockResolvedValue(true);
  selectRows.mockResolvedValue([proposal]);
  (validateScheduleMove as any).mockResolvedValue({ ok: true, teamId: 'team' });
  (applyScheduleMove as any).mockResolvedValue({ schedule: { ...schedule, workspaceId: TARGET }, move: { ...proposal, status: 'accepted' } });
  (keepScheduleHome as any).mockResolvedValue({ ...proposal, status: 'kept' });
});

describe('POST move-proposal/[proposalId]', () => {
  it('AC-13: accepting moves the schedule through the one move path, tied to the proposal', async () => {
    const res = await POST(post({ decision: 'accept', grantOldHome: true }), { params });
    expect(res.status).toBe(200);
    expect(applyScheduleMove).toHaveBeenCalledWith(expect.objectContaining({ targetWorkspaceId: TARGET, proposalId: PROPOSAL, grantOldHome: true }));
  });

  it('AC-14: a person without delegate_schedule_access is refused and nothing is written', async () => {
    (can as any).mockResolvedValue(false);
    const res = await POST(post({ decision: 'accept' }), { params });
    expect(res.status).toBe(403);
    expect(applyScheduleMove).not.toHaveBeenCalled();
    expect(keepScheduleHome).not.toHaveBeenCalled();
  });

  it('AC-14: a target the move fails validation for (another team, no reach) writes nothing', async () => {
    (validateScheduleMove as any).mockResolvedValue({ ok: false, status: 403, error: 'You cannot create tasks in the target workspace' });
    const res = await POST(post({ decision: 'accept' }), { params });
    expect(res.status).toBe(403);
    expect(applyScheduleMove).not.toHaveBeenCalled();
  });

  it('keep leaves the schedule where it is', async () => {
    const res = await POST(post({ decision: 'keep' }), { params });
    expect(res.status).toBe(200);
    expect(keepScheduleHome).toHaveBeenCalled();
    expect(applyScheduleMove).not.toHaveBeenCalled();
  });

  it('an already answered proposal is a 409', async () => {
    selectRows.mockResolvedValue([{ ...proposal, status: 'kept' }]);
    expect((await POST(post({ decision: 'accept' }), { params })).status).toBe(409);
    expect(applyScheduleMove).not.toHaveBeenCalled();
  });

  it('a lost race on the schedule is a 409', async () => {
    (applyScheduleMove as any).mockResolvedValue(null);
    expect((await POST(post({ decision: 'accept' }), { params })).status).toBe(409);
  });

  it('rejects an unknown decision', async () => {
    expect((await POST(post({ decision: 'maybe' }), { params })).status).toBe(400);
  });
});
