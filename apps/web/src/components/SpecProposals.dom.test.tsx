/**
 * Proposals list (Living Spec b7fc9316 R-35, AC-36), mounted (happy-dom):
 * each unrequested draft links to its spec and says what wrote it; none, no section.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/workspaces/w/specs' });

import { afterEach, describe, expect, it } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: SpecProposals } = await import('./SpecProposals');

const row = (over = {}) => ({ specId: 'a1', title: 'Failure watch snapshot', workspaceId: 'w', headRevision: 1, proposedAt: new Date(Date.now() - 3_600_000).toISOString(), taskId: 't', taskTitle: 'Watch failures', ...over });
let container: HTMLElement | null = null;
afterEach(() => { container?.remove(); container = null; });
async function mount(proposals: any[]) {
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => { createRoot(container!).render(<SpecProposals proposals={proposals} />); });
  return container;
}

describe('SpecProposals (AC-36)', () => {
  it('lists each proposal linking to its spec, naming the task', async () => {
    const c = await mount([row(), row({ specId: 'b2', title: 'Another', taskTitle: null })]);
    const items = c.querySelectorAll('[data-testid="spec-proposal"]');
    expect(items).toHaveLength(2);
    expect(items[0].getAttribute('href')).toBe('/app/specs/a1');
    expect(items[0].textContent).toContain('Failure watch snapshot');
    expect(items[0].textContent).toContain('Watch failures');
    expect(items[1].textContent).toContain('Written by a task');
    expect(c.querySelector('h2')?.textContent).toBe('Proposals');
  });
  it('none: no section', async () => {
    const c = await mount([]);
    expect(c.querySelector('[data-testid="spec-proposals"]')).toBeNull();
  });
});
