/**
 * The mission Goal panel, mounted (happy-dom): a mechanical criterion whose
 * live count is complete but that nothing has evaluated yet (`PRs merged N/N`
 * with no verdict on record) must not wear the unmet glyph. It drew an empty
 * circle on the Overview rail and a tickless box on the Board, beside its own
 * full ratio (task fc1f5a94).
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/missions/mission-1' });

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

mock.module('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {}, back: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/app/missions/mission-1',
}));

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: MissionOverview } = await import('./MissionOverview');
const { GoalCell } = await import('./MissionBoard');
const { dagBoard, DAG_SPECS } = await import('@/app/app/dev/fixtures/mission-task-strip-fixtures');

// Illustrative fixture: a criterion whose live count is full, never evaluated.
const model = {
  ...dagBoard(DAG_SPECS.linear),
  criteria: [{ label: 'PRs merged', value: '3/3', state: 'unchecked' as const, frac: 1 }],
  criteriaPassed: 0,
  criteriaEvaluated: false,
};

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('Goal panel: an unevaluated N/N criterion', () => {
  it('Overview: the criteria are the Verified pill’s, not a rail beside the bar (Navigation d25d923d R-3)', () => {
    act(() => root.render(createElement(MissionOverview, { model, missionId: 'mission-1', workspaceId: 'ws-1' })));
    expect(container.querySelector('[data-testid="criteria"]')).toBeNull();
    expect(container.querySelector('[data-testid="overview-rail"]')).toBeNull();
    expect(container.textContent).not.toContain('Unmet');
  });

  it('Board goal cell: a distinct not-checked box, not the partial or empty one', () => {
    act(() => root.render(createElement(GoalCell, { model, compact: false, missionId: 'mission-1', className: '' })));
    const row = container.querySelector('[data-testid="goal-criterion"]')!;
    expect(row.getAttribute('data-state')).toBe('unchecked');
    const box = row.querySelector('[data-testid="criterion-box"]')!;
    expect(box.getAttribute('data-state')).toBe('unchecked');
    expect(box.getAttribute('aria-label')).toBe('Not checked');
    expect(row.textContent).toContain('3/3');
  });
});
