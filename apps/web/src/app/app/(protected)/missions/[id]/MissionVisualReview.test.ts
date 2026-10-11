/**
 * The visual review's inline phase actions on the mission page
 * (docs/design/visual-qa-human-review.md, part 2: "no runner: Turn off for
 * this mission / Skip this audit", "stalled: retry"): which routes each one
 * calls, with which body, and that a failure surfaces instead of passing
 * silently.
 */
import { describe, expect, it, mock } from 'bun:test';

mock.module('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
}));

const { visualReviewPhaseActions } = await import('./MissionVisualReview');

type Call = { url: string; method?: string; body: unknown };

function fakeFetch(status = 200, body: unknown = {}) {
  const calls: Call[] = [];
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) } as Response;
  }) as unknown as typeof fetch;
  return { calls, impl };
}

describe('visualReviewPhaseActions', () => {
  it('Turn off for this mission: PATCHes autoSurfaceAudit:false, then cancels the pending audit', async () => {
    const f = fakeFetch();
    let refreshed = 0;
    const a = visualReviewPhaseActions({ missionId: 'm1', auditTaskId: 'audit-1', fetchImpl: f.impl, refresh: () => { refreshed++; } });
    await a.onTurnOff();
    expect(f.calls).toEqual([
      { url: '/api/missions/m1', method: 'PATCH', body: { autoSurfaceAudit: false } },
      { url: '/api/tasks/audit-1', method: 'PATCH', body: { status: 'cancelled', abort: true } },
    ]);
    expect(refreshed).toBe(1);
  });

  it('Skip this audit: cancels only the audit task, and leaves the setting alone', async () => {
    const f = fakeFetch();
    const a = visualReviewPhaseActions({ missionId: 'm1', auditTaskId: 'audit-1', fetchImpl: f.impl, refresh: () => {} });
    await a.onSkip();
    expect(f.calls).toEqual([{ url: '/api/tasks/audit-1', method: 'PATCH', body: { status: 'cancelled', abort: true } }]);
  });

  it('Retry: re-queues the audit task', async () => {
    const f = fakeFetch();
    const a = visualReviewPhaseActions({ missionId: 'm1', auditTaskId: 'audit-1', fetchImpl: f.impl, refresh: () => {} });
    await a.onRetry();
    expect(f.calls).toEqual([{ url: '/api/tasks/audit-1/reassign?force=true', method: 'POST', body: undefined }]);
  });

  it('Answer: replies to the parked worker', async () => {
    const f = fakeFetch();
    const a = visualReviewPhaseActions({ missionId: 'm1', auditTaskId: 'audit-1', fetchImpl: f.impl, refresh: () => {} });
    await a.onAnswer('I fixed it, try again', { workerId: 'w-9', taskId: 'audit-1' });
    expect(f.calls).toEqual([{ url: '/api/workers/w-9/respond', method: 'POST', body: { message: 'I fixed it, try again' } }]);
  });

  it('a refused request throws with the server\'s message, and does not refresh', async () => {
    const f = fakeFetch(409, { error: 'Task is already completed' });
    let refreshed = 0;
    const a = visualReviewPhaseActions({ missionId: 'm1', auditTaskId: 'audit-1', fetchImpl: f.impl, refresh: () => { refreshed++; } });
    await expect(a.onSkip()).rejects.toThrow('Task is already completed');
    expect(refreshed).toBe(0);
  });

  it('turning off still cancels nothing when the setting cannot be saved', async () => {
    const f = fakeFetch(500, {});
    const a = visualReviewPhaseActions({ missionId: 'm1', auditTaskId: 'audit-1', fetchImpl: f.impl, refresh: () => {} });
    await expect(a.onTurnOff()).rejects.toThrow();
    expect(f.calls.length).toBe(1);
  });

  it('no audit task: skip and retry say so instead of calling anything', async () => {
    const f = fakeFetch();
    const a = visualReviewPhaseActions({ missionId: 'm1', auditTaskId: null, fetchImpl: f.impl, refresh: () => {} });
    await expect(a.onSkip()).rejects.toThrow();
    await expect(a.onRetry()).rejects.toThrow();
    expect(f.calls).toEqual([]);
  });
});
