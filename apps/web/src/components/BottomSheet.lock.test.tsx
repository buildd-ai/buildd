/**
 * BottomSheet scroll-lock wiring (AC-9): the component itself, not just the
 * helpers, must lock `lockTarget()` and leave `document.body` alone.
 *
 * There is no DOM library in this repo, so React's `useEffect`/`useRef` are
 * replaced with a capturing shim and the component is called as a function;
 * the captured effect is then run against a fake `document`. This file runs in
 * its own process (scripts/run-unit-tests.ts), so the `react` mock cannot leak.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

type Effect = () => void | (() => void);
const effects: Effect[] = [];

// Keep the real module (the JSX runtime reads its internals); swap only the two hooks.
const realReact = await import('react');
mock.module('react', () => ({
  ...realReact,
  default: realReact,
  useRef: <T,>(init: T) => ({ current: init }),
  useEffect: (fn: Effect) => {
    effects.push(fn);
  },
}));

const { default: BottomSheet } = await import('./BottomSheet');

const fakeEl = (overflow = '') => ({ style: { overflow } }) as unknown as HTMLElement;

let body: HTMLElement;
let listeners: Map<string, (e: unknown) => void>;
const realDocument = (globalThis as { document?: unknown }).document;

beforeEach(() => {
  effects.length = 0;
  body = fakeEl('');
  listeners = new Map();
  (globalThis as { document?: unknown }).document = {
    body,
    addEventListener: (type: string, fn: (e: unknown) => void) => listeners.set(type, fn),
    removeEventListener: (type: string) => listeners.delete(type),
  };
});

afterEach(() => {
  (globalThis as { document?: unknown }).document = realDocument;
});

/** Render once, run the mount effects, return their cleanups. */
function mount(props: Partial<Parameters<typeof BottomSheet>[0]> = {}) {
  BottomSheet({ open: true, onClose: () => {}, title: 'Task', children: null, ...props });
  return effects.map(fn => fn()).filter((c): c is () => void => typeof c === 'function');
}

describe('BottomSheet scroll lock (AC-9)', () => {
  it('locks lockTarget() while open, leaves body untouched, and restores on close', () => {
    const main = fakeEl('auto');
    const cleanups = mount({ lockTarget: () => main });
    expect(main.style.overflow).toBe('hidden');
    expect(body.style.overflow).toBe('');
    cleanups.forEach(c => c());
    expect(main.style.overflow).toBe('auto');
    expect(body.style.overflow).toBe('');
  });

  it('locks body when no lockTarget is given (existing consumers unchanged)', () => {
    body.style.overflow = 'scroll';
    const cleanups = mount();
    expect(body.style.overflow).toBe('hidden');
    cleanups.forEach(c => c());
    expect(body.style.overflow).toBe('scroll');
  });

  it('locks nothing while closed', () => {
    const main = fakeEl('auto');
    BottomSheet({ open: false, onClose: () => {}, title: 'Task', children: null, lockTarget: () => main });
    effects.forEach(fn => fn());
    expect(main.style.overflow).toBe('auto');
    expect(body.style.overflow).toBe('');
  });

  it('closes on Escape and removes the listener on close', () => {
    let closed = 0;
    const cleanups = mount({ onClose: () => { closed += 1; }, lockTarget: () => fakeEl() });
    listeners.get('keydown')?.({ key: 'Enter' });
    listeners.get('keydown')?.({ key: 'Escape' });
    expect(closed).toBe(1);
    cleanups.forEach(c => c());
    expect(listeners.has('keydown')).toBe(false);
  });
});
