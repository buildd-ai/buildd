import { describe, it, expect } from 'bun:test';
import type { GoalCriterion, GoalCriteriaState } from '@buildd/shared';
import {
  criterionFingerprint,
  evaluateGoalCriteria,
  validateGoalCriteria,
  MECHANICAL_CRITERION_TYPES,
} from '@buildd/core/mission-helpers';
import {
  isAutomaticCheck,
  joinCriteriaState,
  verificationReadiness,
  plainCriteriaError,
  validateCriterionInContext,
} from './goal-criteria-panel';

const RAW_ENUMS = [...MECHANICAL_CRITERION_TYPES];

function stateFor(criteria: GoalCriterion[], evidence: string[], fingerprints = true): GoalCriteriaState {
  return {
    evaluatedAt: '2026-10-01T00:00:00.000Z',
    evaluatedBy: 'auto',
    overall: 'UNVERIFIED',
    criteria: criteria.map((c, i) => ({
      index: i,
      type: c.type,
      ...(c.label ? { label: c.label } : {}),
      verdict: 'UNVERIFIED' as const,
      evidence: evidence[i],
      ...(fingerprints ? { fingerprint: criterionFingerprint(c) } : {}),
    })),
  };
}

describe('joinCriteriaState — one source of truth per criterion row', () => {
  it('does not attach a verdict produced for a different criterion that used to sit in the same slot', () => {
    // The observed contradiction: a row labelled for a merged PR showing the
    // stored "No PRs found" evidence of whatever was evaluated at that index
    // before the criteria were edited.
    const before: GoalCriterion[] = [{ type: 'all_prs_merged' }];
    const state = stateFor(before, ['No PRs found for this mission yet']);
    const after: GoalCriterion[] = [{ type: 'all_prs_merged', label: 'PR #101 merged' }];

    expect(joinCriteriaState(after, state)).toEqual([null]);
  });

  it('follows a criterion that moved index after a sibling was deleted', () => {
    const a: GoalCriterion = { type: 'command', command: 'bun test' };
    const b: GoalCriterion = { type: 'no_open_tasks' };
    const state = stateFor([a, b], ['ran', 'All 3 deliverable task(s) are closed']);

    const joined = joinCriteriaState([b], state);
    expect(joined[0]?.evidence).toBe('All 3 deliverable task(s) are closed');
  });

  it('never attaches the deleted criterion\'s verdict to whatever moved into its slot', () => {
    const a: GoalCriterion = { type: 'command', command: 'bun test' };
    const b: GoalCriterion = { type: 'command', command: 'bun run lint' };
    const state = stateFor([a, b], ['test evidence', 'lint evidence']);
    const joined = joinCriteriaState([b], state);
    expect(joined[0]?.evidence).toBe('lint evidence');
  });

  it('keeps reading a pre-fingerprint state by slot when the slot still holds the same criterion', () => {
    const c: GoalCriterion = { type: 'all_prs_merged' };
    const legacy = stateFor([c], ['All 2 PR(s) merged'], false);
    expect(joinCriteriaState([c], legacy)[0]?.evidence).toBe('All 2 PR(s) merged');
  });

  it('drops a pre-fingerprint verdict once the slot holds a relabelled or retyped criterion', () => {
    const legacy = stateFor([{ type: 'all_prs_merged' }], ['No PRs found for this mission yet'], false);
    expect(joinCriteriaState([{ type: 'all_prs_merged', label: 'PR #101 merged' }], legacy)).toEqual([null]);
    expect(joinCriteriaState([{ type: 'no_open_tasks' }], legacy)).toEqual([null]);
  });

  it('agrees with a fresh evaluation: a mission with a merged PR never reads "No PRs found"', () => {
    const criteria: GoalCriterion[] = [{ type: 'all_prs_merged', label: 'PR #101 merged' }];
    const fresh = evaluateGoalCriteria({ id: 'm1' }, criteria, {
      tasks: [{ id: 't1', status: 'completed', taskClass: 'bookkeeping', title: 'Ship mission: x' }],
      workers: [{ taskId: 't1', prUrl: 'https://example.test/pr/101', prNumber: 101, mergedAt: '2026-10-01T00:00:00Z' }],
      artifacts: [],
      evaluatedBy: 'manual',
    });
    const [row] = joinCriteriaState(criteria, fresh);
    expect(row?.verdict).toBe('pass');
    expect(row?.evidence).not.toContain('No PRs found');
  });

  it('returns all nulls when nothing has been evaluated', () => {
    expect(joinCriteriaState([{ type: 'no_open_tasks' }], null)).toEqual([null]);
  });
});

describe('verificationReadiness — preflight for "Run verification"', () => {
  const prose: GoalCriterion = {
    type: 'description',
    description: 'The loop reads well to a person',
    notMechanizableReason: 'Taste is not scriptable here',
  };

  it('is empty with no criteria', () => {
    expect(verificationReadiness({ criteria: [], missionPrCount: 0 }).kind).toBe('empty');
  });

  it('is ready when any automatic check is bound', () => {
    expect(verificationReadiness({ criteria: [prose, { type: 'no_open_tasks' }], missionPrCount: 0 }).kind).toBe('ready');
  });

  it('blocks the run when only AI-judged criteria are bound, in two short plain sentences', () => {
    const r = verificationReadiness({ criteria: [prose], missionPrCount: 0 });
    expect(r.kind).toBe('needs_check');
    if (r.kind !== 'needs_check') return;
    expect(r.headline).toBe('Can’t verify automatically yet.');
    expect(r.reason.split(/(?<=\.)\s/).length).toBe(1);
    expect(r.suggestion).toBeNull();
    expect(r.actionLabel).toBe('Add check');
    for (const raw of RAW_ENUMS) {
      expect(`${r.headline} ${r.reason} ${r.actionLabel}`).not.toContain(raw);
    }
  });

  it('offers the PR check Buildd can already answer when the mission has PRs', () => {
    const r = verificationReadiness({ criteria: [prose], missionPrCount: 3 });
    expect(r.kind).toBe('needs_check');
    if (r.kind !== 'needs_check') return;
    expect(r.suggestion).toEqual({ type: 'all_prs_merged' });
    expect(r.actionLabel).toBe('Check that every PR merged');
    // The suggestion, once added, makes the list valid and the run possible.
    expect(validateGoalCriteria([prose, r.suggestion!], { stored: [prose] })).toBeNull();
    expect(verificationReadiness({ criteria: [prose, r.suggestion!], missionPrCount: 3 }).kind).toBe('ready');
  });

  it('isAutomaticCheck separates machine checks from AI-judged ones', () => {
    for (const t of RAW_ENUMS) expect(isAutomaticCheck({ type: t })).toBe(true);
    expect(isAutomaticCheck({ type: 'description' })).toBe(false);
    expect(isAutomaticCheck({ type: 'metric' })).toBe(false);
  });
});

describe('plainCriteriaError — no backend taxonomy in the default view', () => {
  it('rewrites the missing-automatic-check rule and keeps the raw text as a detail', () => {
    const raw = validateGoalCriteria([{
      type: 'description', description: 'x', notMechanizableReason: 'because it is prose',
    }])!;
    expect(raw).toContain('mechanical criterion');
    const out = plainCriteriaError(raw);
    for (const t of RAW_ENUMS) expect(out.text).not.toContain(t);
    expect(out.text).not.toContain('goalCriteria');
    expect(out.detail).toBe(raw);
  });

  it('rewrites the missing-reason rule for a written goal', () => {
    const raw = validateGoalCriteria([{ type: 'description', description: 'x' } as GoalCriterion], { requireMechanical: false })!;
    const out = plainCriteriaError(raw);
    for (const t of RAW_ENUMS) expect(out.text).not.toContain(t);
    expect(out.text).not.toContain('goalCriteria');
    expect(out.detail).toBe(raw);
  });

  it('strips the array locator from anything else', () => {
    const raw = validateGoalCriteria([{ type: 'command', command: ' ' } as GoalCriterion], { requireMechanical: false })!;
    const out = plainCriteriaError(raw);
    expect(out.text).not.toContain('goalCriteria');
  });

  it('passes plain messages through untouched', () => {
    expect(plainCriteriaError('Could not reach buildd.')).toEqual({ text: 'Could not reach buildd.', detail: null });
  });
});

describe('validateCriterionInContext — a new row is judged with the rows it joins', () => {
  const prose: GoalCriterion = {
    type: 'description',
    description: 'Reads well',
    notMechanizableReason: 'Taste is not scriptable here',
  };

  it('accepts a written goal added beside an existing automatic check', () => {
    // Regression: the add form validated the new row alone, so it always
    // failed the "needs an automatic check" rule even when the mission had one.
    expect(validateCriterionInContext(prose, [{ type: 'all_prs_merged' }])).toBeNull();
  });

  it('refuses a written goal when nothing else can be checked automatically, in plain words', () => {
    const out = validateCriterionInContext(prose, []);
    expect(out).not.toBeNull();
    for (const t of RAW_ENUMS) expect(out!.text).not.toContain(t);
  });

  it('still reports a row-level fault on the row', () => {
    const out = validateCriterionInContext({ type: 'command', command: '' } as GoalCriterion, [{ type: 'no_open_tasks' }]);
    expect(out).not.toBeNull();
  });

  it('grandfathers untouched siblings the server would also grandfather', () => {
    const legacyProse = { type: 'description', description: 'old prose' } as GoalCriterion;
    expect(validateCriterionInContext({ type: 'no_open_tasks' }, [legacyProse])).toBeNull();
  });
});
