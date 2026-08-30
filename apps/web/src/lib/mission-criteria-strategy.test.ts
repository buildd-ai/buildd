import { describe, it, expect, beforeEach, mock } from 'bun:test';

/**
 * evaluationStrategy resolution — workspace-override → team-default → 'inline'.
 */

let workspaceRow: any = null;
let teamRow: any = null;

mock.module('drizzle-orm', () => ({
  eq: (...args: any[]) => ({ _op: 'eq', args }),
}));

mock.module('@buildd/core/db/schema', () => ({
  workspaces: Symbol('workspaces'),
  teams: Symbol('teams'),
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workspaces: { findFirst: () => Promise.resolve(workspaceRow) },
      teams: { findFirst: () => Promise.resolve(teamRow) },
    },
  },
}));

const { resolveEvaluationStrategy } = await import('./mission-criteria-strategy');

function reset() {
  workspaceRow = null;
  teamRow = null;
}

describe('resolveEvaluationStrategy', () => {
  beforeEach(reset);

  it('returns "inline" as code default when no workspace or team setting exists', async () => {
    workspaceRow = { criteriaEvaluationStrategy: null, teamId: 'team-1' };
    teamRow = { criteriaEvaluationStrategy: null };
    expect(await resolveEvaluationStrategy('team-1', 'ws-1')).toBe('inline');
  });

  it('returns workspace override when set', async () => {
    workspaceRow = { criteriaEvaluationStrategy: 'worker', teamId: 'team-1' };
    teamRow = { criteriaEvaluationStrategy: 'inline' };  // team default would be inline
    expect(await resolveEvaluationStrategy('team-1', 'ws-1')).toBe('worker');
  });

  it('falls back to team default when workspace has no override', async () => {
    workspaceRow = { criteriaEvaluationStrategy: null, teamId: 'team-1' };
    teamRow = { criteriaEvaluationStrategy: 'worker' };
    expect(await resolveEvaluationStrategy('team-1', 'ws-1')).toBe('worker');
  });

  it('skips workspace lookup when no workspaceId given and uses team default', async () => {
    teamRow = { criteriaEvaluationStrategy: 'worker' };
    expect(await resolveEvaluationStrategy('team-1', null)).toBe('worker');
  });

  it('returns "inline" code default when workspaceId missing and team has no setting', async () => {
    teamRow = { criteriaEvaluationStrategy: null };
    expect(await resolveEvaluationStrategy('team-1')).toBe('inline');
  });

  it('workspace setting takes precedence over team setting (workspace=worker, team=inline)', async () => {
    workspaceRow = { criteriaEvaluationStrategy: 'worker', teamId: 'team-1' };
    teamRow = { criteriaEvaluationStrategy: 'inline' };
    expect(await resolveEvaluationStrategy('team-1', 'ws-1')).toBe('worker');
  });

  it('workspace setting takes precedence over team setting (workspace=inline, team=worker)', async () => {
    workspaceRow = { criteriaEvaluationStrategy: 'inline', teamId: 'team-1' };
    teamRow = { criteriaEvaluationStrategy: 'worker' };
    expect(await resolveEvaluationStrategy('team-1', 'ws-1')).toBe('inline');
  });
});
