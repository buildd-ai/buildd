/**
 * Where a rated piece of AI content lives. Feedback rows carry only an entity
 * type and id; access checks and memory attribution both need its workspace,
 * or its team when the content is team-level (a mission or artifact with no
 * workspace).
 *
 * Each lookup's WHERE is rendered through PgDialect, so the column and the ids
 * it binds are observed, not assumed from a mocked return.
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';

const NOTE = '10000000-0000-4000-8000-000000000001';
const MISSION = '20000000-0000-4000-8000-000000000002';
const ARTIFACT = '30000000-0000-4000-8000-000000000003';
const TASK = '40000000-0000-4000-8000-000000000004';
const INITIATIVE = '50000000-0000-4000-8000-000000000005';

const dialect = new PgDialect();
/** One entry per lookup: the `"table"."column" in (...)` it rendered, and its params. */
const lookups: Array<{ col: string; values: unknown[] }> = [];
function record(where: unknown) {
  const q = dialect.sqlToQuery(where as any);
  const m = q.sql.match(/^"(\w+)"\."(\w+)" in \(/);
  lookups.push({ col: m ? `${m[1]}.${m[2]}` : q.sql, values: q.params });
}

let notes: Array<{ id: string; missionId: string | null }> = [];
let missions: Array<{ id: string; workspaceId: string | null; teamId: string }> = [];
let artifacts: Array<{ id: string; workspaceId: string | null; missionId: string | null; initiativeId: string | null }> = [];
let tasks: Array<{ id: string; workspaceId: string | null }> = [];
let initiatives: Array<{ id: string; teamId: string }> = [];

const table = <T>(rows: () => T[]) => ({
  findMany: async ({ where }: { where: unknown }) => { record(where); return rows(); },
});

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      missionNotes: table(() => notes),
      missions: table(() => missions),
      artifacts: table(() => artifacts),
      tasks: table(() => tasks),
      initiatives: table(() => initiatives),
    },
  },
}));

const { resolveFeedbackEntityHome, resolveFeedbackEntityHomes, resolveFeedbackEntityWorkspaces } = await import('./feedback-entity-workspace');

beforeEach(() => {
  notes = [{ id: NOTE, missionId: MISSION }];
  missions = [{ id: MISSION, workspaceId: 'ws-m', teamId: 'team-m' }];
  artifacts = [{ id: ARTIFACT, workspaceId: 'ws-a', missionId: null, initiativeId: null }];
  tasks = [{ id: TASK, workspaceId: 'ws-t' }];
  initiatives = [{ id: INITIATIVE, teamId: 'team-i' }];
  lookups.length = 0;
});

describe('resolveFeedbackEntityHome: workspace content', () => {
  it('note -> its mission workspace, looked up by note id then mission id', async () => {
    expect(await resolveFeedbackEntityHome('note', NOTE)).toEqual({ workspaceId: 'ws-m' });
    expect(lookups).toEqual([
      { col: 'mission_notes.id', values: [NOTE] },
      { col: 'missions.id', values: [MISSION] },
    ]);
  });
  it('orchestration -> the mission workspace', async () => {
    expect(await resolveFeedbackEntityHome('orchestration', MISSION)).toEqual({ workspaceId: 'ws-m' });
    expect(lookups).toEqual([{ col: 'missions.id', values: [MISSION] }]);
  });
  it('artifact -> its workspace', async () => {
    expect(await resolveFeedbackEntityHome('artifact', ARTIFACT)).toEqual({ workspaceId: 'ws-a' });
    expect(lookups).toEqual([{ col: 'artifacts.id', values: [ARTIFACT] }]);
  });
  it('heartbeat -> the task workspace', async () => {
    expect(await resolveFeedbackEntityHome('heartbeat', TASK)).toEqual({ workspaceId: 'ws-t' });
    expect(lookups).toEqual([{ col: 'tasks.id', values: [TASK] }]);
  });
  it('summary and suggestion ids -> the task workspace, queried by the task id only', async () => {
    expect(await resolveFeedbackEntityHome('summary', `task-${TASK}-summary`)).toEqual({ workspaceId: 'ws-t' });
    expect(await resolveFeedbackEntityHome('summary', `task-${TASK}-suggestion`)).toEqual({ workspaceId: 'ws-t' });
    expect(lookups).toEqual([
      { col: 'tasks.id', values: [TASK] },
      { col: 'tasks.id', values: [TASK] },
    ]);
  });
});

describe('resolveFeedbackEntityHome: team-level content has a team, not a workspace', () => {
  it('a note on a mission with no workspace -> the mission team', async () => {
    missions = [{ id: MISSION, workspaceId: null, teamId: 'team-m' }];
    expect(await resolveFeedbackEntityHome('note', NOTE)).toEqual({ workspaceId: null, teamId: 'team-m' });
  });
  it('an artifact with no workspace -> its mission team', async () => {
    artifacts = [{ id: ARTIFACT, workspaceId: null, missionId: MISSION, initiativeId: null }];
    missions = [{ id: MISSION, workspaceId: null, teamId: 'team-m' }];
    expect(await resolveFeedbackEntityHome('artifact', ARTIFACT)).toEqual({ workspaceId: null, teamId: 'team-m' });
  });
  it('an artifact with no workspace on a workspace mission -> that workspace', async () => {
    artifacts = [{ id: ARTIFACT, workspaceId: null, missionId: MISSION, initiativeId: null }];
    expect(await resolveFeedbackEntityHome('artifact', ARTIFACT)).toEqual({ workspaceId: 'ws-m' });
  });
  it('an initiative artifact -> the initiative team', async () => {
    artifacts = [{ id: ARTIFACT, workspaceId: null, missionId: null, initiativeId: INITIATIVE }];
    expect(await resolveFeedbackEntityHome('artifact', ARTIFACT)).toEqual({ workspaceId: null, teamId: 'team-i' });
    expect(lookups).toContainEqual({ col: 'initiatives.id', values: [INITIATIVE] });
  });
});

describe('resolveFeedbackEntityHome: does not resolve', () => {
  it('an unknown or malformed id, without querying by it', async () => {
    expect(await resolveFeedbackEntityHome('summary', 'e1')).toBeNull();
    expect(await resolveFeedbackEntityHome('artifact', 'not-a-uuid')).toBeNull();
    expect(await resolveFeedbackEntityHome('conversation_message', TASK)).toBeNull();
    expect(lookups).toEqual([]);
  });
  it('an entity whose row is gone', async () => {
    artifacts = [];
    expect(await resolveFeedbackEntityHome('artifact', ARTIFACT)).toBeNull();
  });
  it('an artifact with no workspace, mission or initiative', async () => {
    artifacts = [{ id: ARTIFACT, workspaceId: null, missionId: null, initiativeId: null }];
    expect(await resolveFeedbackEntityHome('artifact', ARTIFACT)).toBeNull();
  });
});

describe('batch', () => {
  it('resolves by caller key; the workspace view leaves team-level content out', async () => {
    missions = [{ id: MISSION, workspaceId: null, teamId: 'team-m' }];
    const refs = [
      { key: 'f1', entityType: 'note', entityId: NOTE },
      { key: 'f2', entityType: 'artifact', entityId: ARTIFACT },
      { key: 'f3', entityType: 'summary', entityId: 'junk' },
    ];
    expect(Object.fromEntries(await resolveFeedbackEntityHomes(refs))).toEqual({
      f1: { workspaceId: null, teamId: 'team-m' },
      f2: { workspaceId: 'ws-a' },
    });
    expect(Object.fromEntries(await resolveFeedbackEntityWorkspaces(refs))).toEqual({ f2: 'ws-a' });
  });
});
