/**
 * SlotLanes, mounted (happy-dom): tap-to-select. The first tap on a bar
 * highlights every bar sharing its focus key (a mission, for Health's lanes)
 * and dims the rest; a second tap on the same bar follows its link; tapping
 * the empty track or pressing Escape clears.
 *
 * Runs in its own process (scripts/run-unit-tests.ts), so the DOM globals stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app' });

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

mock.module('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown }) => (
    <a href={href} {...rest}>{children as never}</a>
  ),
}));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: SlotLanes } = await import('./SlotLanes');
type Lanes = Parameters<typeof SlotLanes>[0]['lanes'];

const T = Date.UTC(2026, 0, 1);
const m = (n: number) => T + n * 60_000;

const lanes: Lanes = [
  {
    id: 'r1', label: 'runner',
    bars: [
      { id: 'a', start: m(0), end: m(20), tone: 'done', label: 'one', href: '/t/a', focusKey: 'mission-1' },
      { id: 'b', start: m(25), end: m(50), tone: 'done', label: 'two', href: '/t/b', focusKey: 'mission-2' },
      { id: 'c', start: m(55), end: m(80), tone: 'done', label: 'three', href: '/t/c', focusKey: 'mission-1' },
      { id: 'd', start: m(82), end: m(98), tone: 'done', label: 'loose', href: '/t/d' },
    ],
  },
];

let container: HTMLElement;
let root: ReturnType<typeof createRoot>;
let selected: Array<string | null>;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  selected = [];
  act(() => root.render(
    <SlotLanes lanes={lanes} from={m(0)} to={m(100)} selectable onSelect={b => selected.push(b?.id ?? null)} />,
  ));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const bar = (id: string) => container.querySelector<HTMLElement>(`[data-bar-id="${id}"]`)!;
/** Dispatches a click and reports whether the link would have been followed. */
function tap(el: Element): boolean {
  const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
  act(() => { el.dispatchEvent(ev); });
  return !ev.defaultPrevented;
}
const focused = () => [...container.querySelectorAll('[data-focus="on"]')].map(e => e.getAttribute('data-bar-id'));
const dimmed = () => [...container.querySelectorAll('[data-focus="off"]')].map(e => e.getAttribute('data-bar-id'));

describe('SlotLanes selection', () => {
  it('nothing is focused or dimmed before a tap', () => {
    expect(focused()).toEqual([]);
    expect(dimmed()).toEqual([]);
  });

  it('the first tap highlights every bar with the same focus key, dims the rest, and does not navigate', () => {
    expect(tap(bar('a'))).toBe(false);
    expect(focused().sort()).toEqual(['a', 'c']);
    expect(dimmed().sort()).toEqual(['b', 'd']);
    expect(selected).toEqual(['a']);
  });

  it('a second tap on the same bar follows its link', () => {
    tap(bar('a'));
    expect(tap(bar('a'))).toBe(true);
  });

  it('a tap on another bar moves the selection instead of navigating', () => {
    tap(bar('a'));
    expect(tap(bar('b'))).toBe(false);
    expect(focused()).toEqual(['b']);
    expect(selected).toEqual(['a', 'b']);
  });

  it('a bar with no focus key highlights only itself', () => {
    tap(bar('d'));
    expect(focused()).toEqual(['d']);
  });

  it('tapping the empty track clears the selection', () => {
    tap(bar('a'));
    tap(container.querySelector('[data-testid="slot-lane-track"]')!);
    expect(focused()).toEqual([]);
    expect(dimmed()).toEqual([]);
    expect(selected).toEqual(['a', null]);
  });

  it('Escape clears the selection', () => {
    tap(bar('a'));
    act(() => { container.querySelector('[data-testid="slot-lanes"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(focused()).toEqual([]);
  });
});

describe('SlotLanes without selectable', () => {
  it('a tap navigates straight away (the mission Lanes tab and Home keep their behaviour)', () => {
    act(() => root.render(<SlotLanes lanes={lanes} from={m(0)} to={m(100)} />));
    expect(tap(bar('a'))).toBe(true);
    expect(focused()).toEqual([]);
  });
});

it('a selected bar has no hover card covering the chart', () => {
  act(() => root.render(<SlotLanes lanes={lanes} from={m(0)} to={m(100)} selectable hoverCard />));
  act(() => { bar('a').dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); });
  tap(bar('a'));
  expect(container.querySelector('[data-testid="lane-bar-card"]')).toBeNull();
});
