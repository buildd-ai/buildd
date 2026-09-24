/**
 * MissionTaskRow, mounted (happy-dom): the `↻ N` attempts toggle in the meta
 * line expands the attempts inline, and collapses them again. Fixtures are
 * illustrative.
 *
 * Runs in its own process (scripts/run-unit-tests.ts), so the DOM globals stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/missions/m1' });

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { buildMissionFeedGroups } = await import('@/lib/mission-feed-groups');
const { default: MissionTaskRow } = await import('./MissionTaskRow');

const NOW = Date.UTC(2026, 0, 2, 12, 0, 0);
const at = (m: number) => new Date(Date.UTC(2026, 0, 1) + m * 60_000);
const tasks = [
  { id: 'p', title: 'Example parent', status: 'completed', taskClass: 'work', createdAt: at(1) },
  { id: 'r1', title: 'Example retry one', status: 'failed', taskClass: 'attempt', parentTaskId: 'p', createdAt: at(2) },
  { id: 'r2', title: 'Example retry two', status: 'completed', taskClass: 'attempt', parentTaskId: 'p', createdAt: at(3) },
];

let container: HTMLElement;
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

describe('MissionTaskRow attempts toggle', () => {
  it('expands the attempts inline on tap, with each attempt a 44px link, and folds them again', () => {
    const row = buildMissionFeedGroups(tasks).rowsById.get('p')!;
    act(() => root.render(<MissionTaskRow row={row} missionId="m1" now={NOW} />));

    const button = container.querySelector<HTMLButtonElement>('[data-testid="mission-task-attempts"]')!;
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('[data-testid="mission-task-attempts-list"]')).toBeNull();

    act(() => button.click());
    expect(button.getAttribute('aria-expanded')).toBe('true');
    const list = container.querySelector<HTMLElement>('[data-testid="mission-task-attempts-list"]')!;
    expect(list.id).toBe(button.getAttribute('aria-controls')!);
    const links = [...list.querySelectorAll('a')];
    expect(links.map(a => a.getAttribute('href'))).toEqual([
      expect.stringContaining('/app/tasks/r1'),
      expect.stringContaining('/app/tasks/r2'),
    ]);
    for (const a of links) expect(a.className).toContain('min-h-11');
    // The list sits outside the row link.
    expect(list.closest('a')).toBeNull();

    act(() => button.click());
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('[data-testid="mission-task-attempts-list"]')).toBeNull();
  });
});
