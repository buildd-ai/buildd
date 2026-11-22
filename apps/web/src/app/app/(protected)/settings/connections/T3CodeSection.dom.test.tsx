/** Settings → Connected apps → T3 Code card, mounted (happy-dom). */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/settings/connections' });

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: T3CodeSection } = await import('./T3CodeSection');

let container: HTMLElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); });

const render = (runners: Array<{ id: string; name: string; state: 'ready' | 'not-ready' | 'unknown'; label: string }>) =>
  act(() => { root.render(createElement(T3CodeSection, { runners })); });

describe('T3CodeSection', () => {
  it('explains both ways without duplicating config snippets', () => {
    render([]);
    const text = container.textContent ?? '';
    expect(text).toContain('buildd-acp');
    expect(text).toContain('Local ACP command');
    expect(text).toContain('https://buildd.dev/api/mcp');
    expect(container.querySelector('pre')).toBeNull();
    expect(container.querySelector('a[href="/app/settings/runners"]')).not.toBeNull();
  });
  it('shows one line per runner from its own report, linking to the runner page', () => {
    render([
      { id: 'a', name: 'Laptop', state: 'ready', label: 'Ready' },
      { id: 'b', name: 'Old box', state: 'unknown', label: 'Unknown, update the runner' },
    ]);
    const rows = container.querySelectorAll('[data-testid="t3-runner-row"]');
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toContain('Laptop');
    expect(rows[0].textContent).toContain('Ready');
    expect(rows[1].textContent).toContain('Unknown, update the runner');
  });
  it('shows no runner lines when there are none', () => {
    render([]);
    expect(container.querySelector('[data-testid="t3-runner-row"]')).toBeNull();
  });
});
