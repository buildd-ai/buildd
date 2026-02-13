// Ensure test mode — routes short-circuit in development
const originalNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = 'test';

import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// Mock functions
const mockGetCurrentUser = mock(() => null as any);
const mockValidateCronExpression = mock(() => null as string | null);
const mockComputeNextRuns = mock(() => [] as Date[]);
const mockDescribeSchedule = mock(() => '' as string);

// Mock auth-helpers
mock.module('@/lib/auth-helpers', () => ({
  getCurrentUser: mockGetCurrentUser,
}));

// Mock schedule-helpers
mock.module('@/lib/schedule-helpers', () => ({
  validateCronExpression: mockValidateCronExpression,
  computeNextRuns: mockComputeNextRuns,
  describeSchedule: mockDescribeSchedule,
}));

// Import handler AFTER mocks
import { GET } from './route';

// Helper to create mock NextRequest with search params
function createMockRequest(searchParams: Record<string, string> = {}): NextRequest {
  let url = 'http://localhost:3000/api/workspaces/ws-1/schedules/validate';
  const params = new URLSearchParams(searchParams);
  if (params.toString()) {
    url += `?${params.toString()}`;
  }

  return new NextRequest(url, {
    method: 'GET',
    headers: new Headers(),
  });
}

afterAll(() => {
  process.env.NODE_ENV = originalNodeEnv;
});

describe('GET /api/workspaces/[id]/schedules/validate', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockValidateCronExpression.mockReset();
    mockComputeNextRuns.mockReset();
    mockDescribeSchedule.mockReset();
    process.env.NODE_ENV = 'test';
  });

  it('returns 401 when not authenticated', async () => {
    mockGetCurrentUser.mockResolvedValue(null);

    const request = createMockRequest({ cron: '0 9 * * *' });
    const response = await GET(request);

    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error).toBe('Unauthorized');
  });

  it('returns valid:false when no cron provided', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1', email: 'user@test.com' });

    const request = createMockRequest();
    const response = await GET(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.valid).toBe(false);
    expect(data.description).toBe('No expression provided');
  });

  it('returns valid:false for invalid cron expression', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1', email: 'user@test.com' });
    mockValidateCronExpression.mockReturnValue('Invalid syntax at position 3');

    const request = createMockRequest({ cron: 'not-valid-cron' });
    const response = await GET(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.valid).toBe(false);
    expect(data.description).toBe('Invalid syntax at position 3');
  });

  it('returns valid:true with description and nextRuns for valid cron', async () => {
    const nextRunDates = [
      new Date('2026-01-01T09:00:00Z'),
      new Date('2026-01-02T09:00:00Z'),
      new Date('2026-01-03T09:00:00Z'),
    ];

    mockGetCurrentUser.mockResolvedValue({ id: 'user-1', email: 'user@test.com' });
    mockValidateCronExpression.mockReturnValue(null);
    mockDescribeSchedule.mockReturnValue('Daily at 09:00');
    mockComputeNextRuns.mockReturnValue(nextRunDates);

    const request = createMockRequest({ cron: '0 9 * * *' });
    const response = await GET(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.valid).toBe(true);
    expect(data.description).toBe('Daily at 09:00');
    expect(data.nextRuns).toHaveLength(3);
  });

  it('passes timezone to computeNextRuns', async () => {
    const nextRunDates = [
      new Date('2026-01-01T14:00:00Z'),
    ];

    mockGetCurrentUser.mockResolvedValue({ id: 'user-1', email: 'user@test.com' });
    mockValidateCronExpression.mockReturnValue(null);
    mockDescribeSchedule.mockReturnValue('Daily at 09:00');
    mockComputeNextRuns.mockReturnValue(nextRunDates);

    const request = createMockRequest({ cron: '0 9 * * *', timezone: 'America/New_York' });
    const response = await GET(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.valid).toBe(true);
    expect(mockComputeNextRuns).toHaveBeenCalledWith('0 9 * * *', 'America/New_York', 3);
  });
});
