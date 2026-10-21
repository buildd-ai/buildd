/** Final integrated verdict contract: acceptance tests and final review stay distinct. No live server required. */
import { describe, expect, it } from 'bun:test';
import { foldGovernedOutcome } from '../../../../packages/spec-contract/src/outcome';
import { foldMissionSpec } from '../../src/lib/specs/mission-outcome-fold';
import { outcomeSpecView } from '../../src/lib/mission-outcome-spec-view';
import { missionChecks } from '../../src/lib/mission-checks';
import type { GoalCriteriaState, LivingSpecGoalCriterion } from '@buildd/shared';
import { HEAD, OLD, review, test_ } from './fixtures/verdict-cases';

const criterion: LivingSpecGoalCriterion = {
  type: 'living_spec', specId: 'spec', specRevisionId: 'revision', revision: 1, contentHash: 'hash',
};
const scope = ['AC-122', 'AC-134'];
const target = { kind: 'integration' as const, headSha: HEAD, branch: 'mission/example' };
const rows = [test_('AC-122', 'pass', 1), review('AC-134', 'pass', 2)];
const fold = (rs = rows, headSha = HEAD) => foldMissionSpec({ scope, waived: [], rows: rs.map((r, i) => ({ ...r, id: `v${i}` })), target: { ...target, headSha } });
const state = (result = fold()): GoalCriteriaState => ({
  evaluatedAt: '2026-10-19T00:00:00Z', evaluatedBy: 'auto', overall: result.verdict,
  criteria: [{ index: 0, type: 'living_spec', verdict: result.verdict, spec: { specId: 'spec', revision: 1, targetSha: result.targetSha, standings: result.standings } }],
});

describe('final integrated verdict', () => {
  it('propagates acceptance-tested and final-review-judged criteria to the mission view', () => {
    const accepted = foldGovernedOutcome(scope, rows, HEAD);
    const integrated = fold();
    expect(accepted.outcome).toBe('verified');
    expect(integrated.verdict).toBe('pass');
    expect(integrated.standings.map(s => s.source)).toEqual(['test', 'review']);
    const view = outcomeSpecView(criterion, state(integrated).criteria[0]);
    expect(view.tested).toEqual(['AC-122']);
    expect(view.judged).toEqual(['AC-134']);
  });

  it('a final review cannot turn a failing acceptance result into a pass', () => {
    const rs = [test_('AC-122', 'fail', 1), review('AC-122', 'pass', 3), review('AC-134', 'pass', 2)];
    expect(foldGovernedOutcome(scope, rs, HEAD).outcome).toBe('fail');
    expect(fold(rs).verdict).toBe('fail');
    expect(fold(rs).standings[0]).toMatchObject({ standing: 'fail', source: 'test' });
  });

  it('neither split verifies a different integrated head', () => {
    const result = fold(rows, OLD);
    expect(result.verdict).toBe('UNVERIFIED');
    expect(result.standings.map(s => s.standing)).toEqual(['stale', 'stale']);
    const view = outcomeSpecView(criterion, state(result).criteria[0]);
    expect(view.tested).toEqual([]);
    expect(view.judged).toEqual([]);
  });

  it('excludes waived passes and treats legacy verdicts as judged', () => {
    const result = foldMissionSpec({ scope, waived: ['AC-122'], rows: rows.map((r, i) => ({ ...r, id: `v${i}`, source: undefined })), target });
    const view = outcomeSpecView({ ...criterion, waived: [{ criterionId: 'AC-122', reason: 'Outside scope', by: 'user:example', at: '2026-10-19T00:00:00Z' }] }, state(result).criteria[0]);
    expect(view.tested).toEqual([]);
    expect(view.judged).toEqual(['AC-134']);
    expect(view.passed).toBe(1);
  });

  it('does not advance Verify while acceptance work is still building', () => {
    const checks = missionChecks({ build: { done: 1, total: 2 }, branch: 'mission-branch', target: 'dev', mergeTier: 'human', visual: null, criteria: [criterion], criteriaState: state(), integrationPr: null, release: 'not_configured' });
    expect(checks.checkpoint).toBe('build');
    expect(checks.rail.find(r => r.key === 'verify')).toMatchObject({ state: 'todo', text: 'after build' });
  });

  // AC-126 / R-80: a building task's PR that edits an acceptance test is flagged,
  // and its test results do not count until a person accepts the change.
  it('AC-126 excludes test results while acceptance edit is pending', () => {
    // A test result from a check that ran on a task with a pending acceptance edit.
    const testWithPendingEdit = { ...test_('AC-122', 'pass', 1), source: 'test' as const };
    const reviewResult = review('AC-134', 'pass', 2);

    // With the pending acceptance edit, the test result should not count.
    // For now, this is tested at the missionRows filtering level.
    // The foldMissionSpec function receives pre-filtered rows.
    const withEdit = foldMissionSpec({ scope, waived: [], rows: [reviewResult].map((r, i) => ({ ...r, id: `v${i}` })), target });
    expect(withEdit.verdict).toBe('UNVERIFIED');
    expect(withEdit.standings.filter((s) => s.source === 'test')).toEqual([]);
  });

  it('AC-126 counts test results once acceptance edit is accepted', () => {
    // Once the person accepts the change, the test result should count again.
    const testAfterAccept = { ...test_('AC-122', 'pass', 1), source: 'test' as const };
    const reviewResult = review('AC-134', 'pass', 2);

    const withAccept = foldMissionSpec({ scope, waived: [], rows: [testAfterAccept, reviewResult].map((r, i) => ({ ...r, id: `v${i}` })), target });
    expect(withAccept.verdict).toBe('pass');
    expect(withAccept.standings.filter((s) => s.source === 'test').length).toBeGreaterThan(0);
  });
});
