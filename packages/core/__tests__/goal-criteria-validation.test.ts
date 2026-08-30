import { describe, it, expect } from 'bun:test';
import {
  validateGoalCriteria,
  recalculateOverall,
  MECHANICAL_CRITERION_TYPES,
  MAX_GOAL_CRITERIA,
} from '../mission-helpers';
import type { GoalCriteriaState } from '@buildd/shared';

// ─── validateGoalCriteria ─────────────────────────────────────────────────────
//
// The write boundary for criteria form. Its job is to keep verdicts mechanizable:
// a criterion whose verdict needs a live LLM is allowed, but only deliberately.

describe('validateGoalCriteria — shape', () => {
  it('accepts an empty array', () => {
    expect(validateGoalCriteria([])).toBeNull();
  });

  it('rejects a non-array', () => {
    expect(validateGoalCriteria({ type: 'no_open_tasks' })).toContain('must be an array');
  });

  it('rejects more than MAX_GOAL_CRITERIA criteria', () => {
    const many = Array.from({ length: MAX_GOAL_CRITERIA + 1 }, () => ({ type: 'no_open_tasks' }));
    expect(validateGoalCriteria(many)).toContain(`at most ${MAX_GOAL_CRITERIA}`);
  });

  it('rejects a non-object entry', () => {
    expect(validateGoalCriteria(['no_open_tasks'])).toContain('goalCriteria[0] must be an object');
  });

  it('rejects an unknown type and lists the valid ones', () => {
    const err = validateGoalCriteria([{ type: 'vibes' }]);
    expect(err).toContain('goalCriteria[0].type must be one of');
    expect(err).toContain('all_prs_merged');
  });

  it('rejects a non-string label', () => {
    expect(validateGoalCriteria([{ type: 'no_open_tasks', label: 7 }])).toContain('label must be a string');
  });
});

describe('validateGoalCriteria — mechanical types', () => {
  it('accepts a command criterion', () => {
    expect(validateGoalCriteria([{ type: 'command', command: 'bun test apps/web/src/lib/foo.test.ts' }])).toBeNull();
  });

  it('rejects a command criterion with a blank command', () => {
    expect(validateGoalCriteria([{ type: 'command', command: '   ' }])).toContain('command is required');
  });

  it('rejects a command criterion with no command at all', () => {
    // Previously only `type` was validated, so this shape was accepted and then
    // sat in the DB as a criterion nothing could ever evaluate.
    expect(validateGoalCriteria([{ type: 'command' }])).toContain('command is required');
  });

  it('rejects a metric criterion outright — it has no evaluator and would block forever', () => {
    // `evaluateGoalCriteria` returns UNVERIFIED for every metric criterion, and
    // UNVERIFIED never passes. Accepting one hands the author a gate that cannot
    // open — worse than no gate, because it looks like one.
    const err = validateGoalCriteria([
      { type: 'metric', query: 'error_rate', operator: 'lt', threshold: 0.01, unit: 'ratio' },
    ]);
    expect(err).toContain('no evaluator');
    expect(err).toContain('command criterion');
  });

  it('does not offer metric as a mechanical alternative in the prose rejection', () => {
    const err = validateGoalCriteria([{ type: 'description', description: 'Rows exist' }]);
    expect(err).not.toContain('metric');
  });

  it('accepts structural criteria with no extra fields', () => {
    expect(validateGoalCriteria([
      { type: 'all_prs_merged', requireBranchDeleted: true },
      { type: 'no_open_tasks', label: 'nothing open' },
      { type: 'artifact_exists', key: 'scorecard' },
    ])).toBeNull();
  });
});

describe('validateGoalCriteria — prose criteria must justify themselves', () => {
  it('rejects a description criterion with no notMechanizableReason', () => {
    const err = validateGoalCriteria([{ type: 'description', description: 'No double-fire' }]);
    expect(err).toContain('prose criterion');
    // The error has to be actionable: name the mechanical alternatives.
    for (const t of MECHANICAL_CRITERION_TYPES) expect(err).toContain(t);
    expect(err).toContain('command criterion');
  });

  it('rejects a throwaway reason', () => {
    expect(validateGoalCriteria([
      { type: 'description', description: 'Rows exist', notMechanizableReason: 'n/a' },
    ])).toContain('notMechanizableReason');
  });

  it('accepts a description criterion with a stated reason', () => {
    expect(validateGoalCriteria([{
      type: 'description',
      description: 'The onboarding copy reads as welcoming rather than clinical',
      notMechanizableReason: 'Tone is a human judgement; no command or artifact check can assert it.',
    }])).toBeNull();
  });

  it('rejects a description criterion with a blank description', () => {
    expect(validateGoalCriteria([
      { type: 'description', description: '  ', notMechanizableReason: 'Some genuine reason here' },
    ])).toContain('description is required');
  });

  it('grandfathers an unchanged criterion so history does not block every edit', () => {
    // The dashboard PATCHes the whole array. A mission holding a pre-gate prose
    // criterion would otherwise 400 on every edit — including the edit that
    // would fix it.
    const legacy = { type: 'description', description: 'Rows exist' };
    expect(validateGoalCriteria([legacy], { stored: [legacy] })).toBeNull();
  });

  it('still rejects a NEW prose criterion added alongside a grandfathered one', () => {
    const legacy = { type: 'description', description: 'Rows exist' };
    const err = validateGoalCriteria(
      [legacy, { type: 'description', description: 'No double-fire' }],
      { stored: [legacy] },
    );
    expect(err).toContain('goalCriteria[1]');
  });

  it('rejects a modified version of a stored criterion', () => {
    const err = validateGoalCriteria(
      [{ type: 'description', description: 'Rows exist, edited' }],
      { stored: [{ type: 'description', description: 'Rows exist' }] },
    );
    expect(err).toContain('notMechanizableReason');
  });

  it('reports the first offending index', () => {
    const err = validateGoalCriteria([
      { type: 'no_open_tasks' },
      { type: 'description', description: 'Rows exist' },
    ]);
    expect(err).toContain('goalCriteria[1]');
  });
});

// ─── recalculateOverall ───────────────────────────────────────────────────────

function crit(verdict: string, index = 0): GoalCriteriaState['criteria'][number] {
  return { index, type: 'description', verdict: verdict as any };
}

describe('recalculateOverall', () => {
  it('passes an empty criteria list (a mission with no stated criteria is not gated)', () => {
    expect(recalculateOverall([])).toBe('pass');
  });

  it('passes only when every criterion passes', () => {
    expect(recalculateOverall([crit('pass', 0), crit('pass', 1)])).toBe('pass');
  });

  it('fails when any criterion fails', () => {
    expect(recalculateOverall([crit('pass', 0), crit('fail', 1)])).toBe('fail');
  });

  it('fail beats every other non-pass verdict', () => {
    expect(recalculateOverall([crit('fail', 0), crit('PENDING', 1), crit('NOT_EVALUATED', 2)])).toBe('fail');
  });

  it('NOT_EVALUATED is not a pass', () => {
    expect(recalculateOverall([crit('pass', 0), crit('NOT_EVALUATED', 1)])).toBe('UNVERIFIED');
  });

  it('PENDING is not a pass — a verification run in flight has produced no verdict', () => {
    expect(recalculateOverall([crit('pass', 0), crit('PENDING', 1)])).toBe('UNVERIFIED');
  });

  it('UNVERIFIED is not a pass', () => {
    expect(recalculateOverall([crit('pass', 0), crit('UNVERIFIED', 1)])).toBe('UNVERIFIED');
  });
});
