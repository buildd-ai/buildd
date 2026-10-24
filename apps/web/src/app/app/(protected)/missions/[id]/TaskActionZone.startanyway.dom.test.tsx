/**
 * Start anyway on the shared task action (spec 36df686b R-1, R-12; Health Queue
 * R-20 / AC-13: the same action on the task page, sheet and Queue). A task held
 * only by a declared dependency is not a dead end: the control names the
 * prerequisite, says the agent assesses what can proceed, posts the confirmed
 * digest with the blockers the person saw, and then says the request is
 * accepted: never that the task is running.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/missions/m1' });

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

mock.module('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
}));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: TaskActionZone } = await import('./TaskActionZone');
const { makeWaitingReason, coordinationHoldBody } = await import('@buildd/core/waiting-reason');
type Props = import('./TaskActionZone').TaskActionZoneProps;


let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let calls: Array<{ url: string; method: string; body: any }>;
let hold: ReturnType<typeof makeWaitingReason>[];
let startAnywayState: Record<string, unknown> | undefined;
const realFetch = globalThis.fetch;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  calls = [];
  hold = [];
  startAnywayState = undefined;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url: String(url), method, body });
    if (String(url).endsWith('/waiting')) return json(200, { ...(hold.length ? coordinationHoldBody(hold) : {}), waitingReasons: hold, probed: true, ...(startAnywayState ? { startAnyway: startAnywayState } : {}) });
    if (String(url).endsWith('/start')) {
      if (hold.length === 0) return json(200, { started: true, taskId: 't1' });
      const refusal = coordinationHoldBody(hold);
      if (body?.force?.reasonsDigest === refusal.reasonsDigest && refusal.canForce) {
        return json(200, { started: true, taskId: 't1', forced: { forceId: 'f1', gates: refusal.force!.gates, railsRemaining: refusal.force!.railsRemaining, expiresAt: new Date(Date.now() + 9e5).toISOString() } });
      }
      return json(422, refusal);
    }
    if (String(url).endsWith('/api/tasks/t1')) return json(200, { status: 'pending' });
    return json(200, {});
  }) as typeof fetch;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  globalThis.fetch = realFetch;
});

async function render(over: Partial<Props> = {}) {
  const props: Props = {
    taskId: 't1', workspaceId: 'ws1', phase: 'pending', isBlocked: false, blockedByCount: 0,
    backend: 'claude', lastError: null, worker: null, ...over,
  };
  await act(async () => { root.render(<TaskActionZone {...props} />); await new Promise(r => setTimeout(r, 0)); });
}
const q = (sel: string) => container.querySelector(sel) as HTMLElement | null;
async function click(sel: string) {
  await act(async () => { q(sel)!.click(); await new Promise(r => setTimeout(r, 0)); });
}


const declared = (id: string, label: string) => makeWaitingReason('dep_declared', {
  because: 'it was declared as a dependency',
  blocker: { type: 'task', id, label, href: `/app/tasks/${id}`, live: true },
  provenance: { source: 'task_context', derivedFrom: 'tasks.dependsOn' },
});
const roleHold = makeWaitingReason('role_unavailable', {
  because: 'no online runner offers the builder role',
  provenance: { source: 'runner_fleet', derivedFrom: 'fleet skills' },
});

describe('TaskActionZone: Start anyway', () => {
  it('Run now on a declared dependency offers Start anyway naming the prerequisite, not a dead end', async () => {
    hold = [declared('up-1', '“Build the schema”')];
    await render({ taskTitle: 'Add the API' });
    await click('[data-action="run_now"]');
    const confirm = q('[data-testid="task-force-confirm"]')!;
    expect(confirm.textContent).toContain('Start “Add the API” anyway?');
    expect(confirm.textContent).toContain('Build the schema');
    expect(confirm.textContent?.toLowerCase()).toContain('assesses');
    expect(q('[data-action="force_start"]')!.textContent).toBe('Start anyway');
    expect(container.textContent).not.toMatch(/can.t be forced/i);
    expect(confirm.textContent).toContain('Still enforced:');
  });

  it('the waiting line offers Start anyway… instead of Force start…', async () => {
    hold = [declared('up-1', '“Build the schema”')];
    await render({ isBlocked: true, blockedByCount: 1 });
    expect(q('[data-action="force_start_offer"]')!.textContent).toBe('Start anyway…');
  });

  it('confirming posts the digest and the blockers the person saw, then reports an accepted request, not a running task', async () => {
    hold = [declared('up-1', '“Build the schema”')];
    await render({ taskTitle: 'Add the API' });
    await click('[data-action="run_now"]');
    await click('[data-action="force_start"]');
    const post = calls.filter(c => c.url.endsWith('/start')).at(-1)!;
    expect(post.body.force).toEqual({ kinds: ['dep_declared'], reasonsDigest: coordinationHoldBody(hold).reasonsDigest, seenBlockers: ['up-1'] });
    expect(post.body.forceOverride).toBeUndefined();
    const status = q('[data-testid="task-start-status"]')!;
    expect(status.textContent).toContain('Start anyway requested');
    expect(status.textContent).not.toMatch(/running|Force start/i);
  });

  it('a real restriction beside the dependency names its fix and offers no start', async () => {
    hold = [declared('up-1', '“Build the schema”'), roleHold];
    await render();
    expect(q('[data-action="force_start_offer"]')).toBeNull();
    await click('[data-action="run_now"]');
    expect(q('[data-action="force_start"]')).toBeNull();
    expect(container.textContent).toContain('No runner for this role');
  });

  it('an accepted request is shown as requested, never running, with the dependency still in place', async () => {
    hold = [];
    startAnywayState = { phase: 'requested', label: 'Start requested, waiting for a runner', executing: false, taskStatus: 'pending' };
    await render({ isBlocked: true, blockedByCount: 1 });
    const line = q('[data-testid="task-start-anyway-status"]')!;
    expect(line.dataset.phase).toBe('requested');
    expect(line.textContent).toContain('Start requested');
    expect(line.textContent).not.toMatch(/running/i);
  });

  it('a parked task names the prerequisite it waits on and the next step', async () => {
    hold = [declared('up-1', '“Build the schema”')];
    startAnywayState = { phase: 'blocked', label: 'Blocked on Build the schema: Needs the new API', executing: false, taskStatus: 'pending', blockerTaskId: 'up-1' };
    await render({ isBlocked: true, blockedByCount: 1 });
    const line = q('[data-testid="task-start-anyway-status"]')!;
    expect(line.dataset.phase).toBe('blocked');
    expect(line.textContent).toContain('Blocked on Build the schema: Needs the new API');
  });
});
