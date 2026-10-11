/**
 * A turned-off role stays findable: Roles lists it under "Turned off" with
 * where it lives and a way into the editor (where it can be turned back on).
 * The retired workspace Roles page was the only other place it showed.
 *
 * Runs in its own process (scripts/run-unit-tests.ts), so the DOM globals stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/settings/roles' });

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { TurnedOffRoles } = await import('./TurnedOffRoles');

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
});

describe('TurnedOffRoles', () => {
  it('lists each turned-off role with its scope and a link to its editor', async () => {
    await act(async () => {
      root.render(<TurnedOffRoles roles={[
        { id: 'r-1', slug: 'scout', name: 'Scout', scopeLabel: 'Team' },
        { id: 'r-2', slug: 'qa', name: 'QA', scopeLabel: 'Workspace 1' },
      ]} />);
    });
    expect(container.textContent).toContain('Turned off');
    expect(container.textContent).toContain('Scout');
    expect(container.textContent).toContain('Workspace 1');
    const links = [...container.querySelectorAll('a')].map(a => a.getAttribute('href'));
    expect(links).toContain('/app/settings/roles/scout/edit?id=r-1');
    expect(links).toContain('/app/settings/roles/qa/edit?id=r-2');
  });

  it('renders nothing when no role is turned off', async () => {
    await act(async () => { root.render(<TurnedOffRoles roles={[]} />); });
    expect(container.innerHTML).toBe('');
  });
});
