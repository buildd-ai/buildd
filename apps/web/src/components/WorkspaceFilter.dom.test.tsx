/**
 * WorkspaceFilter mobile sheet, mounted (happy-dom at phone width). The filter
 * lives inside the fixed mobile header, whose stacking context put the sheet
 * under the bottom nav; and the body scroll lock did nothing because the shell
 * scrolls inside <main>. Fixtures are illustrative.
 *
 * Runs in its own process (scripts/run-unit-tests.ts), so the DOM globals and
 * the next/navigation mock stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/missions', width: 375, height: 667 });

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const replaced: string[] = [];
mock.module('next/navigation', () => ({
  usePathname: () => '/app/missions',
  useRouter: () => ({ push: () => {}, replace: (url: string) => replaced.push(url), refresh: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { WorkspaceFilter } = await import('./WorkspaceFilter');

const WORKSPACES = [
  { id: 'ws-alpha', name: 'Alpha' },
  { id: 'ws-beta', name: 'Beta' },
];

let main: HTMLElement;
let header: HTMLElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  replaced.length = 0;
  main = document.createElement('main');
  main.setAttribute('data-scroll-root', '');
  main.style.overflow = 'auto';
  header = document.createElement('div');
  header.style.position = 'fixed';
  document.body.append(header, main);
  root = createRoot(header);
  act(() => root.render(<WorkspaceFilter workspaces={WORKSPACES} />));
});

afterEach(() => {
  act(() => root.unmount());
  header.remove();
  main.remove();
});

function openSheet() {
  const trigger = header.querySelector<HTMLButtonElement>('button[aria-label="Filter by workspace"]')!;
  act(() => trigger.click());
  return document.querySelector<HTMLElement>('[role="dialog"][aria-label="Select workspace"]');
}

describe('WorkspaceFilter mobile sheet', () => {
  it('portals the sheet to document.body, outside the header', () => {
    const dialog = openSheet();
    expect(dialog).not.toBeNull();
    expect(header.contains(dialog)).toBe(false);
  });

  it('locks the shell scroll root while open and restores it on close', () => {
    openSheet();
    expect(main.style.overflow).toBe('hidden');
    const close = document.querySelector<HTMLButtonElement>('[role="dialog"] button[aria-label="Close"]')!;
    act(() => close.click());
    expect(main.style.overflow).toBe('auto');
  });

  it('selecting an option inside the portaled sheet still navigates (not eaten by click-outside)', () => {
    const dialog = openSheet()!;
    const option = Array.from(dialog.querySelectorAll<HTMLButtonElement>('[role="option"]')).find(o =>
      o.textContent?.includes('Beta'),
    )!;
    act(() => {
      option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    // Still mounted after the mousedown that precedes every tap.
    expect(document.querySelector('[aria-label="Select workspace"]')).not.toBeNull();
    act(() => option.click());
    expect(replaced).toEqual(['/app/missions?workspace=ws-beta']);
  });

  it('trigger is a 44px tap target below md', () => {
    const trigger = header.querySelector<HTMLButtonElement>('button[aria-label="Filter by workspace"]')!;
    expect(trigger.className).toContain('min-h-11');
    expect(trigger.className).toContain('min-w-11');
  });
});
