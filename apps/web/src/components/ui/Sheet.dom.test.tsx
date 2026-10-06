/**
 * Sheet, mounted (happy-dom): the accessibility contract every hand-rolled
 * sheet now inherits — aria-modal dialog, Escape closes, focus returns to the
 * trigger, the shell's scroll root is locked, and the top edge is a 2px frame.
 *
 * Runs in its own process (scripts/run-unit-tests.ts), so the DOM globals stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app' });

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const React = await import('react');
const { act, useRef, useState } = React;
const { createRoot } = await import('react-dom/client');
const { default: Sheet, shouldReturnFocus } = await import('./Sheet');

let main: HTMLElement;
let container: HTMLElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  main = document.createElement('main');
  main.setAttribute('data-scroll-root', '');
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

function Harness({ explicitReturn = false, trap = true }: { explicitReturn?: boolean; trap?: boolean }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={btn} data-testid="trigger" onClick={() => setOpen(true)}>Open</button>
      <button data-testid="elsewhere">Elsewhere</button>
      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title="Policy"
        testId="sheet"
        trapFocus={trap}
        returnFocusRef={explicitReturn ? btn : undefined}
      >
        <button data-testid="inner">Inner</button>
      </Sheet>
    </>
  );
}

const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const escape = () => act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });

describe('Sheet', () => {
  it('is an aria-modal dialog named by its title, with a 2px ink top edge and square corners', () => {
    act(() => root.render(<Harness />));
    act(() => q('trigger')!.click());
    const dialog = q('sheet')!;
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-label')).toBe('Policy');
    expect(dialog.className).toContain('border-t-2');
    expect(dialog.className).toContain('border-border-strong');
    expect(dialog.className).not.toMatch(/\brounded/);
  });

  it('locks the shell scroll root while open and restores it on close', () => {
    act(() => root.render(<Harness />));
    act(() => q('trigger')!.click());
    expect(main.style.overflow).toBe('hidden');
    escape();
    expect(main.style.overflow).toBe('auto');
  });

  it('Escape closes and returns focus to the trigger', () => {
    act(() => root.render(<Harness />));
    q('trigger')!.focus();
    act(() => q('trigger')!.click());
    expect(q('sheet')!.contains(document.activeElement)).toBe(true);
    escape();
    expect(q('sheet')).toBeNull();
    expect(document.activeElement).toBe(q('trigger'));
  });

  it('returns focus to returnFocusRef even when the click did not focus the trigger (Safari)', () => {
    act(() => root.render(<Harness explicitReturn />));
    (document.activeElement as HTMLElement | null)?.blur?.();
    act(() => q('trigger')!.click());
    escape();
    expect(document.activeElement).toBe(q('trigger'));
  });

  it('the close button closes it', () => {
    act(() => root.render(<Harness />));
    act(() => q('trigger')!.click());
    act(() => document.querySelector<HTMLElement>('[aria-label="Close"]')!.click());
    expect(q('sheet')).toBeNull();
  });

  it('contextual peek keeps the chart interactive and scroll unlocked, without a backdrop', () => {
    act(() => root.render(<Sheet open contextual height="peek" onClose={() => {}} title="Tasks" testId="sheet">x</Sheet>));
    const dialog = q('sheet')!;
    expect(dialog.getAttribute('aria-modal')).toBe('false');
    expect(dialog.className).toContain('h-[35dvh]');
    expect(dialog.parentElement!.className).toContain('pointer-events-none');
    expect(dialog.className).toContain('pointer-events-auto');
    expect(dialog.parentElement!.querySelector('.bg-black\\/50')).toBeNull();
    expect(main.style.overflow).toBe('auto');
  });

  it('full-screen evidence uses the phone viewport and a centered desktop panel', () => {
    act(() => root.render(<Sheet open onClose={() => {}} title="Evidence" testId="sheet" height="full">output</Sheet>));
    const dialog = q('sheet')!;
    expect(dialog.className).toContain('h-[100dvh]');
    expect(dialog.className).toContain('md:max-h-[90dvh]');
    expect(dialog.parentElement!.className).toContain('md:items-center');
    expect(dialog.className).toContain('md:max-w-4xl');
    expect(main.style.overflow).toBe('hidden');
  });

  it('wide + tall sizes', () => {
    act(() => root.render(<Sheet open onClose={() => {}} title="A" testId="sheet" width="wide" height="tall">x</Sheet>));
    expect(q('sheet')!.className).toContain('max-w-3xl');
    expect(q('sheet')!.className).toContain('h-[88dvh]');
  });
});

describe('shouldReturnFocus', () => {
  const body = { contains: () => false } as unknown as Element;
  const el = (connected: boolean) => ({ isConnected: connected }) as unknown as Element;

  it('returns focus when it fell to body, is gone, or sat in the panel', () => {
    expect(shouldReturnFocus(null, body, null)).toBe(true);
    expect(shouldReturnFocus(body, body, null)).toBe(true);
    expect(shouldReturnFocus(el(false), body, null)).toBe(true);
    const inside = el(true);
    expect(shouldReturnFocus(inside, body, { contains: (n: unknown) => n === inside } as unknown as Element)).toBe(true);
  });

  it('never steals focus the closing action moved elsewhere', () => {
    expect(shouldReturnFocus(el(true), body, null)).toBe(false);
  });
});
