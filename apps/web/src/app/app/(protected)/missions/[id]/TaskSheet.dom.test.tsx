/**
 * TaskSheet, mounted (happy-dom):
 * - AC-9 as it applies here: the mobile sheet locks the app shell's `<main>`
 *   (the element that actually scrolls), never `body`;
 * - focus moves into the sheet when it opens, and Tab stays inside the mobile
 *   modal (`aria-modal`);
 * - the drag handle sits above the sheet's header, outside the scrolling body.
 *
 * Runs in its own process (scripts/run-unit-tests.ts), so the DOM globals stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/missions/m1' });

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { TaskSheetView } = await import('./TaskSheet');
type ViewProps = import('./TaskSheet').TaskSheetViewProps;

// Illustrative fixtures only.
const TASK = '0a1b2c3d-1111-4222-8333-444455556666';
const props = (over: Partial<ViewProps> = {}): ViewProps => ({
  taskId: TASK,
  layout: 'sheet',
  mission: null,
  nav: { position: null, prevTaskId: null, nextTaskId: null, nextNeedingYou: null } as unknown as ViewProps['nav'],
  summary: { data: null, loading: true, error: null },
  onChanged: () => {},
  onClose: () => {},
  onStep: () => {},
  ...over,
});

let main: HTMLElement;
let container: HTMLElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  document.body.style.overflow = '';
  main = document.createElement('main');
  main.style.overflow = 'auto';
  document.body.appendChild(main);
  container = document.createElement('div');
  main.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  main.remove();
});

const render = (p: ViewProps) => act(() => root.render(<TaskSheetView {...p} />));
const sheet = () => document.querySelector<HTMLElement>('[data-testid="mission-task-sheet"]')!;

describe('TaskSheet scroll lock (AC-9)', () => {
  it('mobile: locks <main> while open and leaves body alone; unlocks on close', () => {
    render(props());
    expect(main.style.overflow).toBe('hidden');
    expect(document.body.style.overflow).toBe('');

    act(() => root.unmount());
    root = createRoot(container);
    expect(main.style.overflow).toBe('auto');
    expect(document.body.style.overflow).toBe('');
  });

  it('md+ docked: no lock at all', () => {
    render(props({ layout: 'docked' }));
    expect(main.style.overflow).toBe('auto');
    expect(document.body.style.overflow).toBe('');
  });
});

describe('TaskSheet focus', () => {
  it('mobile: opening moves focus into the dialog', () => {
    render(props());
    expect(sheet().contains(document.activeElement)).toBe(true);
  });

  it('md+ docked: opening moves focus into the panel', () => {
    render(props({ layout: 'docked' }));
    expect(sheet().getAttribute('data-layout')).toBe('docked');
    expect(sheet().contains(document.activeElement)).toBe(true);
  });

  it('mobile: stepping to another task keeps focus where it is (no re-grab)', () => {
    render(props());
    const link = sheet().querySelector<HTMLElement>('[data-testid="task-sheet-full-page"]')!;
    link.focus();
    render(props({ taskId: '0a1b2c3d-2222-4222-8333-444455556666' }));
    expect(document.activeElement).toBe(link);
  });

  it('mobile: Tab from the last control wraps to the first, Shift+Tab from the first wraps to the last', () => {
    render(props());
    const focusables = Array.from(sheet().querySelectorAll<HTMLElement>('a[href], button:not([disabled])'));
    expect(focusables.length).toBeGreaterThan(1);
    const first = focusables[0];
    const last = focusables[focusables.length - 1];

    last.focus();
    act(() => { document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }) as unknown as Event); });
    expect(document.activeElement).toBe(first);

    first.focus();
    act(() => { document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }) as unknown as Event); });
    expect(document.activeElement).toBe(last);
  });
});

describe('TaskSheet handle (W4, 390px)', () => {
  it('the drag handle is the first thing in the sheet, above the ✕ header and outside the scrolling body', () => {
    render(props());
    const handle = sheet().querySelector('[data-testid="task-sheet-handle"]')!;
    const close = sheet().querySelector('button[aria-label="Close"]')!;
    expect(handle).not.toBeNull();
    // DOCUMENT_POSITION_FOLLOWING: the close button comes after the handle.
    expect(handle.compareDocumentPosition(close) & 4).toBe(4);
    expect(handle.closest('.overflow-y-auto')).toBeNull();
  });
});
