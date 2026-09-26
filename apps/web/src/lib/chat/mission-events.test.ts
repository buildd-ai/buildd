import { describe, it, expect, beforeEach, mock } from 'bun:test';

let task: any = null;
let mission: any = null;
const posted: any[] = [];
const pings: any[] = [];

mock.module('@buildd/core/db', () => ({
  db: { query: { tasks: { findFirst: async () => task }, missions: { findFirst: async () => mission } } },
}));
mock.module('./store', () => ({
  insertMessage: async (m: any) => { posted.push(m); return { id: 'ev-1', ...m }; },
  pingConversation: async (...a: any[]) => { pings.push(a); },
}));

const { postQuestionEvent, postTaskCompletedEvent } = await import('./mission-events');

beforeEach(() => {
  task = { id: 't1', title: 'Currency table', missionId: 'm1', workspaceId: 'ws', result: null };
  mission = { id: 'm1', title: 'Bill in local currency', conversationId: 'conv-1', workspaceId: 'ws' };
  posted.length = 0; pings.length = 0;
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
