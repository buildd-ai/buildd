import { describe, it, expect } from 'bun:test';
import { evaluateGoalCriteria, evaluateInitiativeKPIs, type GoalCriterion } from '../mission-helpers';

// ─── evaluateGoalCriteria ──────────────────────────────────────────────────────

const MISSION = { id: 'mission-1', workingBranch: 'feature/my-branch' };
const NOW = '2026-08-08T12:00:00.000Z';

function makeCtx(overrides: Partial<Parameters<typeof evaluateGoalCriteria>[2]> = {}) {
  return {
    tasks: [],
    workers: [],
    artifacts: [],
    evaluatedBy: 'manual' as const,
    now: NOW,
    ...overrides,
  };
}

describe('evaluateGoalCriteria — no-criteria passthrough', () => {
  it('returns pass overall when criteria array is empty', () => {
    const state = evaluateGoalCriteria(MISSION, [], makeCtx());
    expect(state.overall).toBe('pass');
    expect(state.criteria).toHaveLength(0);
    expect(state.evaluatedBy).toBe('manual');
    expect(state.evaluatedAt).toBe(NOW);
  });
});

describe('evaluateGoalCriteria — no_open_tasks', () => {
  const criterion: GoalCriterion = { type: 'no_open_tasks' };

  it('passes when all deliverable tasks are closed', () => {
    const tasks = [
      { id: 't1', title: 'Do work', status: 'completed' },
      { id: 't2', title: 'Do more', status: 'cancelled' },
    ];
    const state = evaluateGoalCriteria(MISSION, [criterion], makeCtx({ tasks }));
    expect(state.overall).toBe('pass');
    expect(state.criteria[0].verdict).toBe('pass');
  });

  it('fails when an open task exists', () => {
    const tasks = [
      { id: 't1', title: 'Do work', status: 'completed' },
      { id: 't2', title: 'Still pending', status: 'in_progress' },
    ];
    const state = evaluateGoalCriteria(MISSION, [criterion], makeCtx({ tasks }));
    expect(state.overall).toBe('fail');
    expect(state.criteria[0].verdict).toBe('fail');
  });

  it('passes when the only tasks are coordination (non-deliverable) tasks', () => {
    const tasks = [
      { id: 't1', kind: 'coordination', title: 'Coordinate', status: 'in_progress' },
    ];
    const state = evaluateGoalCriteria(MISSION, [criterion], makeCtx({ tasks }));
    expect(state.overall).toBe('pass');
  });

  it('stores the criterion label when provided', () => {
    const labelledCriterion: GoalCriterion = { type: 'no_open_tasks', label: 'All tasks done' };
    const state = evaluateGoalCriteria(MISSION, [labelledCriterion], makeCtx());
    expect(state.criteria[0].label).toBe('All tasks done');
  });
});

describe('evaluateGoalCriteria — artifact_exists', () => {
  const criterion: GoalCriterion = { type: 'artifact_exists', artifactType: 'summary' };

  it('passes when a matching artifact is present', () => {
    const artifacts = [{ key: 'final', type: 'summary' }];
    const state = evaluateGoalCriteria(MISSION, [criterion], makeCtx({ artifacts }));
    expect(state.criteria[0].verdict).toBe('pass');
    expect(state.overall).toBe('pass');
  });

  it('fails when no matching artifact exists', () => {
    const artifacts = [{ key: 'other', type: 'report' }];
    const state = evaluateGoalCriteria(MISSION, [criterion], makeCtx({ artifacts }));
    expect(state.criteria[0].verdict).toBe('fail');
    expect(state.overall).toBe('fail');
  });

  it('matches on key when specified', () => {
    const keyCriterion: GoalCriterion = { type: 'artifact_exists', key: 'spec-doc' };
    const artifacts = [{ key: 'spec-doc', type: 'content' }];
    const state = evaluateGoalCriteria(MISSION, [keyCriterion], makeCtx({ artifacts }));
    expect(state.criteria[0].verdict).toBe('pass');
  });

  it('fails when key matches but type does not', () => {
    const strictCriterion: GoalCriterion = { type: 'artifact_exists', key: 'spec-doc', artifactType: 'report' };
    const artifacts = [{ key: 'spec-doc', type: 'content' }];
    const state = evaluateGoalCriteria(MISSION, [strictCriterion], makeCtx({ artifacts }));
    expect(state.criteria[0].verdict).toBe('fail');
  });

  it('passes with no filter (any artifact)', () => {
    const anyCriterion: GoalCriterion = { type: 'artifact_exists' };
    const artifacts = [{ key: null, type: 'data' }];
    const state = evaluateGoalCriteria(MISSION, [anyCriterion], makeCtx({ artifacts }));
    expect(state.criteria[0].verdict).toBe('pass');
  });
});

describe('evaluateGoalCriteria — all_prs_merged', () => {
  it('fails when no PR workers found', () => {
    const workers = [{ taskId: 't1', mergedAt: null, prUrl: null, branchName: 'feature/x' }];
    const criterion: GoalCriterion = { type: 'all_prs_merged' };
    const state = evaluateGoalCriteria(MISSION, [criterion], makeCtx({ workers }));
    expect(state.criteria[0].verdict).toBe('fail');
    expect(state.criteria[0].evidence).toContain('No PR workers found');
  });

  it('fails when a PR is not merged', () => {
    const workers = [
      { taskId: 't1', mergedAt: null, prUrl: 'https://github.com/pr/1', branchName: 'feature/x' },
    ];
    const criterion: GoalCriterion = { type: 'all_prs_merged', requireBranchDeleted: false };
    const state = evaluateGoalCriteria(MISSION, [criterion], makeCtx({ workers }));
    expect(state.criteria[0].verdict).toBe('fail');
    expect(state.criteria[0].evidence).toContain('1 PR(s) not yet merged');
  });

  it('passes when all PRs merged and requireBranchDeleted=false', () => {
    const workers = [
      { taskId: 't1', mergedAt: new Date('2026-01-01'), prUrl: 'https://github.com/pr/1', branchName: 'feature/x' },
    ];
    const criterion: GoalCriterion = { type: 'all_prs_merged', requireBranchDeleted: false };
    const state = evaluateGoalCriteria(MISSION, [criterion], makeCtx({ workers }));
    expect(state.criteria[0].verdict).toBe('pass');
  });

  it('passes when all PRs merged and requireBranchDeleted not set (default false)', () => {
    const workers = [
      { taskId: 't1', mergedAt: new Date('2026-01-01'), prUrl: 'https://github.com/pr/1', branchName: 'feature/x' },
    ];
    const criterion: GoalCriterion = { type: 'all_prs_merged' };
    const state = evaluateGoalCriteria(MISSION, [criterion], makeCtx({ workers }));
    // branchDeleted is undefined but requireBranchDeleted defaults to false — pass on mergedAt alone
    expect(state.criteria[0].verdict).toBe('pass');
    expect(state.overall).toBe('pass');
  });

  it('returns UNVERIFIED when branch deleted status is unknown and requireBranchDeleted=true', () => {
    const workers = [
      { taskId: 't1', mergedAt: new Date('2026-01-01'), prUrl: 'https://github.com/pr/1', branchName: 'feature/x' },
    ];
    const criterion: GoalCriterion = { type: 'all_prs_merged', requireBranchDeleted: true };
    const state = evaluateGoalCriteria(MISSION, [criterion], makeCtx({ workers }));
    // branchDeleted is undefined → UNVERIFIED (explicitly required branch deletion)
    expect(state.criteria[0].verdict).toBe('UNVERIFIED');
    expect(state.overall).toBe('UNVERIFIED');
  });

  it('fails when PRs merged but branch still live (requireBranchDeleted=true)', () => {
    const workers = [
      { taskId: 't1', mergedAt: new Date('2026-01-01'), prUrl: 'https://github.com/pr/1', branchName: 'feature/x', branchDeleted: false },
    ];
    const criterion: GoalCriterion = { type: 'all_prs_merged', requireBranchDeleted: true };
    const state = evaluateGoalCriteria(MISSION, [criterion], makeCtx({ workers }));
    expect(state.criteria[0].verdict).toBe('fail');
    expect(state.criteria[0].evidence).toContain('Working branch still exists');
  });

  it('passes when PRs merged and branch is deleted', () => {
    const workers = [
      { taskId: 't1', mergedAt: new Date('2026-01-01'), prUrl: 'https://github.com/pr/1', branchName: 'feature/x', branchDeleted: true },
    ];
    const criterion: GoalCriterion = { type: 'all_prs_merged', requireBranchDeleted: true };
    const state = evaluateGoalCriteria(MISSION, [criterion], makeCtx({ workers }));
    expect(state.criteria[0].verdict).toBe('pass');
  });
});

describe('evaluateGoalCriteria — command criterion', () => {
  it('always returns UNVERIFIED (requires worker task dispatch)', () => {
    const criterion: GoalCriterion = { type: 'command', command: 'bun test' };
    const state = evaluateGoalCriteria(MISSION, [criterion], makeCtx());
    expect(state.criteria[0].verdict).toBe('UNVERIFIED');
    expect(state.overall).toBe('UNVERIFIED');
    expect(state.criteria[0].evidence).toContain('worker task dispatch');
  });
});

describe('evaluateGoalCriteria — metric criterion', () => {
  it('always returns UNVERIFIED (metric query not implemented)', () => {
    const criterion: GoalCriterion = { type: 'metric', query: 'error_rate', operator: 'lt', threshold: 0.01 };
    const state = evaluateGoalCriteria(MISSION, [criterion], makeCtx());
    expect(state.criteria[0].verdict).toBe('UNVERIFIED');
    expect(state.criteria[0].evidence).toContain('not implemented');
  });
});

describe('evaluateGoalCriteria — description criterion', () => {
  it('returns NOT_EVALUATED awaiting LLM evaluation', () => {
    const criterion: GoalCriterion = { type: 'description', description: 'Scorecard artifact produced covering all retrieval layers' };
    const state = evaluateGoalCriteria(MISSION, [criterion], makeCtx());
    expect(state.criteria[0].verdict).toBe('NOT_EVALUATED');
    expect(state.criteria[0].evidence).toContain('Awaiting LLM evaluation');
    // NOT_EVALUATED does not drag overall down — no evaluated criteria → UNVERIFIED
    expect(state.overall).toBe('UNVERIFIED');
  });

  it('records the criterion label when provided', () => {
    const criterion: GoalCriterion = { type: 'description', description: 'All gaps closed', label: 'Gaps resolved' };
    const state = evaluateGoalCriteria(MISSION, [criterion], makeCtx());
    expect(state.criteria[0].label).toBe('Gaps resolved');
  });

  it('overall=pass when structural criterion passes and description is NOT_EVALUATED', () => {
    const criteria: GoalCriterion[] = [
      { type: 'no_open_tasks' },
      { type: 'description', description: 'BM25 lexical search is functional' },
    ];
    const state = evaluateGoalCriteria(MISSION, criteria, makeCtx());
    expect(state.criteria[0].verdict).toBe('pass');
    expect(state.criteria[1].verdict).toBe('NOT_EVALUATED');
    // NOT_EVALUATED excluded from overall — only no_open_tasks (pass) counts
    expect(state.overall).toBe('pass');
  });

  it('overall=fail when structural criterion fails even with description NOT_EVALUATED', () => {
    const criteria: GoalCriterion[] = [
      { type: 'artifact_exists', artifactType: 'report' }, // fails (no artifacts)
      { type: 'description', description: 'BM25 lexical search is functional' },
    ];
    const state = evaluateGoalCriteria(MISSION, criteria, makeCtx());
    expect(state.criteria[0].verdict).toBe('fail');
    expect(state.criteria[1].verdict).toBe('NOT_EVALUATED');
    expect(state.overall).toBe('fail');
  });
});

describe('evaluateGoalCriteria — overall verdict logic', () => {
  it('overall=pass when all criteria pass', () => {
    const criteria: GoalCriterion[] = [
      { type: 'no_open_tasks' },
      { type: 'artifact_exists' },
    ];
    const artifacts = [{ key: null, type: 'summary' }];
    const state = evaluateGoalCriteria(MISSION, criteria, makeCtx({ artifacts }));
    expect(state.overall).toBe('pass');
  });

  it('overall=fail when any criterion fails (even with pass criteria)', () => {
    const criteria: GoalCriterion[] = [
      { type: 'no_open_tasks' },
      { type: 'artifact_exists', artifactType: 'report' }, // will fail (no artifacts)
    ];
    const state = evaluateGoalCriteria(MISSION, criteria, makeCtx());
    expect(state.overall).toBe('fail');
  });

  it('overall=UNVERIFIED when some pass and some UNVERIFIED (no fail)', () => {
    const criteria: GoalCriterion[] = [
      { type: 'no_open_tasks' },   // pass (no tasks)
      { type: 'command', command: 'test' }, // UNVERIFIED
    ];
    const state = evaluateGoalCriteria(MISSION, criteria, makeCtx());
    expect(state.criteria[0].verdict).toBe('pass');
    expect(state.criteria[1].verdict).toBe('UNVERIFIED');
    expect(state.overall).toBe('UNVERIFIED');
  });

  it('overall=pass when all evaluated criteria pass (NOT_EVALUATED excluded)', () => {
    const criteria: GoalCriterion[] = [
      { type: 'no_open_tasks' },   // pass
      { type: 'description', description: 'some free-form check' }, // NOT_EVALUATED
    ];
    const state = evaluateGoalCriteria(MISSION, criteria, makeCtx());
    expect(state.criteria[0].verdict).toBe('pass');
    expect(state.criteria[1].verdict).toBe('NOT_EVALUATED');
    // NOT_EVALUATED excluded → overall determined by no_open_tasks alone
    expect(state.overall).toBe('pass');
  });

  it('overall=UNVERIFIED when all criteria are NOT_EVALUATED', () => {
    const criteria: GoalCriterion[] = [
      { type: 'description', description: 'criterion one' },
      { type: 'description', description: 'criterion two' },
    ];
    const state = evaluateGoalCriteria(MISSION, criteria, makeCtx());
    expect(state.criteria.every(c => c.verdict === 'NOT_EVALUATED')).toBe(true);
    // No evaluated criteria → UNVERIFIED (conservative)
    expect(state.overall).toBe('UNVERIFIED');
  });

  it('fail takes precedence over UNVERIFIED in overall verdict', () => {
    const criteria: GoalCriterion[] = [
      { type: 'command', command: 'test' }, // UNVERIFIED
      { type: 'artifact_exists', artifactType: 'report' }, // fail (no artifact)
    ];
    const state = evaluateGoalCriteria(MISSION, criteria, makeCtx());
    expect(state.overall).toBe('fail');
  });

  it('criterion indexes are sequential', () => {
    const criteria: GoalCriterion[] = [
      { type: 'no_open_tasks' },
      { type: 'command', command: 'test' },
      { type: 'artifact_exists' },
    ];
    const artifacts = [{ key: null, type: 'summary' }];
    const state = evaluateGoalCriteria(MISSION, criteria, makeCtx({ artifacts }));
    expect(state.criteria.map(c => c.index)).toEqual([0, 1, 2]);
  });
});

describe('evaluateGoalCriteria — evaluatedBy attribution', () => {
  it('records the evaluatedBy from context', () => {
    const state = evaluateGoalCriteria(MISSION, [], { tasks: [], workers: [], artifacts: [], evaluatedBy: 'auto', now: NOW });
    expect(state.evaluatedBy).toBe('auto');
  });

  it('records mcp attribution', () => {
    const state = evaluateGoalCriteria(MISSION, [], { tasks: [], workers: [], artifacts: [], evaluatedBy: 'mcp', now: NOW });
    expect(state.evaluatedBy).toBe('mcp');
  });
});

// ─── evaluateInitiativeKPIs ────────────────────────────────────────────────────

describe('evaluateInitiativeKPIs', () => {
  it('returns empty kpis array and pass overall when no KPIs set', () => {
    const state = evaluateInitiativeKPIs('init-1', [], { evaluatedBy: 'manual', now: NOW });
    expect(state.kpis).toHaveLength(0);
    expect(state.overall).toBe('pass');
  });

  it('all KPIs return UNVERIFIED (metric query not implemented)', () => {
    const kpis = [
      { name: 'Latency p95 under 200ms', metric: 'latency_p95', operator: 'lt' as const, threshold: 200 },
      { name: 'Error rate under 1%', metric: 'error_rate', operator: 'lt' as const, threshold: 0.01 },
    ];
    const state = evaluateInitiativeKPIs('init-1', kpis, { evaluatedBy: 'auto', now: NOW });
    expect(state.kpis).toHaveLength(2);
    expect(state.kpis[0].verdict).toBe('UNVERIFIED');
    expect(state.kpis[1].verdict).toBe('UNVERIFIED');
  });

  it('overall=UNVERIFIED when blocking KPIs are UNVERIFIED', () => {
    const kpis = [
      { name: 'Latency', metric: 'latency', operator: 'lt' as const, threshold: 200, blocking: true },
    ];
    const state = evaluateInitiativeKPIs('init-1', kpis, { evaluatedBy: 'auto', now: NOW });
    expect(state.overall).toBe('UNVERIFIED');
  });

  it('overall=pass when all KPIs are non-blocking (no blocking KPIs)', () => {
    const kpis = [
      { name: 'Revenue metric', metric: 'revenue', operator: 'gt' as const, threshold: 1000, blocking: false },
    ];
    const state = evaluateInitiativeKPIs('init-1', kpis, { evaluatedBy: 'manual', now: NOW });
    // Non-blocking only → no blocker → overall pass
    expect(state.overall).toBe('pass');
  });

  it('records kpi names in output', () => {
    const kpis = [
      { name: 'P95 latency', metric: 'latency', operator: 'lt' as const, threshold: 200 },
    ];
    const state = evaluateInitiativeKPIs('init-1', kpis, { evaluatedBy: 'mcp', now: NOW });
    expect(state.kpis[0].name).toBe('P95 latency');
    expect(state.kpis[0].index).toBe(0);
  });

  it('records evaluatedAt and evaluatedBy', () => {
    const state = evaluateInitiativeKPIs('init-1', [], { evaluatedBy: 'mcp', now: NOW });
    expect(state.evaluatedAt).toBe(NOW);
    expect(state.evaluatedBy).toBe('mcp');
  });
});
