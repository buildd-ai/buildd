/**
 * The questions-waiting read behind the shell's banner (spec 3ef37387 R-17,
 * R-23). The statement is rendered through a QueryBuilder: a mocked db would
 * hide the scoping. Illustrative ids only.
 */
import { describe, expect, it } from 'bun:test';
import { QueryBuilder } from 'drizzle-orm/pg-core';
import { WAITING_INPUT_LIMIT, waitingInputQuery, waitingTaskViews, type WaitingInputRow } from './waiting-input';

const USER = '11111111-1111-4111-8111-111111111111';

describe('waitingInputQuery', () => {
  const { sql, params } = waitingInputQuery(USER, new QueryBuilder()).toSQL();

  it('joins waiting workers to their tasks in one statement', () => {
    expect(sql).toMatch(/from "workers" inner join "tasks" on "tasks"\."id" = "workers"\."task_id"/);
    expect(sql).toContain(`"workers"."status" = $1`);
    expect(params[0]).toBe('waiting_input');
  });

  it('is scoped to the workspaces of the user\'s teams in SQL, not filtered afterwards', () => {
    expect(sql).toMatch(/"workers"\."workspace_id" in \(select "id" from "workspaces" where/);
    expect(sql).toContain('"teams"."personal_user_id" = $2');
    expect(sql).toContain('"team_members"."user_id" = $3');
    expect(params.slice(1, 3)).toEqual([USER, USER]);
  });

  it('leaves out finished tasks and is bounded', () => {
    expect(sql).toMatch(/"tasks"\."status" not in \(\$4, \$5, \$6\)/);
    expect(params.slice(3, 6)).toEqual(['completed', 'failed', 'cancelled']);
    expect(sql).toMatch(/limit \$7$/);
    expect(params[6]).toBe(WAITING_INPUT_LIMIT);
  });
});

describe('waitingTaskViews', () => {
  const row = (taskId: string, waitingFor: unknown): WaitingInputRow =>
    ({ taskId, waitingFor, title: taskId, status: 'in_progress', workspaceId: 'ws-1', missionId: null });
  const ask = (prompt: string) => ({ type: 'question', prompt, disposition: 'ask' });
  const now = Date.parse('2026-10-18T12:00:00Z');

  it('leaves out a question recovery superseded (failure-incident-recovery §17.2)', () => {
    const views = waitingTaskViews([row('audit', ask('How should I proceed?')), row('real', ask('Which plan?'))], new Set(['audit']), now);
    expect(views.map(v => v.id)).toEqual(['real']);
  });

  it('admits only questions handed to a person; a hold before its deadline waits', () => {
    const views = waitingTaskViews([
      row('held', { type: 'question', prompt: 'p', disposition: 'hold', resurfaceAt: '2026-10-19T00:00:00Z' }),
      row('undisposed', { type: 'question', prompt: 'p' }),
      row('asked', ask('p')),
    ], new Set(), now);
    expect(views.map(v => v.id)).toEqual(['asked']);
  });

  it('drops a recovered blocker; admits a hold past its deadline and a permission ask', () => {
    const views = waitingTaskViews([
      row('recovered', { type: 'question', prompt: 'Merge conflict?', disposition: 'recovered', repairTaskId: 'r-1' }),
      row('due', { type: 'question', prompt: 'Now?', disposition: 'hold', resurfaceAt: '2026-10-18T11:59:00Z' }),
      row('perm', { type: 'permission', prompt: 'Allow Bash?', disposition: 'ask' }),
    ], new Set(), now);
    expect(views.map(v => v.id)).toEqual(['due', 'perm']);
    expect(views[1].actionUrl).toMatch(/\/app\/tasks\/perm\?respond=1$/);
  });

  it('an answered question is kept as answerSent; a worker still asking wins for its task', () => {
    const views = waitingTaskViews([row('t1', null), row('t1', ask('Which?')), row('t2', null)], new Set(), now);
    expect(views).toHaveLength(2);
    expect(views.find(v => v.id === 't1')).toMatchObject({ answerSent: false, waitingFor: { prompt: 'Which?' } });
    expect(views.find(v => v.id === 't2')).toMatchObject({ answerSent: true, waitingFor: null });
  });
});
