import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@buildd/core/db', () => ({
  db: {
    query: {
      taskSchedules: {
        findFirst: vi.fn(),
      },
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
  (authenticateApiKey as any).mockResolvedValue({ id: 'account-1', level: 'admin' });
  (verifyAccountWorkspaceAccess as any).mockResolvedValue(true);
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
