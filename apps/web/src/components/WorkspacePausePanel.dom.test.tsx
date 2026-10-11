/**
 * WorkspacePausePanel mounted (happy-dom): one quiet button that opens a small
 * sheet. Its scope defaults to the workspace the page is filtered to, else all
 * workspaces (never the first one alphabetically), and pausing all sends one
 * request per workspace.
 *
 * Runs in its own process (scripts/run-unit-tests.ts), so the globals and
 * module mocks stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/health/runners' });

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

mock.module('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, prefetch: () => {} }),
}));
mock.module('@/components/ui/Select', () => ({
  Select: ({ value, onChange, options, ...rest }: { value: string; onChange: (v: string) => void; options: Array<{ value: string; label: string }> }) => (
    <select data-testid="pause-scope" value={value} onChange={e => onChange((e.target as HTMLSelectElement).value)} {...rest}>
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  ),
}));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: WorkspacePausePanel } = await import('./WorkspacePausePanel');

const workspaces = [
  { id: 'w-a', name: 'agent-runtime-spike-large-big', pausedUntil: null },
  { id: 'w-b', name: 'buildd', pausedUntil: null },
];

let container: HTMLElement;
let root: ReturnType<typeof createRoot>;
let posts: string[];

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  posts = [];
  globalThis.fetch = (async (url: string) => { posts.push(String(url)); return new Response('{}', { status: 200 }); }) as typeof fetch;
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

const button = (text: string) => [...container.querySelectorAll('button')].find(b => b.textContent?.trim() === text) ?? null;
async function click(el: Element | null) {
  if (!el) throw new Error('missing element');
  await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
}

describe('WorkspacePausePanel', () => {
  it('is one quiet button until opened: no row of duration buttons on the page', () => {
    act(() => root.render(<WorkspacePausePanel workspaces={workspaces} />));
    expect(button('Pause new starts…')).not.toBeNull();
    expect(button('For 1 hour')).toBeNull();
    expect(container.querySelector('[data-testid="pause-scope"]')).toBeNull();
  });

  it('opened with no workspace filter, it pauses all workspaces, not the first one alphabetically', async () => {
    act(() => root.render(<WorkspacePausePanel workspaces={workspaces} />));
    await click(button('Pause new starts…'));
    expect((container.querySelector('[data-testid="pause-scope"]') as HTMLSelectElement).value).toBe('all');
    await click(button('For 1 hour'));
    expect(posts.sort()).toEqual(['/api/workspaces/w-a/pause-starts', '/api/workspaces/w-b/pause-starts']);
  });

  it('opened on a page filtered to a workspace, it pauses that one', async () => {
    act(() => root.render(<WorkspacePausePanel workspaces={workspaces} defaultWorkspaceId="w-b" />));
    await click(button('Pause new starts…'));
    expect((container.querySelector('[data-testid="pause-scope"]') as HTMLSelectElement).value).toBe('w-b');
    await click(button('For 4 hours'));
    expect(posts).toEqual(['/api/workspaces/w-b/pause-starts']);
  });
});
