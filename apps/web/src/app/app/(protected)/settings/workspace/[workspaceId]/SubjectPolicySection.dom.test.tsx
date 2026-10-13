/**
 * Repeat work (docs/specs/subject-anchor-liveness.md §5): one switch for an
 * admin, the grace period only while it is on, and a save that writes the
 * stored policy back with only those fields changed.
 *
 * Runs in its own process (scripts/run-unit-tests.ts), so the DOM globals stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/settings/workspace/ws-1' });

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: SubjectPolicySection } = await import('./SubjectPolicySection');

let host: HTMLElement;
let root: ReturnType<typeof createRoot>;
const realFetch = globalThis.fetch;
let calls: { url: string; body: unknown }[] = [];

beforeEach(() => {
  calls = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  globalThis.fetch = realFetch;
});

async function mount(node: React.ReactNode) {
  await act(async () => { root.render(node); });
}
const flush = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const switches = () => Array.from(host.querySelectorAll('[role="switch"]')) as HTMLButtonElement[];

describe('SubjectPolicySection (Repeat work)', () => {
  it('shows one switch and no prior-work control', async () => {
    await mount(<SubjectPolicySection workspaceId="ws-1" initialPolicy={null} canEdit />);
    const text = host.textContent ?? '';
    expect(text).toContain('Repeat work');
    expect(switches()).toHaveLength(1);
    expect(host.querySelector('#' + switches()[0].getAttribute('aria-labelledby'))?.textContent).toBe('Close older buildd PRs when a newer one merges');
    expect(text).not.toMatch(/prior-work|prior work/i);
    expect(text).not.toContain('Subject anchor');
    // The grace period only matters once the switch is on.
    expect(host.querySelector('#conflict-dead-days')).toBeNull();
  });

  it('turning it on saves the stored policy back with only the switch changed', async () => {
    await mount(<SubjectPolicySection workspaceId="ws-1" initialPolicy={{ priorWorkInjection: false }} canEdit />);
    await act(async () => { switches()[0].click(); });
    await flush();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/api/workspaces/ws-1');
    expect(calls[0].body).toEqual({
      gitConfig: { subjectPolicy: { priorWorkInjection: false, autoCloseBuilddSupersededPrs: true, conflictDeadDays: 7 } },
    });
    expect(host.querySelector('#conflict-dead-days')).not.toBeNull();
  });

  it('a member reads the values as text', async () => {
    await mount(<SubjectPolicySection workspaceId="ws-1" initialPolicy={{ autoCloseBuilddSupersededPrs: true, conflictDeadDays: 10 }} canEdit={false} />);
    expect(switches()).toHaveLength(0);
    expect(host.querySelector('input')).toBeNull();
    const text = host.textContent ?? '';
    expect(text).toContain('Close older buildd PRs when a newer one merges');
    expect(text).toContain('10 days');
  });
});
