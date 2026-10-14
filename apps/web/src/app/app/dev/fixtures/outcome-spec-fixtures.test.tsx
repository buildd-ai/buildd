import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { LivingSpecGoalCriterion } from '@buildd/shared';
import OutcomeSpecCriterion, { OutcomeSpecSummary } from '@/app/app/(protected)/missions/[id]/OutcomeSpecCriterion';
import { criteriaChecks } from '@/lib/mission-checks';
import { outcomeSpecView } from '@/lib/mission-outcome-spec-view';
import {
  OUTCOME_SPEC_VARIANTS,
  isOutcomeSpecVariant,
  missionTaskStripFixture,
  missionTaskStripLinks,
  parseMissionTaskStripVariant,
  type MissionTaskStripVariant,
} from './mission-task-strip-fixtures';

function specOf(variant: MissionTaskStripVariant) {
  const f = missionTaskStripFixture(variant, Date.parse('2026-10-14T12:00:00Z'));
  const checks = f.checks!;
  const i = checks.criteria.findIndex(c => c.type === 'living_spec');
  const criterion = checks.criteria[i] as LivingSpecGoalCriterion;
  const entry = checks.criteriaState?.criteria.find(e => e.index === i) ?? null;
  const row = criteriaChecks(checks.criteria, checks.criteriaState, { branch: checks.branch, prMerged: false, target: checks.target })[i];
  return { f, criterion, entry, row, view: outcomeSpecView(criterion, entry) };
}

describe('outcome spec fixtures (?state=mission-task-strip&variant=outcome-spec-*)', () => {
  it('every variant is linked, parses and renders as an Overview fixture', () => {
    const hrefs = missionTaskStripLinks().map(l => l.href);
    for (const v of OUTCOME_SPEC_VARIANTS) {
      expect(isOutcomeSpecVariant(v)).toBe(true);
      expect(hrefs).toContain(`?state=mission-task-strip&variant=${v}`);
      expect(parseMissionTaskStripVariant(new URLSearchParams(`variant=${v}`))).toBe(v);
    }
  });

  it('all passing reads passed on the Verify row', () => {
    const { row, view } = specOf('outcome-spec-passing');
    expect(row.status).toBe('passed');
    expect(view.passed).toBe(view.total);
    expect(view.open).toEqual([]);
  });

  it('open: one inconclusive, one stale and one waived never count as passed', () => {
    const { row, view } = specOf('outcome-spec-open');
    expect(row.status).not.toBe('passed');
    expect(view.open.map(o => o.standing).sort()).toEqual(['inconclusive', 'stale']);
    expect(view.waived).toHaveLength(1);
    expect(view.passed).toBeLessThan(view.total);
  });

  it('narrowed scope carries its reason', () => {
    const { view } = specOf('outcome-spec-narrowed');
    expect(view.narrowed?.reason.length).toBeGreaterThanOrEqual(10);
    expect(view.narrowed?.criterionIds.length).toBeGreaterThan(0);
  });

  it('a proposed revision says so', () => {
    expect(specOf('outcome-spec-proposed').view.revisionLine).toContain('proposed');
  });

  it('final verification running reads verifying, with its task', () => {
    const { row, view } = specOf('outcome-spec-verifying');
    expect(row.status).toBe('running');
    expect(view.verificationTaskId).not.toBeNull();
  });

  it('each variant renders through the real criterion row', () => {
    for (const v of OUTCOME_SPEC_VARIANTS) {
      const { criterion, entry } = specOf(v);
      expect(renderToStaticMarkup(<OutcomeSpecSummary criterion={criterion} entry={entry} />)).toContain('Revision 4');
      expect(renderToStaticMarkup(<OutcomeSpecCriterion missionId="m" criterion={criterion} entry={entry} />)).toContain('data-testid="outcome-spec-detail"');
    }
  });
});
