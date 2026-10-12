import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';

// docs/specs/terminal-question-redirect.md, "Answering at the terminal".

let returning: any[] = [];
const workerSets: any[] = [];
const noteValues: any[] = [];
let taskRow: any = { id: 't-1', missionId: 'm-1' };
mock.module('@buildd/core/db', () => ({
  db: {
    update: () => ({
      set: (v: any) => { workerSets.push(v); return { where: () => ({ returning: async () => returning }) }; },
    }),
    insert: () => ({ values: (v: any) => { noteValues.push(v); return Promise.resolve(); } }),
    query: { tasks: { findFirst: async () => taskRow } },
  },
}));
const pushes: any[] = [];
mock.module('@/lib/pusher', () => ({
  triggerEvent: async (channel: string, event: string, data: any) => { pushes.push({ channel, event, data }); },
  channels: { worker: (id: string) => `worker-${id}`, task: (id: string) => `task-${id}` },
  events: { WORKER_PROGRESS: 'worker:progress' },
}));

const { withdrawQuestionAnsweredInTerminal, terminalWithdrawWhere } = await import('./terminal-answer');
const NOW = new Date('2026-10-12T12:00:00Z');

beforeEach(() => {
  returning = [];
  workerSets.length = 0;
  noteValues.length = 0;
  pushes.length = 0;
  taskRow = { id: 't-1', missionId: 'm-1' };
});

describe('terminalWithdrawWhere', () => {
  it('only an interactive worker parked on an open question: the /respond gate plus the question type', () => {
    const q = new PgDialect().sqlToQuery(terminalWithdrawWhere('w-1') as any);
    expect(q.sql).toContain('"workers"."id" =');
    expect(q.sql).toContain('"workers"."runner" =');
    expect(q.sql).toContain('"workers"."status" =');
    expect(q.sql).toContain('"workers"."waiting_for" is not null');
    expect(q.sql).toContain(`->>'type'`);
    expect(q.params).toEqual(expect.arrayContaining(['w-1', 'mcp', 'waiting_input', 'question']));
  });
});

describe('withdrawQuestionAnsweredInTerminal', () => {
  it('reopens the worker, posts one note and tells open views, when it wins', async () => {
    returning = [{ id: 'w-1', taskId: 't-1' }];
    expect(await withdrawQuestionAnsweredInTerminal('w-1', NOW)).toBe(true);
    expect(workerSets[0]).toMatchObject({ status: 'running', waitingFor: null });
    expect(noteValues).toHaveLength(1);
    expect(noteValues[0]).toMatchObject({ taskId: 't-1', missionId: 'm-1', workerId: 'w-1', type: 'update' });
    expect(noteValues[0].title).toContain('terminal');
    expect(pushes.map(p => p.channel).sort()).toEqual(['task-t-1', 'worker-w-1']);
    expect(pushes.every(p => p.event === 'worker:progress' && p.data.status === 'running')).toBe(true);
  });

  // AC-TQR-10: /respond claimed it first; nothing else happens.
  it('does nothing when the compare-and-swap matches no row', async () => {
    returning = [];
    expect(await withdrawQuestionAnsweredInTerminal('w-1', NOW)).toBe(false);
    expect(noteValues).toHaveLength(0);
    expect(pushes).toHaveLength(0);
  });

  it('still reports the withdrawal when a best-effort note or push fails', async () => {
    returning = [{ id: 'w-1', taskId: 't-1' }];
    taskRow = null;
    expect(await withdrawQuestionAnsweredInTerminal('w-1', NOW)).toBe(true);
  });
});
