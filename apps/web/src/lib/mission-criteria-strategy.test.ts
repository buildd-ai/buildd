import { describe, it, expect, beforeEach, mock } from 'bun:test';

/**
 * Workspace prose-grader resolution (gitConfig.criteriaGrader).
 */

let workspaceRow: any = null;

mock.module('drizzle-orm', () => ({
  eq: (...args: any[]) => ({ _op: 'eq', args }),
}));

mock.module('@buildd/core/db/schema', () => ({
  workspaces: Symbol('workspaces'),
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workspaces: { findFirst: () => Promise.resolve(workspaceRow) },
    },
  },
}));

const { resolveWorkspaceCriteriaGrader } = await import('./mission-criteria-strategy');
const { pickCriteriaGrader } = await import('./mission-criteria-grader');

function reset() {
  workspaceRow = null;
}

describe('legacy evaluation strategy', () => {
  it('is gone — prose grading is chosen per criterion, not per workspace/team strategy', async () => {
    const mod = await import('./mission-criteria-strategy');
    expect('resolveEvaluationStrategy' in mod).toBe(false);
  });
});

describe('prose criterion grader — mission > workspace > auto', () => {
  beforeEach(reset);

  it('reads gitConfig.criteriaGrader off the workspace', async () => {
    workspaceRow = { gitConfig: { criteriaGrader: 'runner' } };
    expect(await resolveWorkspaceCriteriaGrader('ws-1')).toBe('runner');
  });

  it('is null with no workspace, no gitConfig, or an unrecognised value', async () => {
    expect(await resolveWorkspaceCriteriaGrader(null)).toBeNull();
    workspaceRow = { gitConfig: null };
    expect(await resolveWorkspaceCriteriaGrader('ws-1')).toBeNull();
    workspaceRow = { gitConfig: { criteriaGrader: 'llm' } };
    expect(await resolveWorkspaceCriteriaGrader('ws-1')).toBeNull();
  });

  it('the criterion setting wins over the workspace', () => {
    expect(pickCriteriaGrader({ grader: 'api' }, 'runner')).toBe('api');
    expect(pickCriteriaGrader({ grader: 'runner' }, 'api')).toBe('runner');
  });

  it('falls back to the workspace, then to auto', () => {
    expect(pickCriteriaGrader({}, 'runner')).toBe('runner');
    expect(pickCriteriaGrader({}, null)).toBe('auto');
    expect(pickCriteriaGrader(null, null)).toBe('auto');
  });

  it('ignores an unrecognised criterion value instead of trusting it', () => {
    expect(pickCriteriaGrader({ grader: 'gpt' }, 'runner')).toBe('runner');
    expect(pickCriteriaGrader({ grader: 42 }, null)).toBe('auto');
  });
});
