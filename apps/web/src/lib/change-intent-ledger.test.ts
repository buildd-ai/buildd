import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { RecordGateEventInput } from '@buildd/core/gate-events';

const events: RecordGateEventInput[] = [];
const notes: unknown[] = [];
let failNote = false;
mock.module('@buildd/core/db', () => ({ db: {
  query: { tasks: { findFirst: async () => ({ workspaceId: 'workspace-test', missionId: 'mission-test' }) } },
  insert: () => ({ values: async (note: unknown) => {
    if (failNote) throw new Error('note unavailable');
    notes.push(note);
  } }),
} }));
mock.module('./gate-ledger', () => ({
  GATE_SLUGS: { CHANGE_INTENT: 'change_intent' },
  fireGateEvent: (event: RecordGateEventInput) => { events.push(event); },
}));
const { postConflictWarnings } = await import('./change-intent');
const input = {
  currentTaskId: 'current-task', currentPrNumber: 10, currentPrUrl: null,
  currentSurfaces: ['schema', 'migrations'],
  conflicting: [
    { taskId: 'other-task', prNumber: 9, surface: 'schema' },
    { taskId: 'other-task', prNumber: 9, surface: 'migrations' },
  ],
};
beforeEach(() => { events.length = 0; notes.length = 0; failNote = false; });
describe('change-intent warning ledger', () => {
  test('records each delivered warning once, with workspace and mission attribution', async () => {
    await postConflictWarnings(input);
    expect(notes).toHaveLength(2);
    expect(events).toHaveLength(2);
    expect(events.map(event => event.taskId)).toEqual(['current-task', 'other-task']);
    for (const event of events) {
      expect(event).toMatchObject({ gate: 'change_intent', outcome: 'warned',
        workspaceId: 'workspace-test', missionId: 'mission-test', callerOrigin: 'system',
        surface: 'create_pr', reason: 'Change intent conflict surface overlap',
        detail: { surfaces: ['schema', 'migrations'], currentPrNumber: 10, conflictingPrNumber: 9, advisory: true },
      });
    }
  });
  test('does not record warnings when no conflict exists', async () => {
    await postConflictWarnings({ ...input, conflicting: [] });
    expect(events).toHaveLength(0);
    expect(notes).toHaveLength(0);
  });
  test('records the counterpart warning when there is no current task', async () => {
    await postConflictWarnings({ ...input, currentTaskId: null });
    expect(events).toHaveLength(1);
    expect(events[0].taskId).toBe('other-task');
  });
  test('a failed note write is non-fatal and does not count as a delivered warning', async () => {
    failNote = true;
    await expect(postConflictWarnings(input)).resolves.toBeUndefined();
    expect(events).toHaveLength(0);
  });
});
