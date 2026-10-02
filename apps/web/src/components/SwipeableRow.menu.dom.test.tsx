/**
 * SwipeableRow's ⋯ menu on the shared Sheet (mounted, happy-dom). The menu
 * kept the best keyboard behaviour of the hand-rolled sheets (§2.4): focus the
 * first item, arrow keys move, Escape closes and returns focus to ⋯. Moving it
 * onto Sheet added the aria-modal dialog and the scroll lock it lacked.
 *
 * Runs in its own process (scripts/run-unit-tests.ts), so the DOM globals stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/tasks' });

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { SwipeableRow } = await import('./SwipeableRow');

let main: HTMLElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  main = document.createElement('main');
  main.setAttribute('data-scroll-root', '');
  main.style.overflow = 'auto';
  document.body.appendChild(main);
  const container = document.createElement('div');
  main.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  main.remove();
});

const key = (k: string) => act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })); });
const menuButton = () => document.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!;

function openMenu(onRowClick: () => void = () => {}) {
  act(() =>
    root.render(
      <div onClick={onRowClick}>
        <SwipeableRow cardType="running-task" taskTitle="Fix the login" taskId="t1" taskStatus="in_progress">
          <div>card</div>
        </SwipeableRow>
      </div>,
    ),
  );
  menuButton().focus();
  act(() => menuButton().click());
}

describe('SwipeableRow menu sheet', () => {
  it('opens as an aria-modal dialog titled by the task and locks the scroll root', () => {
    openMenu();
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-label')).toBe('Fix the login');
    expect(main.style.overflow).toBe('hidden');
  });

  it('focuses the first item, arrows move, Escape closes and returns focus to ⋯', () => {
    openMenu();
    const items = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'));
    expect(items.length).toBeGreaterThan(0);
    expect(document.activeElement).toBe(items[0]);
    if (items.length > 1) {
      key('ArrowDown');
      expect(document.activeElement).toBe(items[1]);
    }
    key('Escape');
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(menuButton());
    expect(main.style.overflow).toBe('auto');
  });

  it('a click inside the sheet never reaches a row-level click handler', () => {
    let rowClicks = 0;
    openMenu(() => rowClicks++);
    rowClicks = 0; // the ⋯ click itself stops propagation; count only sheet clicks
    act(() => document.querySelector<HTMLElement>('[aria-label="Close"]')!.click());
    expect(rowClicks).toBe(0);
  });
});
