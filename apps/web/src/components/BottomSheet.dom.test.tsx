/**
 * BottomSheet, mounted (happy-dom): the sheet must escape its parent's stacking
 * context. A sheet opened from inside the fixed mobile header (z-10) or a sticky
 * masthead used to paint under the bottom nav (z-20) no matter its own z-50.
 *
 * Runs in its own process (scripts/run-unit-tests.ts), so the DOM globals stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/missions' });

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: BottomSheet } = await import('./BottomSheet');

let container: HTMLElement;
let main: HTMLElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  main = document.createElement('main');
  main.setAttribute('data-scroll-root', '');
  main.style.overflow = 'auto';
  document.body.appendChild(main);
  // Stand-in for the fixed header / sticky masthead that owns the trigger.
  container = document.createElement('div');
  container.style.position = 'fixed';
  container.style.zIndex = '10';
  main.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  main.remove();
  document.body.style.overflow = '';
});

describe('BottomSheet portal', () => {
  it('renders the dialog as a direct child of document.body, not inside its parent', () => {
    act(() => root.render(<BottomSheet open onClose={() => {}} title="Settings" testId="sheet">body</BottomSheet>));
    const dialog = document.querySelector('[data-testid="sheet"]');
    expect(dialog).not.toBeNull();
    expect(container.contains(dialog)).toBe(false);
    const overlay = dialog!.closest('[role="presentation"]');
    expect(overlay?.parentElement).toBe(document.body);
  });

  it('removes the portaled sheet when closed', () => {
    act(() => root.render(<BottomSheet open onClose={() => {}} title="Settings" testId="sheet">body</BottomSheet>));
    act(() => root.render(<BottomSheet open={false} onClose={() => {}} title="Settings" testId="sheet">body</BottomSheet>));
    expect(document.querySelector('[data-testid="sheet"]')).toBeNull();
  });

  it('locks the shell scroll root (<main>), not body, by default', () => {
    act(() => root.render(<BottomSheet open onClose={() => {}} title="Settings">body</BottomSheet>));
    expect(main.style.overflow).toBe('hidden');
    expect(document.body.style.overflow).toBe('');
    act(() => root.render(<BottomSheet open={false} onClose={() => {}} title="Settings">body</BottomSheet>));
    expect(main.style.overflow).toBe('auto');
  });

  it('falls back to body outside the shell', () => {
    main.removeAttribute('data-scroll-root');
    act(() => root.render(<BottomSheet open onClose={() => {}} title="Settings">body</BottomSheet>));
    expect(document.body.style.overflow).toBe('hidden');
  });
});
