import { describe, it, expect, beforeEach, mock } from 'bun:test';

// Table sentinels — identity lets us attribute each db call to a table.
const T = {
  workspaces: { __t: 'workspaces' }, missions: { __t: 'missions' }, workspaceSkills: { __t: 'workspaceSkills' },
  accountWorkspaces: { __t: 'accountWorkspaces' }, connectorWorkspaces: { __t: 'connectorWorkspaces' },
  secrets: { __t: 'secrets' }, artifacts: { __t: 'artifacts' }, migrationLog: { __t: 'migrationLog' },
  workers: { __t: 'workers' }, taskSchedules: { __t: 'taskSchedules' },
};

const updateCalls: { table: any; set: any }[] = [];
const deleteCalls: { table: any }[] = [];
const insertCalls: { table: any; values: any }[] = [];

const mockMigrationFindFirst = mock(async () => undefined as any); // undefined => phase not yet done
const mockWorkspacesFindFirst = mock(async () => ({ teamId: 'team-dst' }) as any);
let workspaceUpdateReturning: any[] = [{ id: 'ws-1' }];

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      migrationLog: { findFirst: mockMigrationFindFirst },
      workspaces: { findFirst: mockWorkspacesFindFirst },
    },
    insert: (table: any) => ({
      values: (values: any) => {
        insertCalls.push({ table, values });
        return {
          onConflictDoUpdate: () => Promise.resolve([]),
          returning: () => Promise.resolve(table === T.artifacts ? [{ id: 'art-1' }] : []),
        };
      },
    }),
    update: (table: any) => ({
      set: (set: any) => ({
        where: () => {
          updateCalls.push({ table, set });
          if (table === T.workspaces) return { returning: () => Promise.resolve(workspaceUpdateReturning) };
          return Promise.resolve([]);
        },
      }),
    }),
    delete: (table: any) => ({ where: () => { deleteCalls.push({ table }); return Promise.resolve([]); } }),
  },
}));

mock.module('@buildd/core/db/schema', () => T);
mock.module('drizzle-orm', () => ({
  eq: (a: any, b: any) => ({ a, b, op: 'eq' }),
  and: (...args: any[]) => ({ args, op: 'and' }),
  isNull: (a: any) => ({ a, op: 'isNull' }),
  sql: () => ({}),
  inArray: (a: any, b: any) => ({ a, b, op: 'inArray' }),
}));

import { executeMigrationPhases, MigrationPhaseError, type DryRunReport } from './workspace-migration';

function report(): DryRunReport {
  return {
    workspaceId: 'ws-1', workspaceName: 'Cue', sourceTeamId: 'team-src', sourceTeamName: 'Buildd',
    destinationTeamId: 'team-dst', destinationTeamName: 'Cue Service', generatedAt: 'now',
    precheck: { status: 'PASS', githubApp: { org: null, ok: true } },
    summary: { MOVES_CLEANLY: 0, NEEDS_RE_ENTRY: 0, NEEDS_RE_AUTH: 0, WILL_BREAK: 0, LEFT_BEHIND: 0 },
    groups: [
      { entity: 'Account Access', disposition: 'WILL_BREAK', count: 1, items: [{ key: 'account:a1', label: 'runner-prod', disposition: 'WILL_BREAK' }] },
      { entity: 'Connectors', disposition: 'NEEDS_RE_AUTH', count: 1, items: [{ key: 'connector:c1', label: 'Linear (oauth)', disposition: 'NEEDS_RE_AUTH' }] },
      { entity: 'Secrets (workspace-scoped)', disposition: 'NEEDS_RE_ENTRY', count: 1, items: [{ key: 'secret:custom:X', label: 'custom "X"', disposition: 'NEEDS_RE_ENTRY' }] },
    ],
    requiredAcks: ['account:a1', 'connector:c1', 'secret:custom:X', 'mission-dep:m1'],
  };
}

const opts = () => ({ runId: 'run-1', workspaceId: 'ws-1', sourceTeamId: 'team-src', destinationTeamId: 'team-dst', report: report(), migratedAt: 'now' });

function tableNames(calls: { table: any }[]) { return calls.map((c) => c.table.__t); }

describe('executeMigrationPhases', () => {
  beforeEach(() => {
    updateCalls.length = 0; deleteCalls.length = 0; insertCalls.length = 0;
    mockMigrationFindFirst.mockReset(); mockMigrationFindFirst.mockResolvedValue(undefined as any);
    mockWorkspacesFindFirst.mockReset(); mockWorkspacesFindFirst.mockResolvedValue({ teamId: 'team-dst' } as any);
    workspaceUpdateReturning = [{ id: 'ws-1' }];
  });

  it('moves workspace/missions/skills teamId and deletes the three destructive junctions, in order', async () => {
    const { outcomes, checklistArtifactId } = await executeMigrationPhases(opts());

    // All 7 phases completed.
    expect(outcomes.map((o) => o.phase)).toEqual([
      'workspace_team', 'missions_team', 'skills_team',
      'clear_account_workspaces', 'clear_connector_workspaces', 'delete_secrets', 'checklist_artifact',
    ]);
    expect(outcomes.every((o) => o.status === 'completed')).toBe(true);

    // teamId moves target workspaces, missions, workspace_skills.
    const teamMoves = updateCalls.filter((c) => c.set?.teamId === 'team-dst').map((c) => c.table.__t);
    expect(teamMoves).toEqual(['workspaces', 'missions', 'workspaceSkills']);

    // Destructive deletes are the three inaccessible junctions — and NOTHING else.
    expect(tableNames(deleteCalls)).toEqual(['accountWorkspaces', 'connectorWorkspaces', 'secrets']);

    // Checklist artifact created.
    expect(insertCalls.some((c) => c.table === T.artifacts)).toBe(true);
    expect(checklistArtifactId).toBe('art-1');
  });

  it('never mutates workers or task schedules (FK-stable, in-flight work continues)', async () => {
    await executeMigrationPhases(opts());
    const touched = [...tableNames(updateCalls), ...tableNames(deleteCalls)];
    expect(touched).not.toContain('workers');
    expect(touched).not.toContain('taskSchedules');
  });

  it('severs dependsOnMission FKs flagged as broken', async () => {
    await executeMigrationPhases(opts());
    // One of the missions updates sets dependsOnMissionId: null (the mission-dep:m1 ack).
    expect(updateCalls.some((c) => c.table === T.missions && 'dependsOnMissionId' in (c.set ?? {}))).toBe(true);
  });

  it('records deleted secret labels + account names in the ledger detail', async () => {
    const { outcomes } = await executeMigrationPhases(opts());
    const secretsPhase = outcomes.find((o) => o.phase === 'delete_secrets');
    expect(secretsPhase?.detail.deletedSecrets).toEqual(['custom "X"']);
    const accountsPhase = outcomes.find((o) => o.phase === 'clear_account_workspaces');
    expect(accountsPhase?.detail.removedAccounts).toEqual(['runner-prod']);
  });

  it('is idempotent — skips phases already marked completed for the run', async () => {
    mockMigrationFindFirst.mockImplementation(async (_arg: any) => {
      // Simulate workspace_team already done on a prior (failed) run.
      return undefined; // default; overridden below per-call via mockResolvedValueOnce
    });
    mockMigrationFindFirst.mockResolvedValueOnce({ status: 'completed', detail: { moved: true } } as any);
    const { outcomes } = await executeMigrationPhases(opts());
    expect(outcomes[0]).toEqual({ phase: 'workspace_team', status: 'skipped', detail: { moved: true } });
    // The skipped phase issued no workspace teamId update.
    expect(updateCalls.some((c) => c.table === T.workspaces && c.set?.teamId === 'team-dst')).toBe(false);
  });

  it('treats an already-moved workspace as success (idempotent guard), not a conflict', async () => {
    workspaceUpdateReturning = []; // guarded update matched nothing
    mockWorkspacesFindFirst.mockResolvedValue({ teamId: 'team-dst' } as any); // already at destination
    const { outcomes } = await executeMigrationPhases(opts());
    expect(outcomes.find((o) => o.phase === 'workspace_team')?.status).toBe('completed');
  });

  it('throws MigrationPhaseError (and marks the phase failed) on a genuine conflict', async () => {
    workspaceUpdateReturning = [];
    mockWorkspacesFindFirst.mockResolvedValue({ teamId: 'team-other' } as any); // someone else won
    let err: any;
    try { await executeMigrationPhases(opts()); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(MigrationPhaseError);
    expect(err.phase).toBe('workspace_team');
    // Ledger updated to failed for that phase.
    expect(updateCalls.some((c) => c.table === T.migrationLog && c.set?.status === 'failed')).toBe(true);
  });
});
