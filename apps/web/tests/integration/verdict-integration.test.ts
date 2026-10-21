/** Final integrated verdict contract: acceptance tests and final review stay distinct. No live server required. */
import { describe, expect, it } from 'bun:test';
import { foldGovernedOutcome } from '../../../../packages/spec-contract/src/outcome';
import { acceptEdits, flagAcceptanceEdit } from '../../../../packages/spec-contract/src/acceptance-edit';
import { holdUnacceptedTestRows } from '../../src/lib/specs/acceptance-hold';
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

  // AC-126 / R-80: flag -> the task's test result is held out of the fold -> a person accepts -> it counts.
  it('AC-126 holds a flagged task\'s test result out of the fold until a person accepts it', () => {
    const TASK = '11111111-1111-4111-8111-111111111111';
    const vrows = rows.map((r, i) => ({ ...r, id: `v${i}` }));
    const evidenceById = new Map<string, unknown>([['v0', { recordedBy: `check:${TASK}` }]]);
    const flagged = flagAcceptanceEdit(null, ['tests/acceptance/ac-122.test.ts'], HEAD, 'now')!;
    const foldWith = (flag: typeof flagged) =>
      foldMissionSpec({ scope, waived: [], rows: holdUnacceptedTestRows(vrows, evidenceById, new Map([[TASK, { acceptanceEdit: flag }]])), target });

    const held = foldWith(flagged);
    expect(held.standings.find((s) => s.source === 'test')).toBeUndefined();
    expect(held.verdict).not.toBe('pass');

    const counted = foldWith(acceptEdits(flagged, 'user:person', 'later'));
    expect(counted.standings.map((s) => s.source)).toEqual(['test', 'review']);
    expect(counted.verdict).toBe('pass');
  });
});
