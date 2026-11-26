/**
 * Home's tool review card, mounted (happy-dom): a connector tool the gateway
 * refused only because buildd does not know it reads. The card offers
 * "Treat as read-only" (PATCH markReadOnly), "Keep blocked" (PATCH
 * keepBlocked) and a link to the connector's tools, and says what failed.
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
const { unvettedToolNeedsYouItems } = await import('@/lib/connector-tool-review');
const { buildActionQueue } = await import('@/lib/action-queue');
const { deriveHomeAttention } = await import('@/lib/home-attention');

const CONN = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const card = () => {
  const queue = buildActionQueue(unvettedToolNeedsYouItems([{
    connectorId: CONN, connectorName: 'Axiom', discoveredMetadata: null, provider: 'axiom', tool: 'otel-newTool',
    taskId: 't-1', taskTitle: 'Trace slow checkout', roleSlug: 'builder', workspaceId: 'ws-1', workspaceName: 'web',
  }]), []);
  const [item] = deriveHomeAttention({ queue, missions: [], questions: [], held: [], isActionable: () => true });
  return item;
};

let container: HTMLElement;
let root: ReturnType<typeof createRoot>;
const realFetch = globalThis.fetch;
let answer: { status: number; body: object };
let calls: { url: string; method?: string; body: unknown }[];

beforeEach(() => {
  refreshed = 0;
  calls = [];
  answer = { status: 200, body: { connector: { id: CONN } } };
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : null });
    return { ok: answer.status < 300, status: answer.status, json: async () => answer.body } as Response;
  }) as unknown as typeof fetch;
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
const click = async (label: string) => {
  const btn = [...container.querySelectorAll('button')].find(b => b.textContent === label)!;
  await act(async () => { btn.click(); });
  await flush();
};

describe('tool review card', () => {
  it('says who was refused what and why, and offers Treat as read-only, Keep blocked, Tools', () => {
    act(() => root.render(<DecisionCard item={card()} onDone={() => {}} />));
    expect(ctas()).toEqual(['Treat as read-only', 'Keep blocked', 'Tools']);
    expect(container.textContent).toContain("Trace slow checkout was refused Axiom otel-newTool because buildd doesn't know it's read-only");
    expect(container.querySelector('a')!.getAttribute('href')).toBe(`/app/settings/apps?tools=${CONN}#team-apps`);
  });

  it('Treat as read-only saves markReadOnly on the connector and leaves Home', async () => {
    const done: string[] = [];
    act(() => root.render(<DecisionCard item={card()} onDone={(_k, l) => done.push(l)} />));
    await click('Treat as read-only');
    expect(calls).toEqual([{ url: `/api/connectors/${CONN}`, method: 'PATCH', body: { markReadOnly: 'otel-newTool' } }]);
    expect(done).toEqual(['treated as read-only']);
    expect(refreshed).toBe(1);
  });

  it('Keep blocked records the choice so the card does not come back', async () => {
    const done: string[] = [];
    act(() => root.render(<DecisionCard item={card()} onDone={(_k, l) => done.push(l)} />));
    await click('Keep blocked');
    expect(calls[0]).toEqual({ url: `/api/connectors/${CONN}`, method: 'PATCH', body: { keepBlocked: 'otel-newTool' } });
    expect(done).toEqual(['kept blocked']);
  });

  it('a refusal (no session, no permission) stays on the card with the reason', async () => {
    answer = { status: 403, body: { error: 'forbidden', message: 'Changing or deleting a connector requires the manage_connectors permission in its team.' } };
    const done: string[] = [];
    act(() => root.render(<DecisionCard item={card()} onDone={(_k, l) => done.push(l)} />));
    await click('Treat as read-only');
    expect(done).toEqual([]);
    expect(container.querySelector('[role="alert"]')!.textContent).toContain('manage_connectors');
    expect(ctas()).toEqual(['Treat as read-only', 'Keep blocked', 'Tools']);
  });
});
