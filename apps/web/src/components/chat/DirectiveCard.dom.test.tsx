/**
 * The directive card, mounted (happy-dom): the scope preselects from the
 * part, one tap on "Remember this" saves with the chosen scope and folds the
 * card; "Not now" folds it and tells the server; an answered part draws
 * answered on reload; a failed save keeps the card open with the reason.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/chat' });

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: DirectiveCards } = await import('./DirectiveCard');

const WS = { id: 'aaaa0000-0000-4000-8000-000000000001', name: 'billing-web' };
const part = (data: Record<string, unknown>) => ({
  type: 'data-buildd-directive',
  data: { conversationId: 'c-1', text: 'Always run the billing smoke test before a PR.', suggestedScope: 'workspace', workspace: WS, source: 'jev', ...data },
});

let container: HTMLElement;
let root: ReturnType<typeof createRoot>;
const calls: Array<{ url: string; body: any }> = [];
let status = 201;

beforeEach(() => {
  calls.length = 0;
  status = 201;
  (globalThis as any).fetch = async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify(status < 300 ? { directive: { id: 'd-1' } } : { error: 'directive_limit', message: 'You have the most rules you can keep.' }), { status });
  };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function mount(parts: any[]) {
  await act(async () => { root.render(createElement(DirectiveCards, { parts, messageId: 'm-1' })); });
}
const q = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const click = async (el: Element | null) => { await act(async () => { (el as HTMLElement).click(); }); };

describe('DirectiveCard', () => {
  it('renders nothing for a message without a card', async () => {
    await mount([{ type: 'text', text: 'hi' }]);
    expect(q('directive-card')).toBeNull();
  });

  it('preselects Jev\'s scope, and one tap saves with it', async () => {
    await mount([part({})]);
    expect(q('directive-text')!.textContent).toBe('Always run the billing smoke test before a PR.');
    expect(q('directive-scope-workspace')!.getAttribute('aria-checked')).toBe('true');
    expect(q('directive-scope-workspace')!.textContent).toBe('Only billing-web');
    await click(q('directive-save'));
    expect(calls[0]).toEqual({
      url: '/api/chat/directives',
      body: { text: 'Always run the billing smoke test before a PR.', workspaceId: WS.id, from: { conversationId: 'c-1', messageId: 'm-1' } },
    });
    expect(q('directive-card')!.dataset.state).toBe('saved');
    expect(q('directive-saved-line')!.textContent).toBe('Saved. Applies only in billing-web.');
  });

  it('switching to Everywhere saves with no workspace', async () => {
    await mount([part({})]);
    await click(q('directive-scope-everywhere'));
    expect(q('directive-scope-everywhere')!.getAttribute('aria-checked')).toBe('true');
    await click(q('directive-save'));
    expect(calls[0].body.workspaceId).toBeNull();
    expect(q('directive-saved-line')!.textContent).toBe('Saved. Applies in every chat.');
  });

  it('no workspace in the turn: no toggle, everywhere only', async () => {
    await mount([part({ workspace: null, suggestedScope: 'everywhere' })]);
    expect(q('directive-scope')).toBeNull();
    expect(q('directive-scope-fixed')!.textContent).toBe('Applies in every chat.');
  });

  it('"Not now" folds the card and tells the server', async () => {
    await mount([part({})]);
    await click(q('directive-dismiss'));
    expect(q('directive-card')!.dataset.state).toBe('dismissed');
    expect(calls[0]).toEqual({ url: '/api/chat/directives/dismiss', body: { conversationId: 'c-1', messageId: 'm-1' } });
  });

  it('an answered part draws answered on reload', async () => {
    await mount([part({ status: 'saved', directiveId: 'd-1', savedScope: 'everywhere' })]);
    expect(q('directive-card')!.dataset.state).toBe('saved');
    expect(q('directive-saved-line')!.textContent).toBe('Saved. Applies in every chat.');
    await act(async () => { root.render(createElement(DirectiveCards, { parts: [part({ status: 'dismissed' })], messageId: 'm-2' })); });
    expect(q('directive-card')!.dataset.state).toBe('dismissed');
    expect(calls).toHaveLength(0);
  });

  it('a refused save stays open and says why', async () => {
    status = 409;
    await mount([part({})]);
    await click(q('directive-save'));
    expect(q('directive-card')!.dataset.state).toBe('open');
    expect(container.querySelector('[role="alert"]')!.textContent).toBe('You have the most rules you can keep.');
  });
});
