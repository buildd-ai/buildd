import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

/**
 * On-demand criteria evaluation.
 *
 * This route is the operator's escape hatch: when a mission is refused for
 * unverified criteria, "Run verification" is the button they are told to press.
 * It is also the one path that can produce a verdict for a mission whose
 * `autoVerify` is off. It had no test at all.
 */

let missionRow: any = null;
let workspaceRow: any = null;
let noteCountRows: any[] = [{ value: 0 }];
let currentUser: any = { id: 'u-1', email: 'max@example.com' };
let apiAccountRow: any = null;

const mockEvaluateCriteriaNow = mock((_id: string, _opts: any) => Promise.resolve({
  evaluatedAt: '2026-08-29T12:00:00.000Z',
  evaluatedBy: 'manual',
  overall: 'UNVERIFIED',
  criteria: [{ index: 0, type: 'description', verdict: 'NOT_EVALUATED', evidence: 'LLM evaluator not configured' }],
}) as any);

const mockCompleteMissionIfVerified = mock((_id: string, _opts: any) => Promise.resolve({
  completed: false,
  decision: { ok: false, code: 'criteria_unverified', reason: 'Goal criteria not verified (overall: UNVERIFIED)' },
}) as any);

mock.module('drizzle-orm', () => ({
  eq: (...args: any[]) => ({ _op: 'eq', args }),
  and: (...args: any[]) => ({ _op: 'and', args }),
  gte: (...args: any[]) => ({ _op: 'gte', args }),
  count: () => ({ _op: 'count' }),
}));

mock.module('@buildd/core/db/schema', () => ({
  missions: Symbol('missions'),
  missionNotes: { missionId: 'mission_id', title: 'title', createdAt: 'created_at' },
  workspaces: Symbol('workspaces'),
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      missions: { findFirst: () => Promise.resolve(missionRow) },
      workspaces: { findFirst: () => Promise.resolve(workspaceRow) },
    },
    select: () => ({ from: () => ({ where: () => Promise.resolve(noteCountRows) }) }),
  },
}));

mock.module('@/lib/auth-helpers', () => ({
  getCurrentUser: () => Promise.resolve(currentUser),
}));

mock.module('@/lib/api-auth', () => ({
  authenticateApiKey: () => Promise.resolve(apiAccountRow),
}));

mock.module('@/lib/team-access', () => ({
  resolveAccountTeamIds: () => Promise.resolve(['team-1']),
}));

mock.module('@/lib/mission-criteria-eval', () => ({
  evaluateCriteriaNow: mockEvaluateCriteriaNow,
  ON_DEMAND_NOTE_TITLE: 'Goal criteria evaluated (on-demand)',
}));

mock.module('@/lib/mission-completion', () => ({
  completeMissionIfVerified: mockCompleteMissionIfVerified,
}));

import { POST, GET } from './route';

const makeParams = (id: string) => Promise.resolve({ id });
const post = () => new NextRequest('http://localhost/api/missions/m1/evaluate', { method: 'POST' });
const get = () => new NextRequest('http://localhost/api/missions/m1/evaluate');

function reset() {
  missionRow = {
    id: 'm1',
    teamId: 'team-1',
    workspaceId: 'ws-1',
    goalCriteria: [{ type: 'description', description: 'Rows exist', notMechanizableReason: 'stated reason' }],
    goalCriteriaState: null,
  };
  workspaceRow = { accessMode: 'team' };
  noteCountRows = [{ value: 0 }];
  currentUser = { id: 'u-1', email: 'max@example.com' };
  apiAccountRow = null;
  mockEvaluateCriteriaNow.mockClear();
  mockCompleteMissionIfVerified.mockClear();
}

describe('POST /api/missions/[id]/evaluate — auth', () => {
  beforeEach(reset);

  it('401s with neither a session nor an API key', async () => {
    currentUser = null;
    apiAccountRow = null;
    const res = await POST(post(), { params: makeParams('m1') });
    expect(res.status).toBe(401);
    expect(mockEvaluateCriteriaNow).not.toHaveBeenCalled();
  });

  it('403s for a non-admin API key', async () => {
    currentUser = null;
    apiAccountRow = { id: 'acct-1', level: 'worker' };
    const res = await POST(post(), { params: makeParams('m1') });
    expect(res.status).toBe(403);
  });

  it('404s for a mission outside the caller\'s teams', async () => {
    missionRow = { id: 'm1', teamId: 'other-team', workspaceId: null, goalCriteria: [] };
    const res = await POST(post(), { params: makeParams('m1') });
    expect(res.status).toBe(404);
  });

  it('allows an open-access workspace mission from another team', async () => {
    missionRow = { ...missionRow, teamId: 'other-team' };
    workspaceRow = { accessMode: 'open' };
    const res = await POST(post(), { params: makeParams('m1') });
    expect(res.status).toBe(200);
  });
});

describe('POST /api/missions/[id]/evaluate — evaluation', () => {
  beforeEach(reset);

  it('short-circuits when the mission states no criteria', async () => {
    missionRow = { ...missionRow, goalCriteria: [] };
    const res = await POST(post(), { params: makeParams('m1') });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.goalCriteriaState).toBeNull();
    expect(body.message).toContain('nothing to evaluate');
    expect(mockEvaluateCriteriaNow).not.toHaveBeenCalled();
  });

  it('429s past the hourly rate limit without evaluating', async () => {
    noteCountRows = [{ value: 6 }];
    const res = await POST(post(), { params: makeParams('m1') });

    expect(res.status).toBe(429);
    expect(mockEvaluateCriteriaNow).not.toHaveBeenCalled();
  });

  it('evaluates as manual for a session user and reports why completion is still blocked', async () => {
    const res = await POST(post(), { params: makeParams('m1') });
    const body = await res.json();

    expect(mockEvaluateCriteriaNow).toHaveBeenCalledWith('m1', {
      evaluatedBy: 'manual',
      noteTitle: 'Goal criteria evaluated (on-demand)',
    });
    expect(body.goalCriteriaState.overall).toBe('UNVERIFIED');
    // The operator pressed the button; the answer has to say what is still wrong.
    expect(body.missionCompleted).toBe(false);
    expect(body.completionBlockedBy).toBe('criteria_unverified');
    expect(body.completionReason).toContain('not verified');
  });

  it('attributes an admin API key run to mcp', async () => {
    currentUser = null;
    apiAccountRow = { id: 'acct-1', level: 'admin' };
    await POST(post(), { params: makeParams('m1') });

    expect(mockEvaluateCriteriaNow).toHaveBeenCalledWith('m1', expect.objectContaining({ evaluatedBy: 'mcp' }));
  });

  it('completes the mission when a fresh pass is the last thing it was waiting for', async () => {
    mockEvaluateCriteriaNow.mockImplementation(() => Promise.resolve({
      evaluatedAt: '2026-08-29T12:00:00.000Z',
      evaluatedBy: 'manual',
      overall: 'pass',
      criteria: [{ index: 0, type: 'description', verdict: 'pass' }],
    }) as any);
    mockCompleteMissionIfVerified.mockImplementation(() => Promise.resolve({
      completed: true,
      decision: { ok: true, code: 'ok', reason: 'All 1 goal criteria pass' },
    }) as any);

    const res = await POST(post(), { params: makeParams('m1') });
    const body = await res.json();

    // Reuses the verdict just written rather than evaluating twice.
    expect(mockCompleteMissionIfVerified).toHaveBeenCalledWith('m1', {
      path: 'criteria_eval',
      predicate: 'on-demand criteria evaluation',
      evaluateCriteria: false,
    });
    expect(body.missionCompleted).toBe(true);
    expect(body.completionBlockedBy).toBeNull();
  });

  it('500s (not a crash) when evaluation throws', async () => {
    mockEvaluateCriteriaNow.mockImplementation(() => Promise.reject(new Error('boom')) as any);
    const res = await POST(post(), { params: makeParams('m1') });
    expect(res.status).toBe(500);
  });
});

describe('GET /api/missions/[id]/evaluate', () => {
  beforeEach(reset);

  it('returns the stored state without evaluating', async () => {
    missionRow = {
      ...missionRow,
      goalCriteriaState: { evaluatedAt: '2026-08-28T00:00:00.000Z', overall: 'fail', criteria: [] },
    };

    const res = await GET(get(), { params: makeParams('m1') });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.goalCriteriaState.overall).toBe('fail');
    expect(mockEvaluateCriteriaNow).not.toHaveBeenCalled();
  });

  it('401s without auth', async () => {
    currentUser = null;
    apiAccountRow = null;
    const res = await GET(get(), { params: makeParams('m1') });
    expect(res.status).toBe(401);
  });
});
