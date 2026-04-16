import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// ── Mock functions ──────────────────────────────────────────────────────────

const mockRunFeedbackDigest = mock(() => Promise.resolve({
  results: [] as any[],
  totalFeedback: 0,
}));

const mockGetFeedbackStats = mock(() => Promise.resolve({
  total: 0,
  bySignal: {} as Record<string, number>,
  byEntityType: {} as Record<string, number>,
}));

// ── Register mocks ─────────────────────────────────────────────────────────

mock.module('@/lib/feedback-digest', () => ({
  runFeedbackDigest: mockRunFeedbackDigest,
  getFeedbackStats: mockGetFeedbackStats,
}));

import { POST } from './route';

// ── Helpers ─────────────────────────────────────────────────────────────────

const CRON_SECRET = 'test-cron-secret-123';

function createRequest(opts: {
  authHeader?: string;
  windowHours?: number;
} = {}): NextRequest {
  const url = new URL('http://localhost:3000/api/cron/feedback-digest');
  if (opts.windowHours) url.searchParams.set('windowHours', String(opts.windowHours));

  const headers: Record<string, string> = {};
  if (opts.authHeader) headers['authorization'] = opts.authHeader;

  return new NextRequest(url.toString(), {
    method: 'POST',
    headers: new Headers(headers),
  });
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('POST /api/cron/feedback-digest', () => {
  beforeEach(() => {
    mockRunFeedbackDigest.mockReset();
    mockGetFeedbackStats.mockReset();
    process.env.CRON_SECRET = CRON_SECRET;
  });

  it('returns 500 when CRON_SECRET is not configured', async () => {
    delete process.env.CRON_SECRET;

    const res = await POST(createRequest({ authHeader: `Bearer ${CRON_SECRET}` }));
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toBe('CRON_SECRET not configured');
  });

  it('returns 401 when no auth header', async () => {
    const res = await POST(createRequest());
    expect(res.status).toBe(401);
  });

  it('returns 401 when token does not match', async () => {
    const res = await POST(createRequest({ authHeader: 'Bearer wrong-token' }));
    expect(res.status).toBe(401);
  });

  it('runs digest pipeline with default 24h window', async () => {
    mockRunFeedbackDigest.mockResolvedValue({
      results: [],
      totalFeedback: 0,
    });
    mockGetFeedbackStats.mockResolvedValue({
      total: 0,
      bySignal: {},
      byEntityType: {},
    });

    const res = await POST(createRequest({ authHeader: `Bearer ${CRON_SECRET}` }));

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.windowHours).toBe(24);
    expect(mockRunFeedbackDigest).toHaveBeenCalledWith(24);
  });

  it('uses custom windowHours from query param', async () => {
    mockRunFeedbackDigest.mockResolvedValue({ results: [], totalFeedback: 0 });
    mockGetFeedbackStats.mockResolvedValue({ total: 0, bySignal: {}, byEntityType: {} });

    const res = await POST(createRequest({
      authHeader: `Bearer ${CRON_SECRET}`,
      windowHours: 4,
    }));

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.windowHours).toBe(4);
    expect(mockRunFeedbackDigest).toHaveBeenCalledWith(4);
  });

  it('returns digest results with team stats', async () => {
    mockRunFeedbackDigest.mockResolvedValue({
      results: [
        { teamId: 'team-1', memoriesSaved: 2, memoriesUpdated: 1, feedbackProcessed: 5 },
        { teamId: 'team-2', memoriesSaved: 0, memoriesUpdated: 1, feedbackProcessed: 3 },
      ],
      totalFeedback: 8,
    });
    mockGetFeedbackStats.mockResolvedValue({
      total: 12,
      bySignal: { up: 4, down: 5, dismiss: 3 },
      byEntityType: { artifact: 7, note: 3, summary: 2 },
    });

    const res = await POST(createRequest({ authHeader: `Bearer ${CRON_SECRET}` }));

    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.ok).toBe(true);
    expect(data.stats.total).toBe(12);
    expect(data.stats.bySignal.down).toBe(5);
    expect(data.stats.byEntityType.artifact).toBe(7);
    expect(data.digest.totalNegativeFeedback).toBe(8);
    expect(data.digest.teams.length).toBe(2);
    expect(data.digest.teams[0].memoriesSaved).toBe(2);
  });

  it('returns 500 when pipeline throws', async () => {
    mockRunFeedbackDigest.mockRejectedValue(new Error('DB connection failed'));

    const res = await POST(createRequest({ authHeader: `Bearer ${CRON_SECRET}` }));

    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toBe('Feedback digest failed');
  });
});
