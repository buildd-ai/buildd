/**
 * Finished work on the Missions list (spec Surface IA §3, AC-61 to AC-66):
 * recent completions are visible in All without a tap, open work comes
 * first, completion order and age read `completedAt`, and search reaches
 * every completed mission. Fixtures are illustrative.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/missions' });
import { afterEach, describe, expect, it } from 'bun:test';
import * as missionHelpers from '@buildd/core/mission-helpers';
import { projectMissionDelivery, type MissionTaskRow } from '@/lib/delivery-projection';
import type { PortfolioRow } from '@/lib/mission-portfolio';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { MissionGrid } = await import('./MissionGrid');

const NOW = Date.UTC(2026, 10, 3, 12);
const DAY = 86_400_000;
const PR = 'https://github.com/o/r/pull/1';

const landed = (id: string): MissionTaskRow => ({ id, title: `feat: ${id}`, status: 'completed', taskClass: 'work', workers: [{ status: 'completed', prUrl: PR, mergedAt: '2026-10-01', prLifecycleStatus: 'merged' }] });
const building = (id: string): MissionTaskRow => ({ id, title: `feat: ${id}`, status: 'in_progress', taskClass: 'work', workers: [{ status: 'running' }] });

function row(id: string, title: string, tasks: MissionTaskRow[], over: Partial<PortfolioRow> = {}): PortfolioRow {
  const status = over.status ?? 'active';
  return {
    delivery: projectMissionDelivery({ id, title, status, href: `/app/missions/${id}`, isHeld: false, tasks }, missionHelpers),
    status, workspaceId: 'ws1', workspaceName: 'web', priority: 0, liveAgents: 0,
    lastAdvancedAt: NOW - 60 * 60_000, completedAt: null, nextScanMins: null, strip: [],
    ...over,
  };
}
const done = (id: string, title: string, completedAt: number | null, over: Partial<PortfolioRow> = {}) =>
  row(id, title, [landed(`${id}-a`)], { status: 'completed', completedAt, ...over });

const openRows = [row('o1', 'Settings one save model', [building('a')])];
// Deliberately out of order: the list must sort them by completedAt, not by input or update time.
const recent = [
  done('r3', 'Spec inbox review all', NOW - 2 * DAY, { lastAdvancedAt: NOW - 60_000 }),
  done('r1', 'Mission page outcome hero', NOW - 3 * 3_600_000),
  done('r2', 'Runner login detection', NOW - DAY),
  done('r4', 'Release gate copy', NOW - 3 * DAY),
  done('r5', 'Visual audit preview', NOW - 4 * DAY),
  done('r6', 'Daily digest', NOW - 5 * DAY),
];
const older = [
  done('x1', 'Runner on Windows', NOW - 21 * DAY),
  done('x2', 'CLI login without a browser', NOW - 30 * DAY),
];

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
function mount(el: React.ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(el));
}
afterEach(() => { act(() => root.unmount()); container.remove(); });

const doneIds = () => [...container.querySelectorAll('[data-testid="portfolio-done-row"]')].map(e => e.getAttribute('data-mission-id'));
const doneSection = () => container.querySelector('[data-group="completed"]');
function type(q: string) {
  const input = container.querySelector<HTMLInputElement>('[data-testid="portfolio-search"]')!;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  act(() => { setter.call(input, q); input.dispatchEvent(new Event('input', { bubbles: true })); });
}
const button = (text: string) => [...container.querySelectorAll('button')].find(b => b.textContent?.startsWith(text));

describe('Missions: finished work in All', () => {
  it('AC-61: nothing open, every recent completion is listed on first paint, newest first', () => {
    mount(<MissionGrid rows={[...recent, ...older]} slots={{ live: 0, max: 4 }} now={NOW} />);
    expect(doneSection()).not.toBeNull();
    expect(doneSection()!.querySelector('[aria-expanded="false"]')).toBeNull();
    expect(doneIds()).toEqual(['r1', 'r2', 'r3', 'r4', 'r5', 'r6']);
    expect(container.querySelector('[data-testid="portfolio-empty"]')?.textContent).toContain('No open missions.');
    expect(button('Show 2 older')).toBeDefined();
  });

  it('AC-61: nothing open and nothing completed this week, the newest older completions are listed', () => {
    mount(<MissionGrid rows={older} slots={{ live: 0, max: 4 }} now={NOW} />);
    expect(doneIds()).toEqual(['x1', 'x2']);
  });

  it('AC-62: open sections come first, then Done with at most five recent rows and controls for the rest', () => {
    mount(<MissionGrid rows={[...recent, ...openRows, ...older]} slots={{ live: 0, max: 4 }} now={NOW} />);
    const order = [...container.querySelectorAll('[data-testid="mission-group"]')].map(e => e.getAttribute('data-group'));
    expect(order).toEqual(['open', 'completed']);
    expect(container.querySelector('[data-mission-id="o1"]')).not.toBeNull();
    expect(doneIds()).toEqual(['r1', 'r2', 'r3', 'r4', 'r5']);
    act(() => button('Show 1 more')!.click());
    expect(doneIds()).toEqual(['r1', 'r2', 'r3', 'r4', 'r5', 'r6']);
    act(() => button('Show 2 older')!.click());
    expect(doneIds()).toEqual(['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'x1', 'x2']);
  });

  it('AC-63: age is read from completedAt in a <time>, and a mission with no completion time sorts last with no age', () => {
    const archived = done('a1', 'Archived without a date', null, { status: 'archived' });
    mount(<MissionGrid rows={[archived, ...recent.slice(0, 3)]} slots={{ live: 0, max: 4 }} now={NOW} />);
    const first = container.querySelector('[data-testid="portfolio-done-row"][data-mission-id="r1"]')!;
    const time = first.querySelector('time')!;
    expect(time.getAttribute('dateTime')).toBe(new Date(NOW - 3 * 3_600_000).toISOString());
    expect(time.textContent).toBe('3h ago');
    // r3 moved a minute ago but completed two days ago: its age is the completion.
    expect(container.querySelector('[data-mission-id="r3"] time')!.textContent).toBe('2d ago');
    act(() => button('Show')?.click());
    const ids = doneIds();
    expect(ids[ids.length - 1]).toBe('a1');
    expect(container.querySelector('[data-mission-id="a1"] time')).toBeNull();
  });

  it('AC-64: search reaches an older completed mission without Show older, and says only open ones are missing', () => {
    mount(<MissionGrid rows={[...openRows, ...recent, ...older]} slots={{ live: 0, max: 4 }} now={NOW} />);
    type('windows');
    expect(doneIds()).toEqual(['x1']);
    expect(container.querySelector('[data-testid="portfolio-empty"]')?.textContent).toContain('No open missions match.');
    type('zzz');
    expect(doneSection()).toBeNull();
    expect(container.querySelector('[data-testid="portfolio-empty"]')?.textContent).toContain('No missions match.');
  });

  it('AC-65: with more completed than one page, a search offers the same query on the server', () => {
    mount(<MissionGrid rows={[...openRows, ...recent]} slots={{ live: 0, max: 4 }} now={NOW} moreCompleted searchBase="/app/missions?workspace=ws1" />);
    expect(container.querySelector('[data-testid="portfolio-search-all"]')).toBeNull();
    type('login');
    expect(container.querySelector('[data-testid="portfolio-search-all"]')?.getAttribute('href')).toBe('/app/missions?workspace=ws1&q=login');
  });

  it('AC-65: a server query opens the list already searched', () => {
    mount(<MissionGrid rows={[...openRows, ...older]} slots={{ live: 0, max: 4 }} now={NOW} initialQuery="cli" />);
    expect(container.querySelector<HTMLInputElement>('[data-testid="portfolio-search"]')!.value).toBe('cli');
    expect(doneIds()).toEqual(['x2']);
  });

  it('AC-66: a status filter other than All shows open sections only', () => {
    mount(<MissionGrid rows={[...openRows, ...recent]} slots={{ live: 0, max: 4 }} now={NOW} />);
    const chip = container.querySelector('[data-filter="motion"]')!.closest('button')!;
    act(() => chip.click());
    expect(doneSection()).toBeNull();
  });
});
