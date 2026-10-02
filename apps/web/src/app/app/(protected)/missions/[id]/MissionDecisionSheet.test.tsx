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

const LONG_PATHS = [
  'apps/web/src/app/app/(protected)/missions/[id]/MissionDecisionSheetWithAVeryLongComponentNameThatCannotWrapOnItsOwn.tsx',
  'apps/web/src/components/a/very/deeply/nested/directory/structure/that/keeps/going/and/going/Widget.tsx',
];

const HREF = '/app/tasks/new?missionId=mission-1';

function render(props: Partial<React.ComponentProps<typeof MissionDecisionSheet>> = {}) {
  return renderToStaticMarkup(
    <MissionDecisionSheet
      missionId="mission-1"
      goalCriteria={CRITERIA}
      failingCriterionIndex={0}
      fileWorkHref={HREF}
      criteriaUnmet={false}
      surfaceAudit={null}
      {...props}
    />,
  );
}

const AUDIT = { paths: LONG_PATHS, executorLocal: false };

describe('MissionDecisionSheet: criteria branch', () => {
  it('renders all three exits when criteria are unmet and one is failing', () => {
    const html = render({ criteriaUnmet: true });
    expect(html).toContain('File the work');
    expect(html).toContain('Fix the criterion');
    expect(html).toContain('Waive and complete');
    expect(html).not.toContain('Run visual audit');
    expect(html).not.toContain('Waive with reason');
  });

  it('omits "Fix the criterion" when there is no failing criterion to edit', () => {
    expect(render({ criteriaUnmet: true, failingCriterionIndex: null })).not.toContain('Fix the criterion');
  });

  it('gives every exit a one-line subtitle, "File the work" included', () => {
    const html = render({ criteriaUnmet: true });
    expect(html).toContain('Create a task for what is missing');
    expect(html).toContain('Edit the criterion that is not passing');
    expect(html).toContain('Completes the mission with its goal criteria unmet');
  });

  it('never preselects or auto-runs an exit: no confirm/save affordance renders by default', () => {
    const html = render({ criteriaUnmet: true });
    expect(html).not.toContain('Mark complete');
    expect(html).not.toContain('Save &amp; re-run');
  });

  it('links "File the work" to the caller-supplied composer URL', () => {
    const html = render({ criteriaUnmet: true, fileWorkHref: '/app/tasks/new?missionId=mission-1&title=Fix+goal+criterion%3A+foo' });
    expect(html).toContain('/app/tasks/new?missionId=mission-1&amp;title=Fix+goal+criterion%3A+foo');
  });

  it('renders nothing when no criteria are unmet and no audit is missing: never a dead CTA', () => {
    expect(render({ criteriaUnmet: false })).toBe('');
  });
});

describe('MissionDecisionSheet: missing visual audit', () => {
  it('offers exactly "Run visual audit" and "Waive with reason", and none of the criteria exits', () => {
    const html = render({ criteriaUnmet: false, surfaceAudit: AUDIT });
    const buttons = [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map(m => m[1]);
    expect(buttons).toEqual(['Run visual audit', 'Waive with reason']);
    expect(html).not.toContain('File the work');
    expect(html).not.toContain('Fix the criterion');
    expect(html).not.toContain('Waive and complete');
    expect(html).not.toContain('goal criteria');
  });

  it('gives each action a one-line subtitle', () => {
    const html = render({ surfaceAudit: AUDIT });
    expect(html).toContain('Adds a check of the changed screens to this mission');
    expect(html).toContain('Skips the audit and completes the mission');
  });

  it('keeps the changed files collapsed and wrapping', () => {
    const html = render({ surfaceAudit: AUDIT });
    expect(html).toMatch(/<details[^>]*data-testid="surface-audit-files"[^>]*>/);
    expect(html).not.toMatch(/<details[^>]*\sopen/);
    expect(html).toContain('Show the 2 changed UI files');
    expect(html).toContain('break-all');
  });

  it('says runners will not claim the audit when the mission runs locally', () => {
    expect(render({ surfaceAudit: { ...AUDIT, executorLocal: true } })).toContain('buildd&#x27;s runners will not pick it up');
    expect(render({ surfaceAudit: AUDIT })).not.toContain('will not pick it up');
  });

  it('uses no API or tool names in what a person reads', () => {
    const html = render({ surfaceAudit: { ...AUDIT, executorLocal: true } });
    for (const leaked of ['surfaceAuditWaiver', 'manage_missions', '[surface audit]', 'create_task', 'surface_audit_missing', 'MCP']) {
      expect(html).not.toContain(leaked);
    }
  });

  it('renders no confirm affordance or waiver field until the person opens it', () => {
    const html = render({ surfaceAudit: AUDIT });
    expect(html).not.toContain('<textarea');
    expect(html).not.toContain('Save reason and complete');
  });
});

describe('MissionDecisionSheet: both blockers', () => {
  it('renders both groups, each labelled', () => {
    const html = render({ criteriaUnmet: true, surfaceAudit: AUDIT });
    expect(html).toContain('Run visual audit');
    expect(html).toContain('Waive with reason');
    expect(html).toContain('File the work');
    expect(html).toContain('Fix the criterion');
    expect(html).toContain('Waive and complete');
    expect(html).toContain('Visual audit</p>');
    expect(html).toContain('Goal criteria</p>');
  });
});

describe('MissionDecisionSheet: narrow screens', () => {
  // renderToStaticMarkup has no layout engine, so this pins the classes that
  // keep a 320pt screen from scrolling sideways: every container may shrink,
  // every long string may break, and nothing is forced onto one line.
  it('lets long paths and copy wrap and nothing force a single line', () => {
    const html = render({ criteriaUnmet: true, surfaceAudit: { ...AUDIT, executorLocal: true } });
    expect(html).toContain('min-w-0');
    expect(html).toContain('max-w-full');
    expect(html).toContain('[overflow-wrap:anywhere]');
    expect(html).toContain('flex-wrap');
    expect(html).not.toContain('whitespace-nowrap');
    expect(html).not.toContain('truncate');
    expect(html).not.toMatch(/\bw-\[\d+px\]|\bmin-w-\[\d+px\]/);
  });
});
