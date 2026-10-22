/**
 * TaskActionZone mounted (happy-dom) for Living Spec d25d923d R-20 / AC-12:
 * a task waiting on another task offers Start now anyway and Cancel and no
 * Retry; a task buildd is retrying offers Retry now, which only clears its
 * scheduled start.
 *
 * Runs in its own process (scripts/run-unit-tests.ts), so the DOM globals stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/tasks/t1' });

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

mock.module('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
}));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: TaskActionZone } = await import('./TaskActionZone');

let container: HTMLElement;
let root: ReturnType<typeof createRoot>;
const realFetch = globalThis.fetch;
let calls: { url: string; method?: string; body: unknown }[] = [];

beforeEach(() => {
  calls = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (String(url).endsWith('/waiting')) return { ok: true, status: 200, json: async () => ({ waitingReasons: [] }) } as Response;
    return { ok: true, status: 200, json: async () => ({}) } as Response;
  }) as unknown as typeof fetch;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  globalThis.fetch = realFetch;
});

const flush = async () => { await act(async () => { await new Promise(r => setTimeout(r, 0)); }); };
const button = (label: string) =>
  Array.from(container.querySelectorAll('button')).find(b => b.textContent?.includes(label)) as HTMLButtonElement | undefined;

async function mount(props: Partial<Parameters<typeof TaskActionZone>[0]> = {}) {
  await act(async () => {
    root.render(
      <TaskActionZone taskId="t1" workspaceId="ws1" phase="pending" isBlocked={false} blockedByCount={0} backend="claude" lastError={null} worker={null} {...props} />,
    );
  });
}

const on = { taskId: 'b', title: 'Runner image' };

describe('TaskActionZone — waiting on a task', () => {
  it('offers Start now anyway and Cancel, with no Retry or Run now', async () => {
    await mount({ phase: 'blocked', isBlocked: true, blockedByCount: 1, trouble: { kind: 'waiting', on } });
    await flush();
    expect(button('Start now anyway')).toBeDefined();
    expect(button('Cancel')).toBeDefined();
    expect(button('Retry')).toBeUndefined();
    expect(button('Run now')).toBeUndefined();
    expect(container.querySelector('[data-testid="task-trouble-line"]')?.textContent).toContain('Waiting on “Runner image”');
  });

  it('a blocker that was cancelled says a person must act', async () => {
    await mount({ trouble: { kind: 'needs_person', cause: 'blocker_cancelled', on } });
    await flush();
    expect(button('Start now anyway')).toBeDefined();
    expect(container.querySelector('[data-testid="task-trouble-line"]')?.textContent).toContain('was cancelled');
  });

  it('Start now anyway lifts the wait through /start', async () => {
    await mount({ phase: 'blocked', isBlocked: true, blockedByCount: 1, trouble: { kind: 'waiting', on } });
    await flush();
    await act(async () => { button('Start now anyway')!.click(); });
    await flush();
    expect(calls.find(c => c.url === '/api/tasks/t1/start')?.body).toEqual({ forceOverride: true });
  });

  it('Cancel cancels the task', async () => {
    await mount({ phase: 'blocked', isBlocked: true, blockedByCount: 1, trouble: { kind: 'waiting', on } });
    await flush();
    await act(async () => { button('Cancel')!.click(); });
    await flush();
    expect(calls.find(c => c.url === '/api/tasks/t1' && c.method === 'PATCH')?.body).toEqual({ status: 'cancelled' });
  });
});

describe('TaskActionZone — buildd retrying', () => {
  it('Retry now replaces Run now and only clears the scheduled start', async () => {
    await mount({ trouble: { kind: 'retrying', cause: 'infra', resumesAt: '2026-10-22T13:00:00Z' } });
    await flush();
    expect(button('Run now')).toBeUndefined();
    expect(container.querySelector('[data-testid="task-resumes-at"]')?.getAttribute('dateTime')).toBe('2026-10-22T13:00:00Z');
    await act(async () => { button('Retry now')!.click(); });
    await flush();
    expect(calls.filter(c => c.method === 'PATCH')).toEqual([{ url: '/api/tasks/t1', method: 'PATCH', body: { startAt: null } }]);
  });
});
