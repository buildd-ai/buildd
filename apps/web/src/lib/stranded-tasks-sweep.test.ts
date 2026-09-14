import { describe, it, expect, beforeEach, mock } from 'bun:test';

/**
 * `sweepStrandedTasks` — flags pending tasks stuck past the strand threshold
 * with one gate_events row + one open mission note, and clears both once the
 * task re-arms.
 *
 * `db.execute` is called exactly twice per sweep, always in this order: the
 * candidates query, then the resolved-notes cleanup query. The mock below
 * serves canned rows by call order rather than parsing the SQL text.
 */

let candidateRows: Record<string, unknown>[] = [];
let resolvedNoteRows: { id: string }[] = [];
let executeCallCount = 0;

let existingNote: { id: string; body: string } | null = null;
const insertedNotes: Record<string, unknown>[] = [];
const updatedNotes: Array<{ id: string; set: Record<string, unknown> }> = [];
const firedEvents: Record<string, unknown>[] = [];

mock.module('drizzle-orm', () => ({
  and: (...c: unknown[]) => ({ _op: 'and', c }),
  eq: (field: unknown, value: unknown) => ({ _op: 'eq', field, value }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ _op: 'sql', strings, values }),
}));

mock.module('@buildd/core/db/schema', () => ({
  tasks: Symbol('tasks'),
  missionNotes: { id: 'id', taskId: 'taskId', title: 'title', status: 'status' },
}));

mock.module('@buildd/core/db', () => ({
  db: {
    execute: mock(async () => {
      executeCallCount += 1;
      return { rows: executeCallCount === 1 ? candidateRows : resolvedNoteRows };
    }),
    query: {
      missionNotes: {
        findFirst: mock(async () => existingNote),
      },
    },
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        insertedNotes.push(v);
        return Promise.resolve();
      },
    }),
    update: () => ({
      set: (v: Record<string, unknown>) => ({
        where: (cond: { value?: string }) => {
          updatedNotes.push({ id: cond?.value ?? 'unknown', set: v });
          return Promise.resolve();
        },
      }),
    }),
  },
}));

mock.module('./gate-ledger', () => ({
  fireDeferralEvent: (input: Record<string, unknown>) => {
    firedEvents.push(input);
  },
  GATE_SLUGS: { CLAIM_LOOP_DEFERRAL: 'claim_loop_deferral' },
}));

const { sweepStrandedTasks } = await import('./stranded-tasks-sweep');

beforeEach(() => {
  candidateRows = [];
  resolvedNoteRows = [];
  executeCallCount = 0;
  existingNote = null;
  insertedNotes.length = 0;
  updatedNotes.length = 0;
  firedEvents.length = 0;
});

const TASK = 'task-1';

describe('sweepStrandedTasks', () => {
  it('flags a task past its startAt threshold with one note and one coalesced gate event', async () => {
    candidateRows = [{
      id: TASK,
      title: 'Refiled CI retry',
      workspaceId: 'ws-1',
      missionId: 'mission-1',
      startAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
      reason: null,
      detail: null,
    }];

    const result = await sweepStrandedTasks();

    expect(result.scanned).toBe(1);
    expect(result.stranded).toBe(1);
    expect(insertedNotes).toHaveLength(1);
    expect(insertedNotes[0].type).toBe('warning');
    expect(insertedNotes[0].taskId).toBe(TASK);
    expect(firedEvents).toHaveLength(1);
    expect(firedEvents[0].outcome).toBe('stranded');
    expect(firedEvents[0].taskId).toBe(TASK);
  });

  it('does not insert a second note for a task already flagged (re-detected on the next sweep)', async () => {
    candidateRows = [{
      id: TASK,
      title: 'Refiled CI retry',
      workspaceId: 'ws-1',
      missionId: 'mission-1',
      startAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
      reason: null,
      detail: null,
    }];
    existingNote = { id: 'note-1', body: 'stale body — will be refreshed' };

    const result = await sweepStrandedTasks();

    expect(insertedNotes).toHaveLength(0);
    expect(result.stranded).toBe(0);
    // Body differs from the freshly computed one, so it updates in place rather
    // than leaving stale duration text — but still one row, never a second insert.
    expect(updatedNotes.some(u => u.id === 'note-1')).toBe(true);
  });

  it('flags a task via consecutiveDeferrals when it has no startAt at all', async () => {
    candidateRows = [{
      id: TASK,
      title: 'Perpetually mission-paced task',
      workspaceId: 'ws-1',
      missionId: 'mission-1',
      startAt: null,
      reason: 'mission_paced',
      detail: { consecutiveDeferrals: 250, firstDeferredAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() },
    }];

    const result = await sweepStrandedTasks();

    expect(result.stranded).toBe(1);
    expect(firedEvents[0].reason).toBe('mission_paced');
  });

  it('clears a previously-stranded note once the task is no longer pending', async () => {
    candidateRows = [];
    resolvedNoteRows = [{ id: 'note-old' }];

    const result = await sweepStrandedTasks();

    expect(result.cleared).toBe(1);
    expect(updatedNotes).toHaveLength(1);
    expect(updatedNotes[0].id).toBe('note-old');
    expect(updatedNotes[0].set.status).toBe('superseded');
  });

  it('scans and clears nothing when there is no work to do', async () => {
    candidateRows = [];
    resolvedNoteRows = [];

    const result = await sweepStrandedTasks();

    expect(result).toEqual({ scanned: 0, stranded: 0, cleared: 0 });
    expect(insertedNotes).toHaveLength(0);
    expect(updatedNotes).toHaveLength(0);
    expect(firedEvents).toHaveLength(0);
  });
});
