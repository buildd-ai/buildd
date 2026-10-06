import { describe, expect, it, mock } from 'bun:test';

const ask = { type: 'question', prompt: 'Ship the change?' };
const rows = [
  { taskId: 'live', status: 'waiting_input', workspaceId: 'workspace', waitingFor: ask },
  { taskId: 'done', status: 'waiting_input', workspaceId: 'workspace', waitingFor: ask },
  { taskId: 'failed', status: 'waiting_input', workspaceId: 'workspace', waitingFor: ask },
  { taskId: 'cancelled', status: 'waiting_input', workspaceId: 'workspace', waitingFor: ask },
  { taskId: 'ended', status: 'completed', workspaceId: 'workspace', waitingFor: ask },
  { taskId: 'answered', status: 'waiting_input', workspaceId: 'workspace', waitingFor: null },
];
mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: async () => ({ id: 'viewer' }) }));
mock.module('@/lib/team-access', () => ({ getUserWorkspaceIds: async () => ['workspace'] }));
mock.module('drizzle-orm', () => ({
  eq: (column: string, value: string) => ({ column, value }),
  inArray: (column: string, values: string[]) => ({ column, values }),
}));
mock.module('@buildd/core/db/schema', () => ({
  tasks: { id: 'id' }, workers: { status: 'status' },
}));
mock.module('@buildd/core/db', () => ({
  db: { query: {
    workers: { findMany: async ({ where }: any) => rows.filter(row => row.status === where.value) },
    tasks: { findMany: async ({ where }: any) => [
      { id: 'live', status: 'in_progress' }, { id: 'done', status: 'completed' },
      { id: 'failed', status: 'failed' }, { id: 'cancelled', status: 'cancelled' },
      { id: 'ended', status: 'in_progress' }, { id: 'answered', status: 'in_progress' },
    ].filter(row => where.values.includes(row.id)).map(row => ({ ...row, title: 'Change', workspaceId: 'workspace' })) },
  } },
}));
const { GET } = await import('@/app/api/tasks/waiting-input/route');

describe('needs-input count source', () => {
  it('counts only unanswered live asks while keeping a sent answer visible until resume', async () => {
    const data = await (await GET()).json();
    expect(data.tasks.map((task: any) => task.id)).toEqual(['live', 'answered']);
    expect(data.tasks.filter((task: any) => !task.answerSent)).toHaveLength(1);
    expect(data.tasks.find((task: any) => task.id === 'answered')).toMatchObject({ answerSent: true });
  });
});
