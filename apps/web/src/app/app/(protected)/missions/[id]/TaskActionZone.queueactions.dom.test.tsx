/**
 * Health › Queue R-12: Remove dependency and Release lane exist on the task
 * itself, through the same forms and requests as the Queue sheets.
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
const { makeWaitingReason, coordinationHoldBody } = await import('@buildd/core/waiting-reason');

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let calls: Array<{ url: string; method: string; body: any }>;
let hold: ReturnType<typeof makeWaitingReason>[];
let failWith: string | null;
let changed: number;
const realFetch = globalThis.fetch;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  calls = [];
  hold = [];
  failWith = null;
  changed = 0;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ url: String(url), method, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (String(url).endsWith('/waiting')) return json(200, { ...(hold.length ? coordinationHoldBody(hold) : {}), waitingReasons: hold, probed: true });
    if (method !== 'GET' && failWith) return json(409, { error: failWith });
    return json(200, {});
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
const q = (sel: string) => container.querySelector(sel) as HTMLElement | null;
async function click(sel: string) { await act(async () => { q(sel)!.click(); }); await flush(); }
async function type(sel: string, value: string) {
  await act(async () => {
    const el = q(sel) as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function render() {
  await act(async () => {
    root.render(<TaskActionZone taskId="t1" workspaceId="ws1" phase="pending" isBlocked={false} blockedByCount={0} backend="claude" lastError={null} worker={null} onChanged={() => { changed++; }} />);
  });
  await flush();
}

const declared = makeWaitingReason('dep_declared', {
  because: 'it was declared as a dependency',
  blocker: { type: 'task', id: 'up-1', label: 'Build the schema', href: '/app/tasks/up-1' },
  provenance: { source: 'task_context', derivedFrom: 'tasks.dependsOn' },
});
const lane = (stuckSince?: string) => makeWaitingReason('lane', {
  because: 'the schema lane is held',
  blocker: { type: 'task', id: 'holder-1', label: 'Add column', href: '/app/tasks/holder-1' },
  lane: { lane: 'migration', holderTaskId: 'holder-1', position: 1, ...(stuckSince ? { stuckSince } : {}) },
  provenance: { source: 'ledger', derivedFrom: 'lane claims' },
});

describe('TaskActionZone: Queue actions on the task', () => {
  it('Remove dependency needs a reason, then PATCHes removeDependency', async () => {
    hold = [declared];
    await render();
    await click('[data-testid="task-remove-dependency-open"]');
    expect((q('[data-testid="queue-remove-dependency"]') as HTMLButtonElement).disabled).toBe(true);
    await type('[data-testid="queue-remove-reason"]', ' shipped by hand ');
    await click('[data-testid="queue-remove-dependency"]');
    const patch = calls.find(c => c.method === 'PATCH')!;
    expect(patch.url).toBe('/api/tasks/t1');
    expect(patch.body).toEqual({ removeDependency: { taskId: 'up-1', reason: 'shipped by hand' } });
    expect(changed).toBe(1);
  });

  it('a refused removal shows the server message and does not refresh', async () => {
    hold = [declared];
    failWith = 'Not allowed';
    await render();
    await click('[data-testid="task-remove-dependency-open"]');
    await type('[data-testid="queue-remove-reason"]', 'why');
    await click('[data-testid="queue-remove-dependency"]');
    expect(q('[role="alert"]')?.textContent).toBe('Not allowed');
    expect(changed).toBe(0);
  });

  it('Release lane confirms, then POSTs lanes/release for the stuck holder', async () => {
    hold = [lane(new Date(Date.now() - 3 * 86_400_000).toISOString())];
    await render();
    expect(q('[data-testid="task-release-lane"]')!.textContent).toContain('No PR activity for 3d');
    await click('[data-testid="queue-lane-release"]');
    expect(calls.some(c => c.url.includes('/lanes/release'))).toBe(false);
    await click('[data-testid="queue-lane-release-confirm"]');
    const post = calls.find(c => c.url === '/api/workspaces/ws1/lanes/release')!;
    expect(post.method).toBe('POST');
    expect(post.body).toMatchObject({ lane: 'migration', taskId: 'holder-1' });
    expect(post.body.reason).toContain('task page');
    expect(changed).toBe(1);
  });

  it('offers neither action for a live lane or no declared dependency', async () => {
    hold = [lane()];
    await render();
    expect(q('[data-testid="task-queue-actions"]')).toBeNull();
  });
});
