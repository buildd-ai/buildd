import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@buildd/core/db', () => ({
  db: {
    query: {
      taskSchedules: {
        findFirst: vi.fn(),
      },
      workspaces: {
        findFirst: vi.fn(),
        findMany: vi.fn(),
      },
      // Read by the real permission check (lib/permissions.ts): the caller's
      // team roles and the team's permission overrides.
      teamMembers: { findMany: vi.fn(async () => []) },
      teams: { findFirst: vi.fn(async () => null) },
    },
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(),
        })),
      })),
    })),
    delete: vi.fn(() => ({
      where: vi.fn(() => ({
        returning: vi.fn(),
      })),
    })),
  },
}));

vi.mock('@/lib/auth-helpers', () => ({
  getCurrentUser: vi.fn(),
}));

vi.mock('@/lib/api-auth', () => ({
  authenticateApiKey: vi.fn(),
}));

vi.mock('@/lib/team-access', () => ({
  verifyWorkspaceAccess: vi.fn(),
  verifyAccountWorkspaceAccess: vi.fn(),
}));

vi.mock('@/lib/schedule-helpers', () => ({
  validateCronExpression: vi.fn(),
  computeNextRunAt: vi.fn(),
}));

import { GET, PATCH, DELETE } from './route';
import { db } from '@buildd/core/db';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { verifyWorkspaceAccess, verifyAccountWorkspaceAccess } from '@/lib/team-access';
import { validateCronExpression, computeNextRunAt } from '@/lib/schedule-helpers';
import { NextRequest } from 'next/server';

const WORKSPACE_ID = '00000000-0000-0000-0000-000000000001';
const SCHEDULE_ID = '00000000-0000-0000-0000-000000000002';

function makeRequest(method: string, body?: unknown, authHeader?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (authHeader) headers['authorization'] = authHeader;

  return new NextRequest(`http://localhost/api/workspaces/${WORKSPACE_ID}/schedules/${SCHEDULE_ID}`, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

const params = Promise.resolve({ id: WORKSPACE_ID, scheduleId: SCHEDULE_ID });

const mockSchedule = {
  id: SCHEDULE_ID,
  workspaceId: WORKSPACE_ID,
  name: 'Test Schedule',
  cronExpression: '0 * * * *',
  timezone: 'UTC',
  enabled: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  (db.query.taskSchedules.findFirst as any).mockResolvedValue(mockSchedule);
  (validateCronExpression as any).mockReturnValue(null);
  (computeNextRunAt as any).mockReturnValue(new Date('2026-04-01T00:00:00Z'));
});

function mockSessionUser() {
  (getCurrentUser as any).mockResolvedValue({ id: 'user-1' });
  (verifyWorkspaceAccess as any).mockResolvedValue(true);
}

function mockAdminApiKey() {
  (getCurrentUser as any).mockResolvedValue(null);
  (authenticateApiKey as any).mockResolvedValue({ id: 'account-1', teamId: 'team-1', level: 'admin' });
  (verifyAccountWorkspaceAccess as any).mockResolvedValue(true);
}

/** The session user's role in team-1, and team-1's permission overrides. */
function teamRole(role: 'owner' | 'admin' | 'member', overrides: Record<string, string[]> | null = null) {
  (db.query.teamMembers.findMany as any).mockResolvedValue([{ teamId: 'team-1', role }]);
  (db.query.teams.findFirst as any).mockResolvedValue({ id: 'not-a-personal-team', permissionOverrides: overrides });
}

function mockNoAuth() {
  (getCurrentUser as any).mockResolvedValue(null);
  (authenticateApiKey as any).mockResolvedValue(null);
}

function mockDbUpdate(returnValue: unknown) {
  const returning = vi.fn().mockResolvedValue([returnValue]);
  const where = vi.fn(() => ({ returning }));
  const set = vi.fn(() => ({ where }));
  (db.update as any).mockReturnValue({ set });
  return { set, where, returning };
}

describe('GET /schedules/[scheduleId]', () => {
  it('returns 401 for unauthenticated requests', async () => {
    mockNoAuth();
    const res = await GET(makeRequest('GET'), { params });
    expect(res.status).toBe(401);
  });

  it('returns 404 when schedule not found', async () => {
    mockSessionUser();
    (db.query.taskSchedules.findFirst as any).mockResolvedValue(null);
    const res = await GET(makeRequest('GET'), { params });
    expect(res.status).toBe(404);
  });

  it('returns schedule for authenticated user', async () => {
    mockSessionUser();
    const res = await GET(makeRequest('GET'), { params });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.schedule.id).toBe(SCHEDULE_ID);
  });

  describe('per-task token', () => {
    const scoped = (workspaceId: string) => ({
      id: 'account-1', level: 'worker', taskScope: { taskId: 't-1', workspaceId, expiresAt: Date.now() + 60_000 },
    });

    it('reads a schedule in its own task’s workspace', async () => {
      (getCurrentUser as any).mockResolvedValue(null);
      (authenticateApiKey as any).mockResolvedValue(scoped(WORKSPACE_ID));
      (verifyAccountWorkspaceAccess as any).mockResolvedValue(true);
      const res = await GET(makeRequest('GET', undefined, 'Bearer bld_x'), { params });
      expect(res.status).toBe(200);
    });

    it('refuses a schedule in another workspace the account reaches, without reading it', async () => {
      (getCurrentUser as any).mockResolvedValue(null);
      (authenticateApiKey as any).mockResolvedValue(scoped('00000000-0000-0000-0000-000000000009'));
      (verifyAccountWorkspaceAccess as any).mockResolvedValue(true);
      const res = await GET(makeRequest('GET', undefined, 'Bearer bld_x'), { params });
      expect(res.status).toBe(401);
      expect(db.query.taskSchedules.findFirst).not.toHaveBeenCalled();
    });
  });
});

describe('PATCH /schedules/[scheduleId]', () => {
  it('returns 401 for unauthenticated requests', async () => {
    mockNoAuth();
    const res = await PATCH(makeRequest('PATCH', { enabled: false }), { params });
    expect(res.status).toBe(401);
  });

  it('returns 404 when schedule not found', async () => {
    mockSessionUser();
    (db.query.taskSchedules.findFirst as any).mockResolvedValue(null);
    const res = await PATCH(makeRequest('PATCH', { enabled: false }), { params });
    expect(res.status).toBe(404);
  });

  it('updates enabled field on an existing schedule', async () => {
    mockSessionUser();
    const updatedSchedule = { ...mockSchedule, enabled: false };
    const dbMock = mockDbUpdate(updatedSchedule);

    const res = await PATCH(makeRequest('PATCH', { enabled: false }), { params });
    expect(res.status).toBe(200);

    const setArg = dbMock.set.mock.calls[0][0];
    expect(setArg.enabled).toBe(false);
    expect(setArg.nextRunAt).toBeNull();
  });

  it('updates cron expression and recomputes nextRunAt', async () => {
    mockSessionUser();
    const updatedSchedule = { ...mockSchedule, cronExpression: '0 */2 * * *' };
    const dbMock = mockDbUpdate(updatedSchedule);

    const res = await PATCH(makeRequest('PATCH', { cronExpression: '0 */2 * * *' }), { params });
    expect(res.status).toBe(200);

    const setArg = dbMock.set.mock.calls[0][0];
    expect(setArg.cronExpression).toBe('0 */2 * * *');
    expect(setArg.nextRunAt).toEqual(new Date('2026-04-01T00:00:00Z'));
  });

  it('returns 400 for invalid cron expression', async () => {
    mockSessionUser();
    (validateCronExpression as any).mockReturnValue('Invalid expression');

    const res = await PATCH(makeRequest('PATCH', { cronExpression: 'bad' }), { params });
    expect(res.status).toBe(400);
  });

  it('resets failures when re-enabling a disabled schedule', async () => {
    mockSessionUser();
    const disabledSchedule = { ...mockSchedule, enabled: false };
    (db.query.taskSchedules.findFirst as any).mockResolvedValue(disabledSchedule);
    const dbMock = mockDbUpdate({ ...disabledSchedule, enabled: true });

    const res = await PATCH(makeRequest('PATCH', { enabled: true }), { params });
    expect(res.status).toBe(200);

    const setArg = dbMock.set.mock.calls[0][0];
    expect(setArg.enabled).toBe(true);
    expect(setArg.consecutiveFailures).toBe(0);
    expect(setArg.lastError).toBeNull();
  });

  it('allows admin API key', async () => {
    mockAdminApiKey();
    mockDbUpdate({ ...mockSchedule, enabled: false });

    const res = await PATCH(
      makeRequest('PATCH', { enabled: false }, 'Bearer admin-key'),
      { params },
    );
    expect(res.status).toBe(200);
  });
});

describe('PATCH delegation (explicit cross-workspace reach for the schedule\'s tasks)', () => {
  const TARGET = '00000000-0000-0000-0000-0000000000aa';
  const OTHER_TEAM_WS = '00000000-0000-0000-0000-0000000000bb';
  const grant = { grants: [{ workspaceId: TARGET, capabilities: ['analytics:read', 'tasks:create'] }] };

  beforeEach(() => {
    (db.query.workspaces.findFirst as any).mockResolvedValue({ teamId: 'team-1' });
    (db.query.workspaces.findMany as any).mockResolvedValue([
      { id: TARGET, teamId: 'team-1' },
      { id: OTHER_TEAM_WS, teamId: 'team-2' },
    ]);
  });

  it('a team admin grants it, and the row records who and when', async () => {
    mockSessionUser();
    teamRole('admin');
    const { set } = mockDbUpdate({ ...mockSchedule });
    const res = await PATCH(makeRequest('PATCH', { delegation: grant }), { params });
    expect(res.status).toBe(200);
    const written = (set.mock.calls[0] as any)[0].delegation;
    expect(written.grants).toEqual(grant.grants);
    expect(written.grantedByUserId).toBe('user-1');
    expect(typeof written.grantedAt).toBe('string');
  });

  it('an admin cannot grant it once delegate_schedule_access is owner-only', async () => {
    mockSessionUser();
    teamRole('admin', { delegate_schedule_access: ['owner'] });
    mockDbUpdate({ ...mockSchedule });
    const res = await PATCH(makeRequest('PATCH', { delegation: grant }), { params });
    expect(res.status).toBe(403);
    expect(db.update).not.toHaveBeenCalled();
  });

  it('a member grants it once delegate_schedule_access is granted to members', async () => {
    mockSessionUser();
    teamRole('member', { delegate_schedule_access: ['owner', 'admin', 'member'] });
    const { set } = mockDbUpdate({ ...mockSchedule });
    const res = await PATCH(makeRequest('PATCH', { delegation: grant }), { params });
    expect(res.status).toBe(200);
    expect((set.mock.calls[0] as any)[0].delegation.grants).toEqual(grant.grants);
  });

  it('an admin key of another team cannot grant it', async () => {
    mockAdminApiKey();
    (authenticateApiKey as any).mockResolvedValue({ id: 'account-1', teamId: 'team-2', level: 'admin' });
    const res = await PATCH(makeRequest('PATCH', { delegation: grant }, 'Bearer bld_admin'), { params });
    expect(res.status).toBe(403);
    expect(db.update).not.toHaveBeenCalled();
  });

  it('a team member who is not admin cannot grant it', async () => {
    mockSessionUser();
    teamRole('member');
    const res = await PATCH(makeRequest('PATCH', { delegation: grant }), { params });
    expect(res.status).toBe(403);
    expect(db.update).not.toHaveBeenCalled();
  });

  it('never reaches another team', async () => {
    mockSessionUser();
    teamRole('admin');
    const res = await PATCH(makeRequest('PATCH', {
      delegation: { grants: [{ workspaceId: OTHER_TEAM_WS, capabilities: ['analytics:read'] }] },
    }), { params });
    expect(res.status).toBe(400);
    expect(db.update).not.toHaveBeenCalled();
  });

  it('refuses a capability outside the delegation vocabulary', async () => {
    mockSessionUser();
    teamRole('admin');
    for (const capability of ['admin', 'secrets', 'tasks:write']) {
      const res = await PATCH(makeRequest('PATCH', {
        delegation: { grants: [{ workspaceId: TARGET, capabilities: [capability] }] },
      }), { params });
      expect(res.status).toBe(400);
    }
    expect(db.update).not.toHaveBeenCalled();
  });

  it('the granter must reach the target itself', async () => {
    mockAdminApiKey();
    teamRole('admin');
    (verifyAccountWorkspaceAccess as any).mockImplementation(async (_a: string, ws: string) => ws === WORKSPACE_ID);
    const res = await PATCH(makeRequest('PATCH', { delegation: grant }, 'Bearer bld_admin'), { params });
    expect(res.status).toBe(403);
    expect(db.update).not.toHaveBeenCalled();
  });

  it('null clears it', async () => {
    mockSessionUser();
    teamRole('admin');
    const { set } = mockDbUpdate({ ...mockSchedule });
    const res = await PATCH(makeRequest('PATCH', { delegation: null }), { params });
    expect(res.status).toBe(200);
    expect((set.mock.calls[0] as any)[0].delegation).toBeNull();
  });

  it('moving the schedule to another workspace drops its grant', async () => {
    mockSessionUser();
    const { set } = mockDbUpdate({ ...mockSchedule });
    const res = await PATCH(makeRequest('PATCH', { workspaceId: TARGET }), { params });
    expect(res.status).toBe(200);
    expect((set.mock.calls[0] as any)[0].delegation).toBeNull();
  });
});

describe('DELETE /schedules/[scheduleId]', () => {
  it('returns 401 for unauthenticated requests', async () => {
    mockNoAuth();
    const res = await DELETE(makeRequest('DELETE'), { params });
    expect(res.status).toBe(401);
  });

  it('returns 404 when schedule not found', async () => {
    mockSessionUser();
    const returning = vi.fn().mockResolvedValue([]);
    const where = vi.fn(() => ({ returning }));
    (db.delete as any).mockReturnValue({ where });

    const res = await DELETE(makeRequest('DELETE'), { params });
    expect(res.status).toBe(404);
  });

  it('deletes an existing schedule', async () => {
    mockSessionUser();
    const returning = vi.fn().mockResolvedValue([mockSchedule]);
    const where = vi.fn(() => ({ returning }));
    (db.delete as any).mockReturnValue({ where });

    const res = await DELETE(makeRequest('DELETE'), { params });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
  });
});
