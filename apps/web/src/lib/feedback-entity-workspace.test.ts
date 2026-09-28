/**
 * Which workspace a rated piece of AI content belongs to. Feedback rows carry
 * only an entity type and id; access checks and memory attribution both need
 * the workspace, so the mapping lives in one place.
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test';

const NOTE = '10000000-0000-4000-8000-000000000001';
const MISSION = '20000000-0000-4000-8000-000000000002';
const ARTIFACT = '30000000-0000-4000-8000-000000000003';
const TASK = '40000000-0000-4000-8000-000000000004';

let notes: Array<{ id: string; missionId: string | null }> = [];
let missions: Array<{ id: string; workspaceId: string | null }> = [];
let artifacts: Array<{ id: string; workspaceId: string | null }> = [];
let tasks: Array<{ id: string; workspaceId: string | null }> = [];
const queried: string[] = [];

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      missionNotes: { findMany: async () => { queried.push('notes'); return notes; } },
      missions: { findMany: async () => { queried.push('missions'); return missions; } },
      artifacts: { findMany: async () => { queried.push('artifacts'); return artifacts; } },
      tasks: { findMany: async () => { queried.push('tasks'); return tasks; } },
    },
  },
}));

const { resolveFeedbackEntityWorkspace, resolveFeedbackEntityWorkspaces } = await import('./feedback-entity-workspace');

beforeEach(() => {
  notes = [{ id: NOTE, missionId: MISSION }];
  missions = [{ id: MISSION, workspaceId: 'ws-m' }];
  artifacts = [{ id: ARTIFACT, workspaceId: 'ws-a' }];
  tasks = [{ id: TASK, workspaceId: 'ws-t' }];
  queried.length = 0;
});

describe('resolveFeedbackEntityWorkspace', () => {
  it('note -> its mission workspace', async () => {
    expect(await resolveFeedbackEntityWorkspace('note', NOTE)).toBe('ws-m');
  });
  it('orchestration -> the mission workspace', async () => {
    expect(await resolveFeedbackEntityWorkspace('orchestration', MISSION)).toBe('ws-m');
  });
  it('artifact -> its workspace', async () => {
    expect(await resolveFeedbackEntityWorkspace('artifact', ARTIFACT)).toBe('ws-a');
  });
  it('heartbeat -> the task workspace', async () => {
    expect(await resolveFeedbackEntityWorkspace('heartbeat', TASK)).toBe('ws-t');
  });
  it('summary and suggestion ids -> the task workspace', async () => {
    expect(await resolveFeedbackEntityWorkspace('summary', `task-${TASK}-summary`)).toBe('ws-t');
    expect(await resolveFeedbackEntityWorkspace('summary', `task-${TASK}-suggestion`)).toBe('ws-t');
  });
  it('an unknown or malformed id resolves to null without querying by it', async () => {
    expect(await resolveFeedbackEntityWorkspace('summary', 'e1')).toBeNull();
    expect(await resolveFeedbackEntityWorkspace('artifact', 'not-a-uuid')).toBeNull();
    expect(await resolveFeedbackEntityWorkspace('conversation_message', TASK)).toBeNull();
    expect(queried).toEqual([]);
  });
  it('an entity whose row is gone resolves to null', async () => {
    artifacts = [];
    expect(await resolveFeedbackEntityWorkspace('artifact', ARTIFACT)).toBeNull();
  });
});

describe('resolveFeedbackEntityWorkspaces', () => {
  it('resolves a batch by caller key', async () => {
    const out = await resolveFeedbackEntityWorkspaces([
      { key: 'f1', entityType: 'note', entityId: NOTE },
      { key: 'f2', entityType: 'artifact', entityId: ARTIFACT },
      { key: 'f3', entityType: 'summary', entityId: 'junk' },
    ]);
    expect(Object.fromEntries(out)).toEqual({ f1: 'ws-m', f2: 'ws-a' });
  });
});
