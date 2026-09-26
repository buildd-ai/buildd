/**
 * BottomSheet hydrated already open (happy-dom): a hard load of a URL that opens
 * the sheet (e.g. TaskSheet via ?task=) server-renders it in place, then moves it
 * into the <body> portal after hydration. Focus and the Tab trap must follow the
 * live panel, not the in-place node that hydration first rendered and that the
 * portal switch then detached.
 *
 * Runs in its own process (scripts/run-unit-tests.ts), so the DOM globals stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/missions/example?task=example' });

import { afterEach, describe, expect, it } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import('react');
const { renderToString } = await import('react-dom/server');
const { hydrateRoot } = await import('react-dom/client');
const { default: BottomSheet } = await import('./BottomSheet');

function App() {
  return (
    <BottomSheet open onClose={() => {}} title="Task" testId="sheet" trapFocus>
      <button type="button">First</button>
      <button type="button">Last</button>
    </BottomSheet>
  );
}

let container: HTMLElement;
let root: ReturnType<typeof hydrateRoot> | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container.remove();
});

async function hydrateOpen() {
  container = document.createElement('div');
  container.innerHTML = renderToString(<App />);
  document.body.appendChild(container);
  await act(async () => {
    root = hydrateRoot(container, <App />);
  });
  const live = document.querySelector<HTMLElement>('[data-testid="sheet"]')!;
  return live;
}

describe('BottomSheet hydrated open', () => {
  it('ends up portaled to body, not left in the server-rendered spot', async () => {
    const live = await hydrateOpen();
    expect(live.isConnected).toBe(true);
    expect(container.contains(live)).toBe(false);
  });

  it('moves initial focus into the live (portaled) panel', async () => {
    const live = await hydrateOpen();
    expect(live.contains(document.activeElement)).toBe(true);
  });

  it('Tab from the last control wraps to the first control of the live panel', async () => {
    const live = await hydrateOpen();
    const buttons = Array.from(live.querySelectorAll<HTMLButtonElement>('button'));
    const first = buttons[0]; // the title bar's Close button
    const last = buttons[buttons.length - 1];
    expect(first.getAttribute('aria-label')).toBe('Close');
    last.focus();
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    act(() => {
      document.dispatchEvent(tab);
    });
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);
  });
});
