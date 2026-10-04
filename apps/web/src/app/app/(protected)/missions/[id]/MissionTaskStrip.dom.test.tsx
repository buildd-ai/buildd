/**
 * The Landed strip on the mission Board (happy-dom):
 * - cells are buttons in a toolbar; a click selects without navigating;
 * - the default selection is the first unfinished task (all landed: the last);
 * - ArrowLeft/Right step and Home/End jump, with focus following;
 * - the stepper's "Next open" and the header's "N open ›" jump;
 * - the situation block's single-task affordance selects that cell and moves
 *   focus to the drawer instead of rendering a second call to action;
 * - selecting a task makes no request.
 *
 * Runs in its own process (scripts/run-unit-tests.ts), so the DOM globals stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/missions/m1' });

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

mock.module('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
}));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { LandedStrip } = await import('./MissionTaskStrip');
const { MissionStripContext, createMissionStripStore } = await import('@/components/missions/mission-strip-context');
const { default: SituationTaskAffordance } = await import('@/components/missions/SituationTaskAffordance');
const { stripOrder } = await import('@/lib/mission-task-strip');
const { missionTaskStripFixture, stripFixtureId } = await import('../../../dev/fixtures/mission-task-strip-fixtures');
type Fixture = import('../../../dev/fixtures/mission-task-strip-fixtures').MissionTaskStripFixture;
type StripFocus = import('./MissionTaskStrip').StripFocus;

let container: HTMLElement;
let root: ReturnType<typeof createRoot>;
const realFetch = globalThis.fetch;
let fetches: string[] = [];

beforeEach(() => {
  fetches = [];
  globalThis.fetch = (async (url: string) => {
    fetches.push(String(url));
    return { ok: true, status: 200, json: async () => ({}) } as Response;
  }) as unknown as typeof fetch;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  globalThis.fetch = realFetch;
});

async function mount(f: Fixture, focus: StripFocus | null = null, extra: React.ReactNode = null) {
  const store = createMissionStripStore();
  await act(async () => {
    root.render(
      <MissionStripContext.Provider value={{ store, taskIds: stripOrder(f.model) }}>
        {extra}
        <LandedStrip model={f.model} compact={false} link={{ missionId: 'm1' }} workspaceId="ws1" executor={f.executor} focus={focus} count={null} />
      </MissionStripContext.Provider>,
    );
  });
  return store;
}

const cells = () => Array.from(container.querySelectorAll<HTMLButtonElement>('[data-testid="landed-strip-cell"]'));
const pressed = () => cells().findIndex(c => c.getAttribute('aria-pressed') === 'true');
const drawer = () => container.querySelector<HTMLElement>('[data-testid="landed-strip-drawer"]')!;
const click = async (el: HTMLElement) => { await act(async () => { el.click(); }); };
const key = async (k: string) => {
  const toolbar = container.querySelector<HTMLElement>('[role="toolbar"]')!;
  await act(async () => { toolbar.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })); });
};

describe('Landed strip', () => {
  it('draws every task as a pressable button in a toolbar, unfinished ones hatched', async () => {
    await mount(missionTaskStripFixture('mid-open'));
    expect(container.querySelector('[role="toolbar"]')).not.toBeNull();
    expect(cells()).toHaveLength(10);
    expect(cells().every(c => c.tagName === 'BUTTON' && c.hasAttribute('aria-pressed'))).toBe(true);
    expect(cells()[8].className).toContain('hatch');
    expect(cells()[0].className).not.toContain('hatch');
  });

  it('selects the first unfinished task on arrival, with its actions in the drawer', async () => {
    await mount(missionTaskStripFixture('mid-open'));
    expect(pressed()).toBe(8);
    expect(drawer().dataset.taskRef).toBe(stripFixtureId(9));
    expect(drawer().textContent).toContain('09 / 10');
    expect(drawer().querySelector('[data-testid="task-action-zone"]')?.getAttribute('data-actions')).toBe('claim_hint run_now');
  });

  it('selects the last task when everything landed', async () => {
    await mount(missionTaskStripFixture('all-landed'));
    expect(pressed()).toBe(9);
    expect(drawer().querySelector('[data-testid="task-action-zone"]')).toBeNull();
    expect(container.querySelector('[data-testid="landed-strip-next-open"]')?.textContent).toBe('All tasks landed');
  });

  it('a cell click selects without navigating or fetching', async () => {
    await mount(missionTaskStripFixture('mid-open'));
    const href = window.location.href;
    await click(cells()[2]);
    expect(pressed()).toBe(2);
    expect(drawer().dataset.taskRef).toBe(stripFixtureId(3));
    expect(window.location.href).toBe(href);
    expect(fetches).toEqual([]);
  });

  it('arrow keys step (wrapping), Home/End jump, and focus follows the selection', async () => {
    await mount(missionTaskStripFixture('mid-open'));
    await key('ArrowRight');
    expect(pressed()).toBe(9);
    expect(document.activeElement).toBe(cells()[9]);
    await key('ArrowRight');
    expect(pressed()).toBe(0);
    await key('ArrowLeft');
    expect(pressed()).toBe(9);
    await key('Home');
    expect(pressed()).toBe(0);
    await key('End');
    expect(pressed()).toBe(9);
    // Roving tabindex: only the selected cell is in the tab order.
    expect(cells().filter(c => c.tabIndex === 0)).toHaveLength(1);
  });

  it('the stepper and the header jump go to the next open task', async () => {
    await mount(missionTaskStripFixture('mid-open'));
    await click(cells()[0]);
    expect(container.querySelector('[data-testid="landed-strip-next-open"]')?.textContent).toBe('Next open · 09');
    await click(container.querySelector<HTMLElement>('[data-testid="landed-strip-next-open"]')!);
    expect(pressed()).toBe(8);
    expect(container.querySelector('[data-testid="landed-strip-next-open"]')?.textContent).toBe('Only open task · 09');
    await click(container.querySelector<HTMLElement>('[data-testid="landed-strip-prev"]')!);
    expect(pressed()).toBe(7);
    expect(container.querySelector('[data-testid="landed-strip-open-jump"]')?.textContent).toBe('1 open ›');
    await click(container.querySelector<HTMLElement>('[data-testid="landed-strip-open-jump"]')!);
    expect(pressed()).toBe(8);
  });

  it('opens on the situation block\'s task, with the accessor\'s sentence as its reason', async () => {
    const f = missionTaskStripFixture('states');
    await mount(f, { taskId: stripFixtureId(3), reason: 'The accessor said this.' });
    expect(drawer().dataset.taskRef).toBe(stripFixtureId(3));
    expect(drawer().querySelector('[data-testid="landed-strip-drawer-reason"]')?.textContent).toBe('The accessor said this.');
  });

  it('the situation affordance selects its cell and focuses the drawer; no second CTA', async () => {
    const f = missionTaskStripFixture('states');
    await mount(f, null, <SituationTaskAffordance label="Open the failed task" href="/x" taskId={stripFixtureId(4)} />);
    expect(container.querySelector('[data-testid="mission-primary-action"]')).toBeNull();
    const pointer = container.querySelector<HTMLElement>('[data-testid="mission-primary-action-strip"]')!;
    expect(pointer.textContent).toContain('Open the failed task · 04');
    await click(pointer);
    expect(drawer().dataset.taskRef).toBe(stripFixtureId(4));
    expect(document.activeElement).toBe(drawer());
  });

  it('without the strip, the situation affordance is the task-sheet link it always was', async () => {
    await act(async () => { root.render(<SituationTaskAffordance label="View the open task" href="/app/missions/m1?task=t" taskId="t" />); });
    const link = container.querySelector<HTMLAnchorElement>('[data-testid="mission-primary-action"]')!;
    expect(link.getAttribute('data-task-id')).toBe('t');
    expect(link.textContent).toContain('View the open task');
  });
});
