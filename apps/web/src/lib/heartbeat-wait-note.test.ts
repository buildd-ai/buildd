import { describe, it, expect, beforeEach, mock } from 'bun:test';

let noteRows: any[] = [];
let nextId = 0;
const insertedValues: any[] = [];
const updateCalls: { id: string; set: any }[] = [];

mock.module('drizzle-orm', () => ({
  eq: (col: any, val: any) => ({ _op: 'eq', args: [col, val] }),
  and: (...args: any[]) => ({ _op: 'and', args }),
}));

mock.module('@buildd/core/db/schema', () => ({
  missionNotes: { missionId: 'mission_notes.mission_id', title: 'mission_notes.title', status: 'mission_notes.status', id: 'mission_notes.id' },
}));

function eqValue(where: any, col: string): any {
  if (!where) return undefined;
  if (where._op === 'eq') return where.args[0] === col ? where.args[1] : undefined;
  if (where._op === 'and') {
    for (const part of where.args) {
      const v = eqValue(part, col);
      if (v !== undefined) return v;
    }
  }
  return undefined;
}

/** Matches a row against every eq() predicate in a where-tree keyed by mocked column name. */
function matchesWhere(row: any, where: any): boolean {
  const missionId = eqValue(where, 'mission_notes.mission_id');
  const title = eqValue(where, 'mission_notes.title');
  const status = eqValue(where, 'mission_notes.status');
  const id = eqValue(where, 'mission_notes.id');
  if (missionId !== undefined && row.missionId !== missionId) return false;
  if (title !== undefined && row.title !== title) return false;
  if (status !== undefined && row.status !== status) return false;
  if (id !== undefined && row.id !== id) return false;
  return true;
}

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      missionNotes: {
        findFirst: (args: any) => Promise.resolve(noteRows.find(r => matchesWhere(r, args?.where))),
      },
    },
    insert: () => ({
      values: (v: any) => {
        const row = { ...v, id: `note-${nextId++}` };
        insertedValues.push(row);
        noteRows.push(row);
        return Promise.resolve();
      },
    }),
    update: () => ({
      set: (data: any) => ({
        where: (w: any) => {
          const matches = noteRows.filter(r => matchesWhere(r, w));
          for (const row of matches) {
            updateCalls.push({ id: row.id, set: data });
            Object.assign(row, data);
          }
          return Promise.resolve();
        },
      }),
    }),
  },
}));

import { recordHeartbeatWaitNote, resolveHeartbeatWaitNote } from './heartbeat-wait-note';

beforeEach(() => {
  noteRows = [];
  nextId = 0;
  insertedValues.length = 0;
  updateCalls.length = 0;
});

describe('recordHeartbeatWaitNote', () => {
  it('posts a new open note the first time', async () => {
    await recordHeartbeatWaitNote('m-1', 'provider budget/rate-limit pause', new Date('2026-01-01T01:00:00Z'));
    expect(insertedValues.length).toBe(1);
    expect(insertedValues[0].title).toBe('Heartbeat waiting');
    expect(insertedValues[0].body).toContain('provider budget/rate-limit pause');
    expect(insertedValues[0].status).toBe('open');
  });

  it('does not write again when the reason and time are unchanged', async () => {
    const waitUntil = new Date('2026-01-01T01:00:00Z');
    await recordHeartbeatWaitNote('m-1', 'provider budget/rate-limit pause', waitUntil);
    await recordHeartbeatWaitNote('m-1', 'provider budget/rate-limit pause', waitUntil);
    expect(insertedValues.length).toBe(1);
    expect(updateCalls.length).toBe(0);
  });

  it('updates the existing note in place when the reason changes', async () => {
    await recordHeartbeatWaitNote('m-1', 'provider budget/rate-limit pause', new Date('2026-01-01T01:00:00Z'));
    await recordHeartbeatWaitNote('m-1', 'reviewer/retry task queued', new Date('2026-01-01T02:00:00Z'));
    expect(insertedValues.length).toBe(1);
    expect(updateCalls.length).toBe(1);
    expect(updateCalls[0].set.body).toContain('reviewer/retry task queued');
  });
});

describe('resolveHeartbeatWaitNote', () => {
  it('marks the open note as superseded', async () => {
    await recordHeartbeatWaitNote('m-1', 'provider budget/rate-limit pause', new Date('2026-01-01T01:00:00Z'));
    await resolveHeartbeatWaitNote('m-1');
    expect(noteRows[0].status).toBe('superseded');
  });
});
