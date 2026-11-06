import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const ID = '11111111-1111-4111-8111-111111111111';
let stored: any;
const mockRun = mock(async (..._a: any[]) => ({ n: 0, skipped: 0, label: 'no_records' }) as any);

mock.module('@buildd/core/db', () => ({ db: { query: { teams: { findFirst: async () => null } } } }));
mock.module('@/lib/experiment-access', () => ({
  resolveExperimentViewer: async () => ({ ok: true, viewer: { teamId: 't', role: 'owner', userId: null, operator: true } }),
  bearerOf: (req: NextRequest) => req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') || null,
}));
mock.module('@/lib/experiments-store', () => ({ getTeamExperimentForReadout: async () => stored }));
mock.module('@buildd/core/staged-self-review-readout-source', () => ({ runStagedSelfReviewReadout: mockRun }));

import { GET } from './route';

const T0 = new Date('2026-01-01T00:00:00.000Z');
const row = (over: Record<string, unknown> = {}) => ({
  id: ID, teamId: 't', key: 'k', title: 'T', hypothesis: null, status: 'running', kind: 'staged_self_review',
  treatmentFraction: 0.5, policyVersion: 2, config: {}, visibility: 'admins', decision: null, createdBy: null,
  startedAt: T0, concludedAt: null, createdAt: T0, updatedAt: T0, ...over,
});
const get = () => GET(new NextRequest(`http://localhost/api/experiments/${ID}/staged-readout`), { params: Promise.resolve({ id: ID }) });

beforeEach(() => { mockRun.mockClear(); stored = row(); });

describe('GET /api/experiments/[id]/staged-readout', () => {
  it('returns the readout for the current policy version', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(mockRun.mock.calls[0][0]).toEqual({ id: ID, policyVersion: 2 });
  });
  it('uses the stored kill criterion limits', async () => {
    stored = row({ config: { killCriterion: { rubberStampTouchRate: 0.9, rubberStampFlipRate: 0.02 } } });
    await get();
    expect(mockRun.mock.calls[0][1]).toEqual({ touchRate: 0.9, flipRate: 0.02 });
  });
  it('returns the same stagedReview the /readout route returns', async () => {
    mockRun.mockResolvedValueOnce({ n: 3, skipped: 1, touchRate: 1, flipRate: 0, rubberStamped: true, contradictionRate: 0, label: 'rubber_stamped' });
    const body = await (await get()).json();
    expect(body.stagedReview).toMatchObject({ n: 3, skipped: 1, label: 'rubber_stamped' });
  });
  it('422s another kind', async () => {
    stored = row({ kind: 'model_routing' });
    expect((await get()).status).toBe(422);
  });
});
