/**
 * MissionVerifiedPill mounted (happy-dom): the interactive behavior of
 * opening/closing the criteria panel via taps and URL synchronization.
 *
 * - a chip tap opens the panel and updates ?criteria=open
 * - the useEffect syncs panel state with the URL parameter
 * - client-side navigation (re-render with new searchParams) correctly opens panel on tap
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/missions/test-mission-id' });

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Mock next/navigation to track URL changes via useSearchParams
const urlListeners = new Set<() => void>();
const syncUrl = () => urlListeners.forEach(l => l());
const { useSyncExternalStore } = await import('react');
mock.module('next/navigation', () => ({
  useSearchParams: () => {
    const search = useSyncExternalStore(
      l => { urlListeners.add(l); return () => urlListeners.delete(l); },
      () => window.location.search,
      () => window.location.search,
    );
    return new URLSearchParams(search);
  },
  usePathname: () => window.location.pathname,
  useRouter: () => ({
    push: () => {},
    replace: (url: string) => {
      const { pathname, search } = new URL(url, window.location.href);
      window.history.replaceState(null, '', `${pathname}${search}`);
      syncUrl();
    },
    refresh: () => {},
    back: () => {},
    prefetch: () => {},
  }),
}));

// Mock BottomSheet to render when open
mock.module('@/components/BottomSheet', () => ({
  default: ({ open, onClose, title, children }: any) =>
    open ? (
      <div data-testid="bottom-sheet" role="dialog" aria-label={title}>
        <button type="button" data-testid="sheet-close" onClick={onClose}>Close</button>
        {children}
      </div>
    ) : null,
}));

// Mock MissionGoalCriteria
mock.module('./MissionGoalCriteria', () => ({
  default: ({ missionId }: any) => <div data-testid="mission-goal-criteria">Goal Criteria for {missionId}</div>,
}));

// Mock other dependencies
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

mock.module('@/components/missions/MissionSituationBlock', () => ({
  MISSION_CRITERIA_ANCHOR: 'mission-criteria',
}));

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: MissionVerifiedPill } = await import('./MissionVerifiedPill');

type GoalCriterion = any;
type GoalCriteriaState = any;

interface TestProps {
  missionId: string;
  criteria: GoalCriterion[];
  criteriaState: GoalCriteriaState | null;
  autoVerify: boolean | null;
  readonly?: boolean;
  overall: 'pass' | 'fail' | 'UNVERIFIED' | 'NOT_EVALUATED' | 'PENDING' | null;
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  window.history.replaceState(null, '', '/app/missions/test-mission-id');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function renderPill(overrides: Partial<TestProps> = {}) {
  const props: TestProps = {
    missionId: 'test-mission-id',
    criteria: [
      {
        type: 'all_prs_merged' as const,
        label: 'All PRs merged',
      },
    ],
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
    },
    autoVerify: false,
    readonly: false,
    overall: 'fail' as const,
    ...overrides,
  };

  act(() => {
    root.render(<MissionVerifiedPill {...props} />);
  });
}

const getButton = () => container.querySelector('[id="mission-criteria"]') as HTMLButtonElement | null;
const getBottomSheet = () => container.querySelector('[data-testid="bottom-sheet"]');
const click = (el: Element) => act(() => {
  el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }) as unknown as Event);
});

describe('MissionVerifiedPill mounted — chip tap opens panel', () => {
  it('clicking the chip button opens the BottomSheet panel', () => {
    renderPill({ overall: 'fail' });
    const button = getButton();
    expect(button).not.toBeNull();
    expect(getBottomSheet()).toBeNull();

    click(button!);

    expect(getBottomSheet()).not.toBeNull();
    expect(getBottomSheet()?.querySelector('[data-testid="mission-goal-criteria"]')).not.toBeNull();
  });

  it('the URL is updated to include ?criteria=open when the button is clicked', () => {
    renderPill({ overall: 'fail' });
    click(getButton()!);

    expect(window.location.search).toContain('criteria=open');
  });
});

describe('MissionVerifiedPill mounted — URL parameter syncs panel state', () => {
  it('starting with ?criteria=open in URL opens the panel on mount', () => {
    act(() => {
      window.history.replaceState(null, '', '/app/missions/test-mission-id?criteria=open');
      syncUrl();
    });

    renderPill({ overall: 'fail' });

    expect(getBottomSheet()).not.toBeNull();
    expect(getBottomSheet()?.querySelector('[data-testid="mission-goal-criteria"]')).not.toBeNull();
  });

  it('client-side navigation: re-render with updated searchParams keeps panel in sync', () => {
    renderPill({ overall: 'fail' });
    expect(getBottomSheet()).toBeNull();

    // Simulate client-side navigation: update URL and sync
    act(() => {
      window.history.replaceState(null, '', '/app/missions/test-mission-id?criteria=open');
      syncUrl();
    });

    expect(getBottomSheet()).not.toBeNull();

    // Now navigate away (remove criteria param)
    act(() => {
      window.history.replaceState(null, '', '/app/missions/test-mission-id');
      syncUrl();
    });

    expect(getBottomSheet()).toBeNull();
  });

  it('panel opens via tap after client-side navigation (the bug scenario)', () => {
    renderPill({ overall: 'fail' });

    // Initial navigation away from criteria param
    act(() => {
      window.history.replaceState(null, '', '/app/missions/test-mission-id?other=param');
      syncUrl();
    });

    expect(getBottomSheet()).toBeNull();

    // Now tap the chip after this client-side navigation
    click(getButton()!);

    expect(getBottomSheet()).not.toBeNull();
    expect(window.location.search).toContain('criteria=open');
  });
});

describe('MissionVerifiedPill mounted — closing the panel', () => {
  it('clicking the close button on the sheet removes ?criteria=open from URL', () => {
    act(() => {
      window.history.replaceState(null, '', '/app/missions/test-mission-id?criteria=open');
      syncUrl();
    });

    renderPill({ overall: 'fail' });

    expect(getBottomSheet()).not.toBeNull();

    const closeButton = getBottomSheet()?.querySelector('[data-testid="sheet-close"]') as HTMLButtonElement;
    click(closeButton);

    expect(getBottomSheet()).toBeNull();
    expect(window.location.search).not.toContain('criteria=open');
  });
});
