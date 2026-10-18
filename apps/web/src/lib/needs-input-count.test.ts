import { describe, expect, it } from 'bun:test';
import { QueryBuilder } from 'drizzle-orm/pg-core';
import { waitingInputQuery, waitingTaskViews, type WaitingInputRow } from './waiting-input';

const ask = { type: 'question', prompt: 'Ship the change?', disposition: 'ask' };
const row = (taskId: string, waitingFor: unknown): WaitingInputRow =>
  ({ taskId, waitingFor, title: 'Change', status: 'in_progress', workspaceId: 'workspace', missionId: null });

describe('needs-input count source', () => {
  it('a finished task never reaches the count: the query leaves completed, failed and cancelled tasks out', () => {
    const { sql, params } = waitingInputQuery('viewer', new QueryBuilder()).toSQL();
    expect(sql).toMatch(/"tasks"\."status" not in \(\$\d+, \$\d+, \$\d+\)/);
    expect(params).toEqual(expect.arrayContaining(['completed', 'failed', 'cancelled']));
  });

  it('counts only unanswered live asks while keeping a sent answer visible until resume', () => {
    const tasks = waitingTaskViews([row('live', ask), row('answered', null)], new Set(), Date.now());
    expect(tasks.map(task => task.id)).toEqual(['live', 'answered']);
    expect(tasks.filter(task => !task.answerSent)).toHaveLength(1);
    expect(tasks.find(task => task.id === 'answered')).toMatchObject({ answerSent: true });
  });
});
