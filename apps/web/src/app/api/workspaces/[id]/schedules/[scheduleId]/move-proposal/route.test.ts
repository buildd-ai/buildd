import { describe, it, expect, vi, beforeEach } from 'vitest';

const selectRows = vi.fn();
vi.mock('@buildd/core/db', () => ({
  db: {
    query: { taskSchedules: { findFirst: vi.fn() } },
    select: vi.fn(() => ({ from: () => ({ where: () => ({ limit: () => selectRows() }) }) })),
  },
}));
vi.mock('@/lib/auth-helpers', () => ({ getCurrentUser: vi.fn() }));
vi.mock('@/lib/task-token-auth', () => ({
  authenticateTaskScopedCaller: vi.fn(),
  taskScopeAllowsWorkspace: (a: { taskScope?: { workspaceId: string } }, ws: string) => !a.taskScope || a.taskScope.workspaceId === ws,
}));
vi.mock('@/lib/team-access', () => ({ verifyWorkspaceAccess: vi.fn(), verifyAccountWorkspaceAccess: vi.fn() }));
vi.mock('@/lib/schedule-move', () => ({
  MOVE_REASON_MAX: 1000,
  validateScheduleMove: vi.fn(),
  recordMoveProposal: vi.fn(),
  getOpenMoveProposal: vi.fn(),
  listScheduleMoves: vi.fn(),
  applyScheduleMove: vi.fn(),
}));

import { POST } from './route';
import { db } from '@buildd/core/db';
import { authenticateTaskScopedCaller } from '@/lib/task-token-auth';
import { applyScheduleMove, recordMoveProposal, validateScheduleMove } from '@/lib/schedule-move';
import { NextRequest } from 'next/server';

const HOME = '00000000-0000-0000-0000-000000000001';
const SCHEDULE = '00000000-0000-0000-0000-000000000002';
const TARGET = '00000000-0000-0000-0000-000000000003';
const TASK = '00000000-0000-0000-0000-000000000004';
const params = Promise.resolve({ id: HOME, scheduleId: SCHEDULE });

const post = (body: unknown) => new NextRequest(`http://localhost/api/workspaces/${HOME}/schedules/${SCHEDULE}/move-proposal`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', authorization: 'Bearer bldt_x' }, body: JSON.stringify(body),
});

beforeEach(() => {
  vi.clearAllMocks();
  (authenticateTaskScopedCaller as any).mockResolvedValue({ id: 'acct', teamId: 'team', taskScope: { taskId: TASK, workspaceId: HOME } });
  selectRows.mockResolvedValue([{ scheduleId: SCHEDULE }]);
  (db.query.taskSchedules.findFirst as any).mockResolvedValue({ id: SCHEDULE, workspaceId: HOME });
  (validateScheduleMove as any).mockResolvedValue({ ok: true, teamId: 'team' });
  (recordMoveProposal as any).mockResolvedValue({ id: 'p1', status: 'open', toWorkspaceId: TARGET });
});

describe('POST move-proposal', () => {
  it('AC-12: a task the schedule spawned records one open proposal and moves nothing', async () => {
    const res = await POST(post({ workspace: TARGET, reason: 'its data lives there' }), { params });
    expect(res.status).toBe(201);
    expect(recordMoveProposal).toHaveBeenCalledWith(expect.objectContaining({ targetWorkspaceId: TARGET, origin: 'task', taskId: TASK }));
    expect(applyScheduleMove).not.toHaveBeenCalled();
  });

  it('AC-15: a task no schedule spawned is refused and nothing is written', async () => {
    selectRows.mockResolvedValue([{ scheduleId: null }]);
    const res = await POST(post({ workspace: TARGET, reason: 'x' }), { params });
    expect(res.status).toBe(403);
    expect(recordMoveProposal).not.toHaveBeenCalled();
  });

  it('a task spawned by a different schedule is refused', async () => {
    selectRows.mockResolvedValue([{ scheduleId: '00000000-0000-0000-0000-0000000000ff' }]);
    expect((await POST(post({ workspace: TARGET, reason: 'x' }), { params })).status).toBe(403);
    expect(recordMoveProposal).not.toHaveBeenCalled();
  });

  it('a person or plain API key (no task scope) is refused', async () => {
    (authenticateTaskScopedCaller as any).mockResolvedValue({ id: 'acct', teamId: 'team' });
    expect((await POST(post({ workspace: TARGET, reason: 'x' }), { params })).status).toBe(403);
    expect(recordMoveProposal).not.toHaveBeenCalled();
  });

  it('AC-14: a target in another team is refused and nothing is written', async () => {
    (validateScheduleMove as any).mockResolvedValue({ ok: false, status: 404, error: 'Target workspace not found' });
    const res = await POST(post({ workspace: TARGET, reason: 'x' }), { params });
    expect(res.status).toBe(404);
    expect(recordMoveProposal).not.toHaveBeenCalled();
  });

  it('requires a reason and a workspace', async () => {
    expect((await POST(post({ workspace: TARGET }), { params })).status).toBe(400);
    expect((await POST(post({ reason: 'x' }), { params })).status).toBe(400);
  });

  it('refuses a run of a schedule that already moved', async () => {
    (db.query.taskSchedules.findFirst as any).mockResolvedValue({ id: SCHEDULE, workspaceId: TARGET });
    expect((await POST(post({ workspace: TARGET, reason: 'x' }), { params })).status).toBe(409);
  });
});
