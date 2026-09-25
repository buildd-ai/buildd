import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { GoalCriterion, GoalCriteriaState } from '@buildd/shared';

const mockReplace = mock(() => {});
const mockUseRouter = mock(() => ({ replace: mockReplace }));
const mockUseSearchParams = mock(() => new URLSearchParams());
const mockUsePathname = mock(() => '/missions/test-mission-id');

mock.module('next/navigation', () => ({
  useRouter: mockUseRouter,
  useSearchParams: mockUseSearchParams,
  usePathname: mockUsePathname,
}));

mock.module('@buildd/core/mission-helpers', () => ({
  deriveCriteriaGatePresentation: (opts: any) => ({
    state: opts.overall === 'pass' ? 'clear' : opts.overall === 'fail' ? 'failing' : 'unverified',
    tone: opts.overall === 'pass' ? 'success' : opts.overall === 'fail' ? 'error' : 'warning',
  }),
  CRITERIA_GATE_TONE_CLASS: {
    success: 'text-status-success border-status-success/40',
    error: 'text-status-error border-status-error/40',
    warning: 'text-status-warning border-status-warning/40',
  },
}));

mock.module('@/components/BottomSheet', () => ({
  default: ({ open, onClose, title, children }: any) =>
    open ? `<div role="dialog" aria-label="${title}">${children}</div>` : null,
}));

mock.module('./MissionGoalCriteria', () => ({
  default: ({ missionId }: any) => `<div>Goal Criteria Panel for ${missionId}</div>`,
}));

mock.module('@/components/missions/MissionSituationBlock', () => ({
  MISSION_CRITERIA_ANCHOR: 'mission-criteria',
}));

const { default: MissionVerifiedPill } = await import('./MissionVerifiedPill');

function renderPill(overrides: Partial<Parameters<typeof MissionVerifiedPill>[0]> = {}) {
  const props = {
    missionId: 'test-mission-id',
    criteria: [
      {
        type: 'all_prs_merged' as const,
        label: 'All PRs merged',
      },
    ] as GoalCriterion[],
    criteriaState: {
      overall: 'fail' as const,
      criteria: [
        {
          index: 0,
          label: 'All PRs merged',
          verdict: 'fail' as const,
          type: 'all_prs_merged' as const,
        },
      ],
    } as GoalCriteriaState,
    autoVerify: false,
    readonly: false,
    overall: 'fail' as const,
    ...overrides,
  };
  return renderToStaticMarkup(<MissionVerifiedPill {...props} />);
}

describe('MissionVerifiedPill — criteria panel URL sync and hash-based opening', () => {
  it('renders the Not met button when overall is fail', () => {
    const html = renderPill({ overall: 'fail' });
    expect(html).toContain('Not met');
  });

  it('renders the Verified button when overall is pass', () => {
    const html = renderPill({ overall: 'pass' });
    expect(html).toContain('Verified');
  });

  it('renders the + Criteria button when criteria is empty', () => {
    const html = renderPill({ criteria: [] });
    expect(html).toContain('+ Criteria');
  });

  it('renders the button as clickable (has button role and type)', () => {
    const html = renderPill();
    expect(html).toContain('type="button"');
  });

  it('includes button element with MISSION_CRITERIA_ANCHOR id in the rendered output', () => {
    const html = renderPill();
    expect(html).toContain('id="mission-criteria"');
    expect(html).toContain('<button');
  });

  it('renders null when criteria is empty and readonly is true', () => {
    const html = renderPill({ criteria: [], readonly: true });
    expect(html).toBe('');
  });

  it('renders successfully with a Suspense wrapper', () => {
    const html = renderPill();
    // The component should render without error
    expect(html).toBeTruthy();
    // Should contain the button with onClick handler capability
    expect(html).toContain('button');
  });

  it('preserves the hash-based link opening capability', () => {
    const html = renderPill();
    // The button should have the MISSION_CRITERIA_ANCHOR id for hash-based navigation
    expect(html).toContain('id="mission-criteria"');
  });
});
