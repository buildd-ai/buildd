import { describe, it, expect, beforeEach, mock } from 'bun:test';

// ── Mock state ──────────────────────────────────────────────────────────────
let workerRow: any = null;
let taskRow: any = null;
let recentNote: any = null;
let insertedNotes: any[] = [];
let updatedNotes: Array<{ id: string; data: any }> = [];

const mockTriggerEvent = mock(() => Promise.resolve());

mock.module('drizzle-orm', () => ({
  eq: (...args: any[]) => ({ _op: 'eq', args }),
  and: (...args: any[]) => ({ _op: 'and', args }),
  gte: (...args: any[]) => ({ _op: 'gte', args }),
  desc: (col: any) => ({ _op: 'desc', col }),
}));

mock.module('@buildd/core/db/schema', () => ({
  missionNotes: 'missionNotes',
  workers: 'workers',
  tasks: 'tasks',
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workers: { findFirst: () => Promise.resolve(workerRow) },
      tasks: { findFirst: () => Promise.resolve(taskRow) },
      missionNotes: { findFirst: () => Promise.resolve(recentNote) },
    },
    insert: () => ({
      values: (v: any) => {
        const note = { id: `note-${insertedNotes.length + 1}`, ...v };
        insertedNotes.push(note);
        return { returning: () => Promise.resolve([note]) };
      },
    }),
    update: () => ({
      set: (data: any) => ({
        where: () => {
          updatedNotes.push({ id: recentNote?.id, data });
          return Promise.resolve();
        },
      }),
    }),
  },
}));

mock.module('@/lib/pusher', () => ({
  triggerEvent: mockTriggerEvent,
  channels: { mission: (id: string) => `mission-${id}` },
  events: { MISSION_NOTE_POSTED: 'mission:note_posted' },
}));

import {
  resolveFeedActor,
  systemActor,
  postMissionFeedEvent,
  diffGoalCriteria,
  criterionLabel,
} from './mission-feed';

function reset() {
  workerRow = null;
  taskRow = null;
  recentNote = null;
  insertedNotes = [];
  updatedNotes = [];
  mockTriggerEvent.mockReset();
  mockTriggerEvent.mockImplementation(() => Promise.resolve());
}

describe('resolveFeedActor', () => {
  beforeEach(reset);

  it('resolves a session user by email', async () => {
    const actor = await resolveFeedActor({
      user: { id: 'u1', email: 'jane@co' },
      apiAccount: null,
    });
    expect(actor).toEqual({ kind: 'user', id: 'u1', label: 'jane@co' });
  });

  it('falls back to user id when no email or name is available', async () => {
    const actor = await resolveFeedActor({ user: { id: 'u1' }, apiAccount: null });
    expect(actor.label).toBe('u1');
  });

  it('resolves a worker bound to a task as an agent actor naming the task', async () => {
    workerRow = { id: 'w1', taskId: 't1' };
    taskRow = { id: 't1', title: 'Fix login bug' };

    const actor = await resolveFeedActor({ user: null, apiAccount: null, actorWorkerId: 'w1' });
    expect(actor.kind).toBe('agent');
    expect(actor.id).toBe('t1');
    expect(actor.label).toBe('task "Fix login bug" (t1)');
  });

  it('falls back to a worker id label when the worker has no task', async () => {
    workerRow = { id: 'w1', taskId: null };

    const actor = await resolveFeedActor({ user: null, apiAccount: null, actorWorkerId: 'w1' });
    expect(actor.kind).toBe('agent');
    expect(actor.label).toBe('worker w1');
  });

  it('resolves an API account with no worker context as an MCP caller', async () => {
    const actor = await resolveFeedActor({
      user: null,
      apiAccount: { id: 'acct-9', name: 'Ops Bot' },
    });
    expect(actor).toEqual({ kind: 'mcp', id: 'acct-9', label: 'account "Ops Bot"' });
  });

  it('falls back to system when there is no user, worker, or account', async () => {
    const actor = await resolveFeedActor({ user: null, apiAccount: null });
    expect(actor).toEqual({ kind: 'system', id: null, label: 'system' });
  });

  it('prefers the session user over an API account or worker', async () => {
    const actor = await resolveFeedActor({
      user: { id: 'u1', email: 'jane@co' },
      apiAccount: { id: 'acct-9', name: 'Ops Bot' },
      actorWorkerId: 'w1',
    });
    expect(actor.kind).toBe('user');
  });
});

describe('systemActor', () => {
  it('names the predicate rather than reading as a generic System', () => {
    expect(systemActor('dormancy: no goal criteria')).toEqual({
      kind: 'system',
      id: null,
      label: 'dormancy: no goal criteria',
    });
  });
});

describe('postMissionFeedEvent', () => {
  beforeEach(reset);

  it('inserts a note carrying the actor kind and label', async () => {
    await postMissionFeedEvent({
      missionId: 'm1',
      type: 'update',
      title: 'Mission reopened',
      body: 'completed → active',
      actor: { kind: 'mcp', id: 'acct-9', label: 'account "Ops Bot"' },
    });

    expect(insertedNotes.length).toBe(1);
    expect(insertedNotes[0]).toMatchObject({
      missionId: 'm1',
      authorType: 'mcp',
      actorLabel: 'account "Ops Bot"',
      title: 'Mission reopened',
      body: 'completed → active',
      collapseKey: null,
      collapseCount: 1,
    });
    expect(mockTriggerEvent).toHaveBeenCalledWith(
      'mission-m1',
      'mission:note_posted',
      expect.objectContaining({ title: 'Mission reopened', authorType: 'mcp' }),
    );
  });

  it('inserts a fresh row when no note matches the collapse key', async () => {
    await postMissionFeedEvent({
      missionId: 'm1',
      type: 'update',
      title: 'Mission configuration updated',
      body: 'priority: 0 → 5',
      actor: { kind: 'user', id: 'u1', label: 'jane@co' },
      collapseKey: 'config:user:u1',
    });

    expect(insertedNotes.length).toBe(1);
    expect(insertedNotes[0].collapseKey).toBe('config:user:u1');
  });

  it('merges into the existing row instead of inserting when a recent match exists', async () => {
    recentNote = {
      id: 'note-1',
      body: 'priority: 0 → 5',
      collapseCount: 1,
    };

    await postMissionFeedEvent({
      missionId: 'm1',
      type: 'update',
      title: 'Mission configuration updated',
      body: 'pacingMode: eager → paced',
      actor: { kind: 'user', id: 'u1', label: 'jane@co' },
      collapseKey: 'config:user:u1',
    });

    expect(insertedNotes.length).toBe(0);
    expect(updatedNotes.length).toBe(1);
    expect(updatedNotes[0].data.collapseCount).toBe(2);
    // Both the earlier and the new field survive in the merged body.
    expect(updatedNotes[0].data.body).toContain('priority: 0 → 5');
    expect(updatedNotes[0].data.body).toContain('pacingMode: eager → paced');
  });

  it('replaces (not duplicates) the line for a field that changes again in the same window', async () => {
    recentNote = {
      id: 'note-1',
      body: 'priority: 0 → 5',
      collapseCount: 1,
    };

    await postMissionFeedEvent({
      missionId: 'm1',
      type: 'update',
      title: 'Mission configuration updated',
      body: 'priority: 5 → 10',
      actor: { kind: 'user', id: 'u1', label: 'jane@co' },
      collapseKey: 'config:user:u1',
    });

    const lines = updatedNotes[0].data.body.split('\n');
    expect(lines.filter((l: string) => l.startsWith('priority:')).length).toBe(1);
    expect(updatedNotes[0].data.body).toContain('priority: 5 → 10');
  });
});

describe('criterionLabel', () => {
  it('prefers label, then description, then type, then a malformed fallback', () => {
    expect(criterionLabel({ label: 'No open tasks', type: 'no_open_tasks' })).toBe('No open tasks');
    expect(criterionLabel({ description: 'desc only' })).toBe('desc only');
    expect(criterionLabel({ type: 'command' })).toBe('command');
    expect(criterionLabel({})).toBe('(malformed criterion)');
  });
});

describe('diffGoalCriteria', () => {
  it('reports additions and removals by whole-object identity', () => {
    const before = [{ type: 'no_open_tasks', label: 'No open tasks' }];
    const after = [
      { type: 'no_open_tasks', label: 'No open tasks' },
      { type: 'command', command: 'bun test', label: 'Tests pass' },
    ];

    const { added, removed } = diffGoalCriteria(before, after);
    expect(added).toEqual([{ type: 'command', command: 'bun test', label: 'Tests pass' }]);
    expect(removed).toEqual([]);
  });

  it('treats editing one field of a criterion as a removal plus an addition', () => {
    const before = [{ type: 'command', command: 'bun test', label: 'Tests' }];
    const after = [{ type: 'command', command: 'bun run test', label: 'Tests' }];

    const { added, removed } = diffGoalCriteria(before, after);
    expect(removed).toEqual(before);
    expect(added).toEqual(after);
  });
});
