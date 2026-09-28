/**
 * The stale-worker sweep's visual audit stall notice
 * (docs/design/visual-qa-human-review.md, "Runner availability"): once per
 * audit, only when the model says no_browser_runner, only for chat-filed
 * missions. Predicates are rendered through PgDialect, since a mocked db
 * hides WHERE clauses. Illustrative ids.
 */
import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { buildVisualReviewFixtureModel } from '@/lib/visual-review-model.fixtures';
import { NO_BROWSER_RUNNER_AFTER_MS } from '@/lib/visual-review-model';

let rows: Array<{ taskId: string; missionId: string; workspaceId: string | null }> = [];
let where: unknown = null;
let limitN = 0;
mock.module('@buildd/core/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: (w: unknown) => { where = w; return { limit: async (n: number) => { limitN = n; return rows; } }; },
        }),
      }),
    }),
  },
}));

let model = buildVisualReviewFixtureModel('no_browser_runner');
const mockLoad = mock(async (_m: any, _o?: any) => model);
mock.module('@/lib/visual-review-load', () => ({ loadVisualReview: mockLoad }));
const mockPost = mock(async (_i: any) => true);
mock.module('@/lib/chat/mission-events', () => ({ postVisualReviewEvent: mockPost }));

const { notifyStalledVisualAudits, stalledVisualAuditCandidatesWhere, STALLED_VISUAL_AUDIT_AFTER_MS } = await import('./stale-workers');
const { missions } = await import('@buildd/core/db/schema');

const NOW = new Date('2026-03-10T13:00:00.000Z');

beforeEach(() => {
  rows = [{ taskId: 'fixture-audit-1', missionId: 'fixture-mission', workspaceId: 'ws-1' }];
  model = buildVisualReviewFixtureModel('no_browser_runner');
  mockLoad.mockClear();
  mockPost.mockClear();
  where = null;
});

describe('notifyStalledVisualAudits', () => {
  it('uses the same window as the model', () => {
    expect(STALLED_VISUAL_AUDIT_AFTER_MS).toBe(NO_BROWSER_RUNNER_AFTER_MS);
  });

  it('candidates: pending visual-auditor tasks past the window, on a chat mission, not yet announced', () => {
    const q = new PgDialect().sqlToQuery(stalledVisualAuditCandidatesWhere(NOW, missions));
    expect(q.sql).toContain('"tasks"."role_slug" = $1');
    expect(q.sql).toContain('"tasks"."status" = $2');
    expect(q.sql).toContain('"tasks"."created_at" < $3');
    expect(q.sql).toContain('"missions"."conversation_id" is not null');
    expect(q.sql).toContain(`("tasks"."context" -> 'visualQa' ->> 'stallNotifiedAt') is null`);
    expect(q.params.slice(0, 2)).toEqual(['visual-auditor', 'pending']);
    expect(q.params[2]).toBe(new Date(NOW.getTime() - NO_BROWSER_RUNNER_AFTER_MS).toISOString());
  });

  it('posts once per stalled audit, through the deduped chat event', async () => {
    expect(await notifyStalledVisualAudits(NOW)).toBe(1);
    expect(where).not.toBeNull();
    expect(limitN).toBeGreaterThan(0);
    expect(mockLoad.mock.calls[0][0]).toEqual({ id: 'fixture-mission', workspaceId: 'ws-1' });
    expect(mockPost.mock.calls[0][0]).toMatchObject({ missionId: 'fixture-mission', moment: 'no_browser_runner', auditTaskId: 'fixture-audit-1' });
  });

  it('an audit that is only waiting on its dependencies, or queued with a runner online, posts nothing', async () => {
    model = buildVisualReviewFixtureModel('waiting_deps');
    expect(await notifyStalledVisualAudits(NOW)).toBe(0);
    model = buildVisualReviewFixtureModel('queued');
    expect(await notifyStalledVisualAudits(NOW)).toBe(0);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('a lost claim (another sweep posted it) counts nothing', async () => {
    mockPost.mockResolvedValueOnce(false);
    expect(await notifyStalledVisualAudits(NOW)).toBe(0);
  });

  it('no candidates: no model is loaded', async () => {
    rows = [];
    expect(await notifyStalledVisualAudits(NOW)).toBe(0);
    expect(mockLoad).not.toHaveBeenCalled();
  });
});
