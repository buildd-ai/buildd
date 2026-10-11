/**
 * ConcurrencySection mounted (happy-dom): the proactive workspace concurrency
 * control in Configure, reusing the same PATCH /api/workspaces/[id]
 * maxConcurrentTasks field the queued-task raise-cap stepper writes.
 *
 * Runs in its own process (scripts/run-unit-tests.ts), so the DOM globals stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/settings/workspace/ws1' });

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: ConcurrencySection } = await import('./ConcurrencySection');

let container: HTMLElement;
let root: ReturnType<typeof createRoot>;
const realFetch = globalThis.fetch;
let calls: { url: string; body: unknown }[] = [];

function stubFetch(reply: { status: number; body: Record<string, unknown> } = { status: 200, body: { maxConcurrentTasks: 5 } }) {
  calls = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return { ok: reply.status < 400, status: reply.status, json: async () => reply.body } as Response;
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  stubFetch();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  globalThis.fetch = realFetch;
});

const flush = async () => { await act(async () => { await new Promise(r => setTimeout(r, 0)); }); };
const button = (label: string) =>
  Array.from(container.querySelectorAll('button')).find(b => b.textContent?.includes(label)) as HTMLButtonElement | undefined;
const value = () => container.querySelector('[data-testid="workspace-concurrency-value"]')!.textContent;

async function mount(initialMaxConcurrentTasks = 3) {
  await act(async () => {
    root.render(<ConcurrencySection workspaceId="ws1" initialMaxConcurrentTasks={initialMaxConcurrentTasks} />);
  });
}

describe('ConcurrencySection', () => {
  it('has no Save button until the value changes from the saved one', async () => {
    await mount(3);
    expect(button('Save')).toBeUndefined();
    await act(async () => { button('+')!.click(); });
    expect(button('Save')).toBeDefined();
  });

  it('clamps the stepper at a floor of 1, disabling Lower once reached', async () => {
    await mount(2);
    await act(async () => { button('−')!.click(); });
    expect(value()).toBe('1');
    expect(button('−')?.disabled).toBe(true);
    await act(async () => { button('−')!.click(); }); // disabled: no-op
    expect(value()).toBe('1');
  });

  it('clamps the stepper at a ceiling of 20, disabling Raise once reached', async () => {
    await mount(19);
    await act(async () => { button('+')!.click(); });
    expect(value()).toBe('20');
    expect(button('+')?.disabled).toBe(true);
    await act(async () => { button('+')!.click(); }); // disabled: no-op
    expect(value()).toBe('20');
  });

  it('saves the new value via PATCH /api/workspaces/[id] maxConcurrentTasks, the same field raiseCapAndStart writes', async () => {
    await mount(3);
    await act(async () => { button('+')!.click(); });
    expect(value()).toBe('4');
    await act(async () => { button('Save')!.click(); });
    await flush();
    const patch = calls.find(c => c.url === '/api/workspaces/ws1');
    expect(patch?.body).toEqual({ maxConcurrentTasks: 4 });
    // Settled: Save disappears again once saved value catches up.
    expect(button('Save')).toBeUndefined();
  });

  it('on save failure keeps the error visible and reverts the shown value', async () => {
    stubFetch({ status: 500, body: { error: 'nope' } });
    await mount(3);
    await act(async () => { button('+')!.click(); });
    await act(async () => { button('Save')!.click(); });
    await flush();
    expect(container.textContent).toContain('nope');
    expect(value()).toBe('3');
  });
});
