/**
 * A page's one create action rides in the phone top bar's trailing slot
 * instead of on a row of its own under the bar (mobile audit 2026-11-04).
 *
 * Runs in its own process (scripts/run-unit-tests.ts), so the DOM globals stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/missions' });

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: MobileTopBarAction } = await import('./MobileTopBarAction');
const { MOBILE_TOP_BAR_ACTION_ID } = await import('./MobileTopBar');

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
  document.getElementById(MOBILE_TOP_BAR_ACTION_ID)?.remove();
});

describe('MobileTopBarAction', () => {
  it('renders its children into the top bar slot, not in place', () => {
    const slot = document.createElement('div');
    slot.id = MOBILE_TOP_BAR_ACTION_ID;
    document.body.appendChild(slot);
    act(() => root.render(<MobileTopBarAction><a href="/x">+ New</a></MobileTopBarAction>));
    expect(slot.innerHTML).toContain('+ New');
    expect(container.innerHTML).toBe('');
  });

  it('removes the action from the bar when the page unmounts', () => {
    const slot = document.createElement('div');
    slot.id = MOBILE_TOP_BAR_ACTION_ID;
    document.body.appendChild(slot);
    act(() => root.render(<MobileTopBarAction><a href="/x">+ New</a></MobileTopBarAction>));
    act(() => root.render(<div />));
    expect(slot.innerHTML).toBe('');
  });

  it('renders nothing when there is no bar (desktop shell, detail pages)', () => {
    act(() => root.render(<MobileTopBarAction><a href="/x">+ New</a></MobileTopBarAction>));
    expect(document.body.innerHTML).not.toContain('+ New');
  });
});
