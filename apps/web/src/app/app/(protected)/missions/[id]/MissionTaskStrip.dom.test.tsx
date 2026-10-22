/**
 * The Landed strip on the mission Board (happy-dom):
 * - cells are buttons in a toolbar; a click opens the task's page (spec
 *   d25d923d R-1), a summary cell the mission's History; no drawer renders;
 * - the default selection is the first active task (all landed: the last);
 * - cells are in dependency order, ready/blocked/queued drawn apart, and the
 *   selection marks its blockers (or what it unblocks) on the tick row
 *   (docs/specs/mission-progress-strip-ordering.md);
 * - ArrowLeft/Right step and Home/End jump, with focus following;
 * - the header's "N open ›" is a link to the next open task's page;
 * - selecting a task makes no request.
 *
 * Runs in its own process (scripts/run-unit-tests.ts), so the DOM globals stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/missions/m1' });

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const pushed: string[] = [];
mock.module('next/navigation', () => ({
  useRouter: () => ({ push: (url: string) => { pushed.push(url); }, replace: () => {}, refresh: () => {} }),
}));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { LandedStrip } = await import('./MissionTaskStrip');
const { MissionStripContext, createMissionStripStore } = await import('@/components/missions/mission-strip-context');
const { stripOrder } = await import('@/lib/mission-task-strip');
const { missionTaskStripFixture, stripFixtureId, dagBoard, dagId, DAG_SPECS } = await import('../../../dev/fixtures/mission-task-strip-fixtures');
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

async function mount(f: Pick<Fixture, 'model'>, focus: StripFocus | null = null) {
  const store = createMissionStripStore();
  pushed.length = 0;
  await act(async () => {
    root.render(
      <MissionStripContext.Provider value={{ store, taskIds: stripOrder(f.model) }}>
        <LandedStrip model={f.model} compact={false} link={{ missionId: 'm1', from: 'home' }} focus={focus} count={null} />
      </MissionStripContext.Provider>,
    );
  });
  return store;
}

const cells = () => Array.from(container.querySelectorAll<HTMLButtonElement>('[data-testid="landed-strip-cell"]'));
const pressed = () => cells().findIndex(c => c.getAttribute('aria-pressed') === 'true');
const ticks = () => Array.from(container.querySelectorAll<HTMLElement>('[data-testid="landed-strip-tick"]'));
const click = async (el: HTMLElement) => { await act(async () => { el.click(); }); };
const key = async (k: string) => {
  const toolbar = container.querySelector<HTMLElement>('[role="toolbar"]')!;
  await act(async () => { toolbar.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })); });
};
/** Select cell `i` the keyboard way (a click opens the task page instead). */
const selectAt = async (i: number) => {
  await key('Home');
  for (let k = 0; k < i; k++) await key('ArrowRight');
};
const jump = () => container.querySelector<HTMLAnchorElement>('[data-testid="landed-strip-open-jump"]');

describe('Landed strip', () => {
  it('draws every task as a pressable button in a toolbar; a ready one is an empty slot', async () => {
    await mount(missionTaskStripFixture('mid-open'));
    expect(container.querySelector('[role="toolbar"]')).not.toBeNull();
    expect(cells()).toHaveLength(10);
    expect(cells().every(c => c.tagName === 'BUTTON' && c.hasAttribute('aria-pressed'))).toBe(true);
    expect(cells()[8].dataset.status).toBe('ready');
    expect(cells()[8].className).toContain('bg-card');
    expect(cells()[8].className).not.toContain('hatch');
    expect(cells()[0].className).toContain('bg-status-success');
  });

  it('selects the first unfinished task on arrival, and draws no drawer, stepper or dock (spec d25d923d AC-1)', async () => {
    await mount(missionTaskStripFixture('mid-open'));
    expect(pressed()).toBe(8);
    expect(container.querySelector('[data-testid="landed-strip-drawer"]')).toBeNull();
    expect(container.querySelector('[data-testid="landed-strip-next-open"]')).toBeNull();
    expect(container.querySelector('[data-testid="landed-strip-prev"]')).toBeNull();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(cells().some(c => c.hasAttribute('aria-controls'))).toBe(false);
  });

  it('selects the last task when everything landed, and offers no jump', async () => {
    await mount(missionTaskStripFixture('all-landed'));
    expect(pressed()).toBe(9);
    expect(jump()).toBeNull();
    expect(container.querySelector('[data-testid="landed-strip-band"]')?.textContent).toContain('Merged');
    expect(container.querySelector('[data-testid="landed-strip-band"]')?.textContent).not.toMatch(/landed/i);
  });

  it('a cell click opens that task’s page with the back context, and fetches nothing (spec d25d923d R-1)', async () => {
    await mount(missionTaskStripFixture('mid-open'));
    fetches = [];
    await click(cells()[2]);
    expect(pushed).toEqual([`/app/tasks/${stripFixtureId(3)}?from=home`]);
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
    expect(pushed).toEqual([]);
  });

  it('the header jump is a link to the next open task’s page', async () => {
    await mount(missionTaskStripFixture('mid-open'));
    expect(jump()?.textContent).toBe('1 open ›');
    expect(jump()?.getAttribute('href')).toBe(`/app/tasks/${stripFixtureId(9)}?from=home`);
  });

  it('opens on the situation block\'s task', async () => {
    await mount(missionTaskStripFixture('states'), { taskId: stripFixtureId(3), reason: 'The accessor said this.' });
    expect(cells()[pressed()].dataset.taskRef).toBe(stripFixtureId(3));
  });

  it('TONE-1: a failed cell\'s tick digit, outline and the header count all agree — none of them read "open"', async () => {
    await mount(missionTaskStripFixture('states'));
    // Strip order: 01 landed, 02 ready (queued on a runner), 03 blocked (waits
    // on 02), 04 failed — the fixture's own doc comment.
    const failedCell = cells()[3];
    expect(failedCell.dataset.status).toBe('failed');
    expect(failedCell.className).toContain('border-status-error');
    expect(failedCell.className).not.toContain('border-accent');

    const failedTick = ticks()[3];
    expect(failedTick.dataset.tone).toBe('error');
    expect(failedTick.className).toContain('text-status-error');
    expect(failedTick.className).not.toContain('text-accent-text');

    const openTick = ticks()[1];
    expect(openTick.dataset.tone).toBe('open');
    expect(openTick.className).toContain('text-text-secondary');
    expect(openTick.className).not.toContain('text-status-error');

    expect(jump()?.textContent).toBe('1 open · 1 failed · 1 waiting ›');
  });

  it('selecting a held task keeps its held state (gray, never mustard) while raw status stays blocked', async () => {
    const spec = {
      tasks: ['01', '02', '03', '04', '05', '06', '07', '08'],
      edges: { '06': ['05'], '07': ['06'], '08': ['07'] },
      states: { '01': 'landed', '02': 'failed', '03': 'failed', '04': 'failed' } as const,
    };
    const model = dagBoard(spec);
    await mount({ model });
    const at = cells().findIndex(c => c.dataset.taskRef === dagId(spec, '08'));
    await selectAt(at);
    const cell = cells()[at];
    expect(cell.getAttribute('aria-pressed')).toBe('true');
    expect(cell.className).toContain('outline-text-primary'); // selection ring only
    expect(cell.className).toContain('fleet-hatch'); // fill still the held texture
    expect(cell.className).not.toContain('border-accent');
    expect(cell.className).not.toContain('border-status-error');
    expect(model.tasks[dagId(spec, '08')].status).toBe('blocked');
    expect(jump()?.textContent).toBe('1 open · 3 failed · 3 waiting ›');
  });

  it('AC-7: ready, blocked and queued cells carry three different fills', async () => {
    const spec = DAG_SPECS.field;
    await mount({ model: dagBoard(spec) });
    const cellOf = (n: string) => cells().find(c => c.dataset.taskRef === dagId(spec, n))!;
    const [ready, blocked, queued] = [cellOf('G'), cellOf('H'), cellOf('J')];
    expect([ready, blocked, queued].map(c => c.dataset.status)).toEqual(['ready', 'blocked', 'queued']);
    expect(new Set([ready.className, blocked.className, queued.className]).size).toBe(3);
    expect(ready.className).toContain('bg-card');
    expect(blocked.className).toMatch(/fleet-hatch(\s|$)/);
    expect(queued.className).toContain('fleet-hatch-future');
  });

  it('AC-10: selecting D in the field case marks its 8 blockers', async () => {
    const spec = DAG_SPECS.field;
    await mount({ model: dagBoard(spec) });
    await selectAt(cells().findIndex(c => c.dataset.taskRef === dagId(spec, 'D')));
    expect(pressed()).toBe(12);
    const marks = ticks().map(t => t.dataset.mark ?? null);
    expect(marks).toEqual([null, null, null, null, 'transitive', 'transitive', 'transitive', 'transitive', 'transitive', 'transitive', 'transitive', 'direct', null, null]);
    expect(marks.filter(Boolean)).toHaveLength(8);
  });

  it('AC-11: selecting ready G marks what it unblocks', async () => {
    const spec = DAG_SPECS.field;
    await mount({ model: dagBoard(spec) });
    await selectAt(cells().findIndex(c => c.dataset.taskRef === dagId(spec, 'G')));
    const marked = ticks().flatMap((t, i) => (t.dataset.mark ? [`${i + 1}:${t.dataset.mark}`] : []));
    expect(marked).toEqual(['8:direct', '10:transitive', '12:transitive', '13:direct', '14:transitive']);
  });

  it('AC-15: the jump skips held cells; the header counts held apart', async () => {
    const spec = DAG_SPECS.field;
    await mount({ model: dagBoard(spec) });
    expect(jump()?.textContent).toBe('2 open · 8 waiting ›');
    await selectAt(0);
    expect(jump()?.getAttribute('href')).toBe(`/app/tasks/${cells()[4].dataset.taskRef}?from=home`);
    await selectAt(4);
    expect(jump()?.getAttribute('href')).toBe(`/app/tasks/${cells()[5].dataset.taskRef}?from=home`);
  });

  it('AC-16: nothing active — the jump names the held work and links to it', async () => {
    const spec = { tasks: ['A', 'B'], edges: { B: ['A'] }, states: { A: 'landed' as const }, external: { B: ['x'] } };
    await mount({ model: dagBoard(spec, { externalDeps: [{ id: 'x', title: 'other work', status: 'pending' }] }) });
    expect(jump()?.textContent).toBe('1 waiting ›');
    expect(jump()?.getAttribute('href')).toBe(`/app/tasks/${dagId(spec, 'B')}?from=home`);
  });

  it('AC-19: past 24 cells the gap tightens to 1px and a mark is still drawn per cell', async () => {
    const spec = DAG_SPECS.wide;
    await mount({ model: dagBoard(spec) });
    const band = container.querySelector<HTMLElement>('[data-testid="landed-strip-band"]')!;
    expect(band.className).toContain('[--strip-gap:1px]');
    expect(cells()).toHaveLength(31);
    const marked = ticks().filter(t => t.dataset.mark === 'direct');
    expect(marked).toHaveLength(30);
    expect(marked.every(t => t.querySelector('i')?.className.includes('w-full'))).toBe(true);
  });
});
