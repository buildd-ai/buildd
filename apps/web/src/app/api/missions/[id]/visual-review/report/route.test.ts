/**
 * POST /api/missions/[id]/visual-review/report. Illustrative ids only.
 */
import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest, NextResponse } from 'next/server';

const mockResolve = mock(async (_id: string) => ({
  ok: true as const,
  mission: { id: '11111111-1111-4111-8111-111111111111', teamId: 't', workspaceId: 'w' },
  reviewer: { userId: 'user-1', label: 'sam' },
}) as any);
const mockLoadState = mock(async (_id: string) => null as any);
const mockPost = mock(async (_o: any) => undefined);

mock.module('@/lib/visual-review-access', () => ({ resolveDecisionMission: mockResolve }));
mock.module('@/lib/workflow/visual-review-state-load', () => ({ getMissionVisualReviewState: mockLoadState }));
mock.module('@/lib/mission-feed', () => ({ postMissionFeedEvent: mockPost }));

const { POST } = await import('./route');

const ID = '11111111-1111-4111-8111-111111111111';
const blocked = {
  status: 'blocked',
  blocked: { cause: 'stalled', causeOwner: 'buildd', autoRetriesLeft: 0 },
  policy: { mode: 'automatic' },
  auditTaskId: '8237cfa9-aaaa-bbbb-cccc-111122223333',
  branch: { headSha: 'abcdef1234567', integrationPr: { number: 9, stage: 'open' } },
};
const call = (body?: unknown) =>
  POST(new NextRequest(`http://localhost/api/missions/${ID}/visual-review/report`, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }), { params: Promise.resolve({ id: ID }) });

beforeEach(() => {
  for (const m of [mockResolve, mockLoadState, mockPost]) m.mockClear();
  mockLoadState.mockResolvedValue(blocked);
});

describe('POST /api/missions/[id]/visual-review/report', () => {
  it('returns the access failure untouched', async () => {
    mockResolve.mockResolvedValueOnce({ ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) });
    expect((await call({})).status).toBe(401);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('records a sanitized report on the feed, as its own entry', async () => {
    const res = await call({ note: 'broke at https://p.example/?token=abc123456789' });
    expect(res.status).toBe(200);
    const arg = mockPost.mock.calls[0][0];
    expect(arg.title).toBe('Buildd problem reported');
    expect(arg.type).toBe('update');
    expect(arg.body).toContain('Cause: stalled');
    expect(arg.body).not.toMatch(/https?:|abc123456789/);
    expect(arg.collapseKey).toContain('visual-review-problem:');
  });

  it('409s when the check has not failed: findings are not reported this way', async () => {
    mockLoadState.mockResolvedValue({ ...blocked, status: 'findings', blocked: undefined });
    expect((await call({})).status).toBe(409);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('accepts an empty body', async () => {
    expect((await call()).status).toBe(200);
  });
});
