import { describe, expect, it, mock } from 'bun:test';
import { handleBuilddAction, type ActionContext, type ApiFn } from '../mcp-tools';
import { DECISION_OPTIONS_GUIDANCE, DECISION_TITLE_GUIDANCE } from '../question-brief';

function context(): ActionContext {
  return {
    workerId: 'worker-1',
    getWorkspaceId: async () => 'workspace-1',
    getLevel: async () => 'worker',
  };
}

describe('post_note', () => {
  it('enumerates missing fields, accepted note types, and full schema', async () => {
    const api = mock(async () => ({ id: 'note-1' }));

    let error: Error | undefined;
    try {
      await handleBuilddAction(api as unknown as ApiFn, 'post_note', {}, context());
    } catch (e) {
      error = e as Error;
    }

    expect(error?.message).toContain('post_note missing required parameters: type, title');
    expect(error?.message).toContain('type must be one of: decision, question, warning, suggestion, update');
    expect(error?.message).toContain('Full schema:');
    expect(api).not.toHaveBeenCalled();
  });

  it('reports only the required field that is missing, without misleading type hint', async () => {
    const api = mock(async () => ({ id: 'note-1' }));

    let error: Error | undefined;
    try {
      await handleBuilddAction(
        api as unknown as ApiFn,
        'post_note',
        { type: 'decision' },
        context(),
      );
    } catch (e) {
      error = e as Error;
    }

    expect(error?.message).toContain('post_note missing required parameter: title');
    // Must NOT mislead the agent with a type hint when type is already valid
    expect(error?.message).not.toContain('type must be one of');
    // Must include the full schema so agents can self-correct in one shot
    expect(error?.message).toContain('Full schema:');
    expect(api).not.toHaveBeenCalled();
  });

  it('tells the agent when its question was routed to a repair task instead of a person', async () => {
    const api = mock(async (endpoint: string) => {
      if (endpoint === '/api/workers/worker-1') return { taskId: 'task-1', task: { id: 'task-1', missionId: null } };
      return { id: 'note-1', gate: { disposition: 'recovered', repairTaskId: 'r-1', reason: 'Not sent to a person: repair task r-1 was filed.' } };
    });
    const res = await handleBuilddAction(
      api as unknown as ApiFn,
      'post_note',
      { type: 'question', title: 'CI is already failing on dev, unrelated. Wait?' },
      context(),
    );
    const out = JSON.stringify(res);
    expect(out).toContain('not shown to a person');
    expect(out).toContain('repair task r-1 was filed');
    expect(out).not.toContain('User reply reaches you');
  });

  it('a question says when the reply reaches the agent, without "delivered"', async () => {
    const api = mock(async (endpoint: string) => {
      if (endpoint === '/api/workers/worker-1') return { taskId: 'task-1', task: { id: 'task-1', missionId: null } };
      return { id: 'note-1' };
    });
    const res = await handleBuilddAction(api as unknown as ApiFn, 'post_note', { type: 'question', title: 'Which one?' }, context());
    const out = res.content[0].text;
    expect(out).toContain('User reply reaches you at your next turn boundary (or call receive_messages).');
    expect(out).not.toMatch(/delivered/);
  });

  it('posts to the mission feed when the current task has a mission', async () => {
    const api = mock(async (endpoint: string) => {
      if (endpoint === '/api/workers/worker-1') {
        return { taskId: 'task-1', task: { id: 'task-1', missionId: 'mission-1' } };
      }
      return { id: 'note-1' };
    });

    await handleBuilddAction(
      api as unknown as ApiFn,
      'post_note',
      { type: 'warning', title: 'Credentials unavailable' },
      context(),
    );

    expect(api.mock.calls.map(([endpoint]) => endpoint)).toEqual([
      '/api/workers/worker-1',
      '/api/missions/mission-1/notes',
    ]);
  });

  it('posts a task-scoped note when the current task has no mission', async () => {
    const api = mock(async (endpoint: string) => {
      if (endpoint === '/api/workers/worker-1') {
        return { taskId: 'task-1', task: { id: 'task-1', missionId: null } };
      }
      return { id: 'note-1' };
    });

    const result = await handleBuilddAction(
      api as unknown as ApiFn,
      'post_note',
      { type: 'warning', title: 'Credentials unavailable', body: 'Cue tools are not connected.' },
      context(),
    );

    expect(api.mock.calls.map(([endpoint]) => endpoint)).toEqual([
      '/api/workers/worker-1',
      '/api/tasks/task-1/notes',
    ]);
    const [, options] = api.mock.calls[1];
    expect(JSON.parse(String(options?.body))).toMatchObject({
      type: 'warning',
      title: 'Credentials unavailable',
      bodyText: 'Cue tools are not connected.',
      taskId: 'task-1',
      workerId: 'worker-1',
    });
    expect(result.content[0].text).toContain('Note posted');
  });

  it('posts a mission note from a session with no worker when missionId is given', async () => {
    const api = mock(async () => ({ id: 'note-1' }));

    const result = await handleBuilddAction(
      api as unknown as ApiFn,
      'post_note',
      { type: 'decision', title: 'Cancelled', missionId: 'mission-1' },
      { ...context(), workerId: undefined },
    );

    expect(api).toHaveBeenCalledTimes(1);
    expect(api.mock.calls[0]?.[0]).toBe('/api/missions/mission-1/notes');
    expect(result.content[0].text).toContain('Note posted');
  });

  it('still requires a worker when no missionId is given', async () => {
    const api = mock(async () => ({ id: 'note-1' }));
    await expect(handleBuilddAction(
      api as unknown as ApiFn,
      'post_note',
      { type: 'decision', title: 'x' },
      { ...context(), workerId: undefined },
    )).rejects.toThrow('workerId is required');
  });

  describe('decision options and subject (Navigation R-16, AC-16)', () => {
    const api = () => mock(async (endpoint: string, _init?: any) => {
      if (endpoint === '/api/workers/worker-1') return { taskId: 'task-1', task: { id: 'task-1', missionId: 'mission-1' } };
      return { id: 'note-1' };
    });

    it('refuses four options before any call', async () => {
      const a = api();
      await expect(handleBuilddAction(a as unknown as ApiFn, 'post_note', { type: 'question', title: 'Q?', options: ['a', 'b', 'c', 'd'] }, context())).rejects.toThrow('Cut to two');
      await expect(handleBuilddAction(a as unknown as ApiFn, 'post_note', { type: 'update', title: 'U', options: ['a'] }, context())).rejects.toThrow('question');
      expect(a).not.toHaveBeenCalled();
    });

    it('sends structured options and the subject task, and reports the recommended default', async () => {
      const a = api();
      const SUBJECT = '33333333-3333-4333-8333-333333333333';
      const result = await handleBuilddAction(a as unknown as ApiFn, 'post_note', {
        type: 'question', title: 'How should Docker Hub credentials be set up?', subjectTaskId: SUBJECT,
        options: [{ label: 'Team secret', consequence: 'One token for all.', recommended: true }, { label: 'Per workspace', consequence: 'Each adds its own.' }],
      }, context());
      const [endpoint, init] = a.mock.calls[1];
      expect(endpoint).toBe('/api/missions/mission-1/notes');
      const body = JSON.parse(init.body);
      expect(body.subjectTaskId).toBe(SUBJECT);
      expect(body.options).toHaveLength(2);
      expect(body.options[0]).toMatchObject({ label: 'Team secret', effect: 'One token for all', recommended: true });
      expect(result.content[0].text).toContain('Default choice: Team secret');
      expect(result.content[0].text).not.toContain('Advisory');
    });

    it('a generic question title gets an advisory, not a refusal', async () => {
      const result = await handleBuilddAction(api() as unknown as ApiFn, 'post_note', { type: 'question', title: 'How should I proceed?', defaultChoice: 'A' }, context());
      expect(result.content[0].text).toContain('Note posted');
      expect(result.content[0].text).toContain('Advisory:');
    });
  });

  it('ask_human and post_note docs carry the decision rules (Navigation R-16)', async () => {
    for (const action of ['ask_human', 'post_note']) {
      const result = await handleBuilddAction(mock(async () => ({})) as unknown as ApiFn, 'help', { action }, context());
      const doc = result.content[0].text;
      expect(doc).toContain('subjectTaskId');
      expect(doc).toContain('consequence');
      expect(doc).toContain(DECISION_TITLE_GUIDANCE);
      expect(doc).toContain(DECISION_OPTIONS_GUIDANCE);
      expect(doc).not.toMatch(/three options by default/i);
    }
  });
});

