import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { and } from 'drizzle-orm';
import { buildVisualReviewFixtureModel } from '@/lib/visual-review-model.fixtures';

let task: any = null;
let mission: any = null;
const posted: any[] = [];
const pings: any[] = [];
/** Rows the atomic moment claim returns: [] = another sweep already claimed it. */
let claimRows: Array<{ id: string }> = [{ id: 't-audit' }];
const claims: any[] = [];

mock.module('@buildd/core/db', () => ({
  db: {
    query: { tasks: { findFirst: async () => task }, missions: { findFirst: async () => mission } },
    update: () => ({
      set: (set: unknown) => ({
        where: (where: unknown) => ({
          returning: async () => { claims.push({ set, where }); return claimRows; },
        }),
      }),
    }),
  },
}));
let loadedModel: any = null;
mock.module('@/lib/visual-review-load', () => ({ loadVisualReview: async () => loadedModel }));
mock.module('./store', () => ({
  insertMessage: async (m: any) => { posted.push(m); return { id: 'ev-1', ...m }; },
  pingConversation: async (...a: any[]) => { pings.push(a); },
}));

const {
  postQuestionEvent, postTaskCompletedEvent, postVisualReviewEvent, visualReviewEventText, visualReviewEventData,
  visualQaMomentClaim, roundMomentFor,
} = await import('./mission-events');

beforeEach(() => {
  task = { id: 't1', title: 'Currency table', missionId: 'm1', workspaceId: 'ws', result: null, roleSlug: 'builder' };
  mission = { id: 'm1', title: 'Bill in local currency', conversationId: 'conv-1', workspaceId: 'ws' };
  posted.length = 0; pings.length = 0; claims.length = 0;
  claimRows = [{ id: 't-audit' }];
});

describe('postQuestionEvent', () => {
  it('posts a question object into the conversation the mission came from', async () => {
    await postQuestionEvent({ taskId: 't1', workerId: 'w1', prompt: 'Round per line or per invoice?' });
    expect(posted[0]).toMatchObject({ conversationId: 'conv-1', role: 'event' });
    const data = posted[0].parts[0].data;
    expect(posted[0].parts[0].type).toBe('data-buildd-event');
    expect(data.event).toBe('question');
    expect(data.objects[0]).toMatchObject({ kind: 'question', id: 'w1', taskId: 't1', missionId: 'm1' });
    expect(pings[0]).toEqual(['conv-1', 'event', 'ev-1']);
  });

  it('a sensitive workspace never puts the question text in the conversation', async () => {
    await postQuestionEvent({ taskId: 't1', workerId: 'w1', prompt: 'secret details', sensitive: true });
    expect(JSON.stringify(posted[0])).not.toContain('secret details');
  });

  it('does nothing for a mission not filed from chat', async () => {
    mission.conversationId = null;
    await postQuestionEvent({ taskId: 't1', workerId: 'w1' });
    expect(posted).toHaveLength(0);
  });
});

describe('postTaskCompletedEvent', () => {
  it('posts "plan ready" with the plan size when the task produced a plan', async () => {
    task.result = { structuredOutput: { plan: [{}, {}, {}] } };
    await postTaskCompletedEvent({ taskId: 't1' });
    expect(posted[0].parts[0].data).toMatchObject({ event: 'plan_ready', text: 'Plan ready: 3 tasks.' });
    expect(posted[0].parts[0].data.objects[0]).toMatchObject({ kind: 'mission', id: 'm1' });
  });

  it('ignores ordinary task completions', async () => {
    task.result = { summary: 'done' };
    await postTaskCompletedEvent({ taskId: 't1' });
    expect(posted).toHaveLength(0);
  });

  it('never throws', async () => {
    task = undefined;
    mission = undefined;
    await expect(postTaskCompletedEvent({ taskId: 'nope' })).resolves.toBeUndefined();
  });
});

describe('visual review events', () => {
  const needsYou = () => buildVisualReviewFixtureModel('needs_you');
  const reviewed = () => buildVisualReviewFixtureModel('reviewed');

  it('the text always carries the counts', () => {
    const m = needsYou();
    const s = m.summary;
    const text = visualReviewEventText('round_done', m);
    expect(text).toContain(`${s.effectiveOk} ok`);
    expect(text).toMatch(/\d+ issues?/);
    expect(text).toMatch(/\d+ unsure/);
    expect(text).toContain(`${s.awaitingHuman} need`);
    expect(text).toMatch(/^Round 1 done: /);
    for (const moment of ['no_browser_runner', 'fixes_filed', 'all_clear', 'round_cap'] as const) {
      expect(visualReviewEventText(moment, m, { fixes: 1, routes: ['/app/tasks/:id'] })).toMatch(/\d/);
    }
    expect(visualReviewEventText('no_browser_runner', buildVisualReviewFixtureModel('no_browser_runner'))).toBe('Visual audit waiting: no browser runner online (0 screens captured).');
    expect(visualReviewEventText('round_cap', m)).toMatch(/^Issues remain after \d rounds?: your call\./);
    expect(visualReviewEventText('fixes_filed', m, { fixes: 2, routes: ['/a', '/b'] })).toMatch(/^Filed 2 fixes from your decisions \(\/a, \/b\)\./);
    expect(visualReviewEventText('all_clear', reviewed())).toMatch(/^All clear after round 2: \d+ ok, 0 issues, 0 unsure\.$/);
  });

  it('the data mirrors the counts in the text, with the phase for the tone', () => {
    const m = needsYou();
    expect(visualReviewEventData('round_done', m)).toEqual({
      phase: 'needs_you', round: 1,
      ok: m.summary.effectiveOk, issues: m.summary.effectiveIssues,
      unsure: m.cells.filter(c => c.effectiveVerdict === 'unsure').length,
      awaitingHuman: m.summary.awaitingHuman,
    });
    expect(visualReviewEventData('no_browser_runner', m).phase).toBe('no_browser_runner');
  });

  it('a round with nothing left to do is the all-clear moment', () => {
    expect(roundMomentFor(reviewed())).toBe('all_clear');
    expect(roundMomentFor(needsYou())).toBe('round_done');
  });

  it('posts a visual_review event with a mission ref into the conversation the mission came from', async () => {
    const m = needsYou();
    const ok = await postVisualReviewEvent({ missionId: 'm1', moment: 'round_done', model: m });
    expect(ok).toBe(true);
    expect(posted[0]).toMatchObject({ conversationId: 'conv-1', role: 'event' });
    const data = posted[0].parts[0].data;
    expect(data.event).toBe('visual_review');
    expect(data.text).toBe(visualReviewEventText('round_done', m));
    expect(data.visual.phase).toBe('needs_you');
    expect(data.objects[0]).toMatchObject({ kind: 'mission', id: 'm1', title: 'Bill in local currency' });
    expect(pings[0]).toEqual(['conv-1', 'event', 'ev-1']);
  });

  it('no conversation means no post, and no dedupe claim is spent', async () => {
    mission.conversationId = null;
    expect(await postVisualReviewEvent({ missionId: 'm1', moment: 'round_done', model: needsYou() })).toBe(false);
    expect(posted).toHaveLength(0);
    expect(claims).toHaveLength(0);
  });

  it('each moment posts once: a lost claim posts nothing', async () => {
    claimRows = [];
    expect(await postVisualReviewEvent({ missionId: 'm1', moment: 'no_browser_runner', model: buildVisualReviewFixtureModel('no_browser_runner') })).toBe(false);
    expect(claims).toHaveLength(1);
    expect(posted).toHaveLength(0);
  });

  it('fixes filed from a decision is not deduped (each tap is its own moment)', async () => {
    await postVisualReviewEvent({ missionId: 'm1', moment: 'fixes_filed', model: needsYou(), fixes: 1, routes: ['/app/tasks/:id'] });
    expect(claims).toHaveLength(0);
    expect(posted).toHaveLength(1);
  });

  it('never throws', async () => {
    mission = undefined;
    await expect(postVisualReviewEvent({ missionId: 'nope', moment: 'round_done', model: needsYou() })).resolves.toBe(false);
  });

  it('the claim is one atomic UPDATE guarded by IS NULL on the moment key', () => {
    const { set, where } = visualQaMomentClaim('t-audit', 'stallNotifiedAt', new Date('2026-01-01T00:00:00Z'));
    const d = new PgDialect();
    const w = d.sqlToQuery(and(where)!);
    expect(w.sql).toContain('"tasks"."id" = $1');
    expect(w.sql).toMatch(/"tasks"\."context" -> 'visualQa' ->> \$2\) is null/);
    expect(w.params).toEqual(['t-audit', 'stallNotifiedAt']);
    const s = d.sqlToQuery(set);
    expect(s.sql).toContain('jsonb_set');
    expect(s.sql).toContain("'{visualQa}'");
    expect(s.params).toContain('stallNotifiedAt');
    expect(s.params).toContain('2026-01-01T00:00:00.000Z');
  });
});

describe('the boot-failure question carries the mission ref', () => {
  it('a visual-auditor question adds the mission to the question event', async () => {
    task.roleSlug = 'visual-auditor';
    await postQuestionEvent({ taskId: 't1', workerId: 'w1', prompt: 'The app did not boot' });
    const data = posted[0].parts[0].data;
    expect(data.event).toBe('question');
    expect(data.objects.map((o: any) => o.kind)).toEqual(['question', 'mission']);
  });

  it('an ordinary question stays one ref', async () => {
    await postQuestionEvent({ taskId: 't1', workerId: 'w1', prompt: 'Which one?' });
    expect(posted[0].parts[0].data.objects).toHaveLength(1);
  });
});

describe('a visual audit round finishing (from the worker PATCH)', () => {
  it('posts the round with its counts, keyed once on the audit task', async () => {
    task = { ...task, id: 'fixture-audit-1', roleSlug: 'visual-auditor' };
    loadedModel = buildVisualReviewFixtureModel('needs_you');
    await postTaskCompletedEvent({ taskId: 'fixture-audit-1' });
    expect(posted).toHaveLength(1);
    expect(posted[0].parts[0].data).toMatchObject({ event: 'visual_review', visual: { phase: 'needs_you', round: 1 } });
    expect(posted[0].parts[0].data.text).toMatch(/^Round 1 done: /);
    expect(claims).toHaveLength(1);
    expect(new PgDialect().sqlToQuery(claims[0].where).params).toEqual(['fixture-audit-1', 'roundNotifiedAt']);
  });

  it('a clean round is the all-clear', async () => {
    task = { ...task, id: 'fixture-audit-2', roleSlug: 'visual-auditor' };
    loadedModel = buildVisualReviewFixtureModel('reviewed');
    await postTaskCompletedEvent({ taskId: 'fixture-audit-2' });
    expect(posted[0].parts[0].data.text).toMatch(/^All clear after round 2/);
    expect(new PgDialect().sqlToQuery(claims[0].where).params).toEqual(['fixture-audit-2', 'clearNotifiedAt']);
  });

  it('an older round finishing after a newer one opened posts nothing', async () => {
    task = { ...task, id: 'fixture-audit-1', roleSlug: 'visual-auditor' };
    loadedModel = buildVisualReviewFixtureModel('reviewed');
    await postTaskCompletedEvent({ taskId: 'fixture-audit-1' });
    expect(posted).toHaveLength(0);
  });
});
