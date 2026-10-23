/**
 * Home's access request card, mounted (happy-dom): the CTA set comes from
 * server state. An open request carries Approve, Deny and Details; once the
 * server says the request is closed (its task ended, someone else decided)
 * the card carries no buttons at all, only the line saying why.
 *
 * Runs in its own process (scripts/run-unit-tests.ts), so the DOM globals stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/home' });

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let refreshed = 0;
mock.module('next/navigation', () => ({
  useRouter: () => ({ push() {}, replace() {}, back() {}, refresh() { refreshed++; } }),
  usePathname: () => '/app/home',
  useSearchParams: () => new URLSearchParams(),
}));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { DecisionCard } = await import('./DecisionCard');
const { accessNeedsYouItems } = await import('@/lib/capability-grants-needs-you');
const { buildActionQueue } = await import('@/lib/action-queue');
const { deriveHomeAttention } = await import('@/lib/home-attention');

const card = () => {
  const queue = buildActionQueue(accessNeedsYouItems([{
    id: 'r1', status: 'pending', capability: 'model.inference', provider: 'openrouter', risk: 'query', tool: null, resource: null,
    environment: null, workspaceId: 'ws-1', taskId: 't-1', roleSlug: 'researcher', decidedBy: null, ttlSeconds: 3600,
    expiresAt: null, revokedAt: null, reason: 'compare two models', taskTitle: 'Audit model access', workspaceName: 'web',
    taskStatus: 'in_progress', workerStatus: 'running',
  }]), []);
  const [item] = deriveHomeAttention({ queue, missions: [], questions: [], held: [], isActionable: () => true });
  return item;
};

let container: HTMLElement;
let root: ReturnType<typeof createRoot>;
const realFetch = globalThis.fetch;
let answer: { status: number; body: object };

beforeEach(() => {
  refreshed = 0;
  answer = { status: 200, body: { grant: { status: 'granted' }, alreadyDecided: false } };
  globalThis.fetch = (async () => ({ ok: answer.status < 300, status: answer.status, json: async () => answer.body }) as Response) as unknown as typeof fetch;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
  globalThis.fetch = realFetch;
});

const ctas = () => [...container.querySelectorAll('[data-testid="needs-you-card"] button, [data-testid="needs-you-card"] a')].map(e => e.textContent);
const flush = async () => { await act(async () => { await new Promise(r => setTimeout(r, 0)); }); };
const approve = async () => {
  const btn = [...container.querySelectorAll('button')].find(b => b.textContent?.startsWith('Approve'))!;
  await act(async () => { btn.click(); });
  await flush();
};

describe('access request card CTA set', () => {
  it('an open request on a live task: Approve for its lease, Deny, Details', () => {
    act(() => root.render(<DecisionCard item={card()} onDone={() => {}} />));
    expect(ctas()).toEqual(['Approve for 1 hour', 'Deny', 'Details']);
  });

  it('closed because its task ended: no buttons, and the card says why', async () => {
    answer = { status: 409, body: { code: 'task_terminal', closed: true, error: 'The task has ended; the request was closed.' } };
    act(() => root.render(<DecisionCard item={card()} onDone={() => {}} />));
    await approve();
    expect(ctas()).toEqual([]);
    expect(container.querySelector('[data-testid="needs-you-actions"]')).toBeNull();
    expect(container.querySelector('[data-testid="needs-you-closed"]')!.textContent).toBe('The task has ended; the request was closed.');
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(refreshed).toBe(1);
  });

  it('closed because the agent run stopped: no buttons', async () => {
    answer = { status: 409, body: { code: 'worker_not_live', closed: true, error: 'The agent run has stopped; the request was closed.' } };
    act(() => root.render(<DecisionCard item={card()} onDone={() => {}} />));
    await approve();
    expect(ctas()).toEqual([]);
    expect(container.querySelector('[data-testid="needs-you-closed"]')!.textContent).toContain('The agent run has stopped');
  });

  it('decided by someone else: no buttons', async () => {
    answer = { status: 409, body: { code: 'already_denied', closed: true, error: 'This request is already denied.', grant: { status: 'denied' } } };
    act(() => root.render(<DecisionCard item={card()} onDone={() => {}} />));
    await approve();
    expect(ctas()).toEqual([]);
    expect(container.querySelector('[data-testid="needs-you-closed"]')!.textContent).toBe('This request is already denied.');
  });

  it('a refusal that leaves the request open (policy) keeps Deny reachable', async () => {
    answer = { status: 409, body: { code: 'policy_forbidden', closed: false, error: 'Team capability policy forbids this access. Change the policy first.' } };
    act(() => root.render(<DecisionCard item={card()} onDone={() => {}} />));
    await approve();
    expect(ctas()).toEqual(['Approve for 1 hour', 'Deny', 'Details']);
    expect(container.querySelector('[role="alert"]')!.textContent).toContain('Team capability policy forbids');
  });

  it('a request decided here leaves Home through onDone', async () => {
    const done: string[] = [];
    act(() => root.render(<DecisionCard item={card()} onDone={(_k, label) => done.push(label)} />));
    await approve();
    expect(done).toEqual(['approved']);
  });
});
