import { beforeEach, describe, expect, it, mock } from 'bun:test';

let taskStatus = 'completed';
let workerStatus = 'completed';
let replies: any[] = [];
const waitingFor = { type: 'question', prompt: 'Ship the change?', options: ['Ship', 'Wait'] };
const question = { id: 'question', workerId: 'worker', type: 'question', status: 'open',
  title: 'Ship the change?', defaultChoice: 'Ship', createdAt: new Date('2026-01-01') };
const findWorkers = mock(() => Promise.resolve([{ id: 'worker', status: workerStatus, waitingFor }]));
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      tasks: { findFirst: async () => ({ id: 'task', title: 'Finished change', status: taskStatus,
        workspaceId: 'workspace', workspace: { name: 'Workspace', teamId: null }, roleSlug: null }) },
      workers: { findMany: findWorkers },
    },
    select: () => ({ from: () => ({ where: () => ({ orderBy: async () => [question, ...replies] }) }) }),
  },
}));
mock.module('@/lib/team-access', () => ({ verifyWorkspaceAccess: async () => true }));
mock.module('@/app/app/(protected)/tasks/[id]/role-lookup', () => ({ findTaskRole: async () => null }));
const { loadQuestionContext } = await import('./load-question-object');

describe('question context loader liveness', () => {
  beforeEach(() => { taskStatus = 'completed'; workerStatus = 'completed'; replies = []; findWorkers.mockClear(); });
  it.each(['completed', 'failed', 'cancelled'])('loads a %s task as unanswered history despite a retained waiting worker', async status => {
    taskStatus = status;
    workerStatus = 'waiting_input';
    const loaded = await loadQuestionContext('task', 'viewer');
    expect(loaded?.view).toMatchObject({ open: false, awaitingAgent: false, answer: null,
      question: { headline: question.title } });
    // Status must be selected from the DB, rather than inferred from waitingFor.
    expect(findWorkers.mock.calls[0]?.[0]).toMatchObject({ columns: { status: true } });
  });
  it.each(['completed', 'failed', 'disconnected'])('keeps an ended %s worker question closed on an active task', async status => {
    taskStatus = 'in_progress'; workerStatus = status;
    replies = [{ type: 'reply', replyTo: question.id, title: 'Wait' }];
    expect((await loadQuestionContext('task', 'viewer'))?.view)
      .toMatchObject({ open: false, awaitingAgent: false, answer: 'Wait' });
  });
  it('opens the same retained question only for a waiting worker on an active task', async () => {
    taskStatus = 'in_progress'; workerStatus = 'waiting_input';
    expect((await loadQuestionContext('task', 'viewer'))?.view)
      .toMatchObject({ open: true, workerId: 'worker', answer: null });
  });
});
