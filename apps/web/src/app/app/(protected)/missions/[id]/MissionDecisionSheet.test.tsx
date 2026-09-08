import { describe, it, expect, mock } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { GoalCriterion } from '@buildd/shared';

mock.module('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
}));

const { default: MissionDecisionSheet } = await import('./MissionDecisionSheet');

const CRITERIA: GoalCriterion[] = [
  { type: 'description', description: 'The scorecard is comprehensive', notMechanizableReason: 'needs a model to judge' },
  { type: 'command', command: 'bun test' },
];

describe('MissionDecisionSheet', () => {
  it('renders all three exits when a failing criterion exists', () => {
    const html = renderToStaticMarkup(
      <MissionDecisionSheet
        missionId="mission-1"
        goalCriteria={CRITERIA}
        failingCriterionIndex={0}
        fileWorkHref="/app/tasks/new?missionId=mission-1"
      />,
    );
    expect(html).toContain('File the work');
    expect(html).toContain('Fix the criterion');
    expect(html).toContain('Waive and complete');
  });

  it('omits "Fix the criterion" when there is no failing criterion to edit', () => {
    const html = renderToStaticMarkup(
      <MissionDecisionSheet
        missionId="mission-1"
        goalCriteria={CRITERIA}
        failingCriterionIndex={null}
        fileWorkHref="/app/tasks/new?missionId=mission-1"
      />,
    );
    expect(html).not.toContain('Fix the criterion');
  });

  it('never preselects or auto-runs an exit — no confirm/save affordance renders by default', () => {
    const html = renderToStaticMarkup(
      <MissionDecisionSheet
        missionId="mission-1"
        goalCriteria={CRITERIA}
        failingCriterionIndex={0}
        fileWorkHref="/app/tasks/new?missionId=mission-1"
      />,
    );
    // The destructive/committing actions only exist behind an explicit click,
    // which static rendering can never trigger — so they must not appear yet.
    expect(html).not.toContain('Confirm — mark complete');
    expect(html).not.toContain('Save & re-run');
  });

  it('links "File the work" to the caller-supplied composer URL', () => {
    const html = renderToStaticMarkup(
      <MissionDecisionSheet
        missionId="mission-1"
        goalCriteria={CRITERIA}
        failingCriterionIndex={0}
        fileWorkHref="/app/tasks/new?missionId=mission-1&title=Fix+goal+criterion%3A+foo"
      />,
    );
    expect(html).toContain('/app/tasks/new?missionId=mission-1&amp;title=Fix+goal+criterion%3A+foo');
  });
});
