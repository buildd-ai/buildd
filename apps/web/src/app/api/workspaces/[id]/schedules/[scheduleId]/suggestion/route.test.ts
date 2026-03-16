import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock modules before imports
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

import { POST, PATCH, DELETE } from './route';
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

  return new NextRequest(`http://localhost/api/workspaces/${WORKSPACE_ID}/schedules/${SCHEDULE_ID}/suggestion`, {
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
  pendingSuggestion: null,
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

function mockWorkerApiKey() {
  (getCurrentUser as any).mockResolvedValue(null);
  (authenticateApiKey as any).mockResolvedValue({ id: 'account-1', level: 'worker' });
  (verifyAccountWorkspaceAccess as any).mockResolvedValue(true);
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

describe('POST /suggestion', () => {
  it('returns 400 when reason is missing', async () => {
    mockSessionUser();
    const res = await POST(makeRequest('POST', { cronExpression: '*/5 * * * *' }), { params });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/reason/i);
  });

  it('returns 400 when no change is provided', async () => {
    mockSessionUser();
    const res = await POST(makeRequest('POST', { reason: 'testing' }), { params });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/cronExpression.*enabled/i);
  });

  it('returns 400 for invalid cron expression', async () => {
    mockSessionUser();
    (validateCronExpression as any).mockReturnValue('Invalid');
    const res = await POST(
      makeRequest('POST', { reason: 'testing', cronExpression: 'bad' }),
      { params },
    );
    expect(res.status).toBe(400);
  });

  it('allows worker-level API key to create suggestion', async () => {
    mockWorkerApiKey();
    mockDbUpdate({ ...mockSchedule, pendingSuggestion: { reason: 'test' } });

    const res = await POST(
      makeRequest('POST', { reason: 'Too frequent', cronExpression: '0 */2 * * *' }, 'Bearer test-key'),
      { params },
    );
    expect(res.status).toBe(200);
  });

  it('returns 409 when suggestion already pending', async () => {
    mockSessionUser();
    (db.query.taskSchedules.findFirst as any).mockResolvedValue({
      ...mockSchedule,
      pendingSuggestion: { reason: 'existing', suggestedAt: '2026-03-15T00:00:00Z' },
    });

    const res = await POST(
      makeRequest('POST', { reason: 'new suggestion', cronExpression: '0 */2 * * *' }),
      { params },
    );
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.error).toMatch(/already pending/i);
  });

  it('returns 401 for unauthenticated requests', async () => {
    mockNoAuth();
    const res = await POST(
      makeRequest('POST', { reason: 'test', cronExpression: '0 */2 * * *' }),
      { params },
    );
    expect(res.status).toBe(401);
  });
});

describe('PATCH /suggestion (approve)', () => {
  it('returns 401 for worker-level API key', async () => {
    mockWorkerApiKey();
    const res = await PATCH(makeRequest('PATCH'), { params });
    expect(res.status).toBe(401);
  });

  it('returns 404 when no pending suggestion', async () => {
    mockSessionUser();
    (db.query.taskSchedules.findFirst as any).mockResolvedValue({
      ...mockSchedule,
      pendingSuggestion: null,
    });

    const res = await PATCH(makeRequest('PATCH'), { params });
    expect(res.status).toBe(404);
  });

  it('approves and applies cron change', async () => {
    mockSessionUser();
    const suggestionSchedule = {
      ...mockSchedule,
      pendingSuggestion: {
        cronExpression: '0 */2 * * *',
        reason: 'Less frequent',
        suggestedAt: '2026-03-15T00:00:00Z',
      },
    };
    (db.query.taskSchedules.findFirst as any).mockResolvedValue(suggestionSchedule);
    const dbMock = mockDbUpdate({
      ...mockSchedule,
      cronExpression: '0 */2 * * *',
      pendingSuggestion: null,
    });

    const res = await PATCH(makeRequest('PATCH'), { params });
    expect(res.status).toBe(200);

    // Verify the set call includes the new cron and clears suggestion
    const setArg = dbMock.set.mock.calls[0][0];
    expect(setArg.cronExpression).toBe('0 */2 * * *');
    expect(setArg.pendingSuggestion).toBeNull();
  });

  it('approves and applies enabled=false', async () => {
    mockSessionUser();
    const suggestionSchedule = {
      ...mockSchedule,
      pendingSuggestion: {
        enabled: false,
        reason: 'Not needed on weekends',
        suggestedAt: '2026-03-15T00:00:00Z',
      },
    };
    (db.query.taskSchedules.findFirst as any).mockResolvedValue(suggestionSchedule);
    const dbMock = mockDbUpdate({
      ...mockSchedule,
      enabled: false,
      pendingSuggestion: null,
    });

    const res = await PATCH(makeRequest('PATCH'), { params });
    expect(res.status).toBe(200);

    const setArg = dbMock.set.mock.calls[0][0];
    expect(setArg.enabled).toBe(false);
    expect(setArg.nextRunAt).toBeNull();
  });

  it('allows admin API key to approve', async () => {
    mockAdminApiKey();
    const suggestionSchedule = {
      ...mockSchedule,
      pendingSuggestion: {
        cronExpression: '0 */2 * * *',
        reason: 'Less frequent',
        suggestedAt: '2026-03-15T00:00:00Z',
      },
    };
    (db.query.taskSchedules.findFirst as any).mockResolvedValue(suggestionSchedule);
    mockDbUpdate({ ...mockSchedule, pendingSuggestion: null });

    const res = await PATCH(
      makeRequest('PATCH', undefined, 'Bearer admin-key'),
      { params },
    );
    expect(res.status).toBe(200);
  });
});

describe('DELETE /suggestion (dismiss)', () => {
  it('returns 401 for worker-level API key', async () => {
    mockWorkerApiKey();
    const res = await DELETE(makeRequest('DELETE'), { params });
    expect(res.status).toBe(401);
  });

  it('returns 404 when no pending suggestion', async () => {
    mockSessionUser();
    const res = await DELETE(makeRequest('DELETE'), { params });
    expect(res.status).toBe(404);
  });

  it('clears the suggestion on dismiss', async () => {
    mockSessionUser();
    (db.query.taskSchedules.findFirst as any).mockResolvedValue({
      ...mockSchedule,
      pendingSuggestion: {
        cronExpression: '0 */2 * * *',
        reason: 'Less frequent',
        suggestedAt: '2026-03-15T00:00:00Z',
      },
    });
    const dbMock = mockDbUpdate({ ...mockSchedule, pendingSuggestion: null });

    const res = await DELETE(makeRequest('DELETE'), { params });
    expect(res.status).toBe(200);

    const setArg = dbMock.set.mock.calls[0][0];
    expect(setArg.pendingSuggestion).toBeNull();
  });
});
