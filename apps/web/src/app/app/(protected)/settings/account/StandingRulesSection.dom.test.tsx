/**
 * Settings -> Standing rules, mounted (happy-dom): lists the person's rules
 * with their scope, adds one, edits one, removes one, and says so when empty.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/settings/account' });

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: StandingRulesSection } = await import('./StandingRulesSection');

const WS = { id: 'aaaa0000-0000-4000-8000-000000000001', name: 'billing-web' };
let directives: any[] = [];
const calls: Array<{ url: string; method: string; body: any }> = [];

let container: HTMLElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  calls.length = 0;
  directives = [
    { id: 'd-2', text: 'Run the billing smoke test first.', workspaceId: WS.id, workspaceName: WS.name, source: 'chat', createdAt: '', updatedAt: '' },
    { id: 'd-1', text: 'Always open PRs as drafts.', workspaceId: null, workspaceName: null, source: 'chat', createdAt: '', updatedAt: '' },
  ];
  (globalThis as any).fetch = async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, method, body });
    if (method === 'GET') return new Response(JSON.stringify({ directives, workspaces: [WS] }), { status: 200 });
    if (method === 'DELETE') directives = directives.filter(d => !url.endsWith(d.id));
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function mount() {
  await act(async () => { root.render(createElement(StandingRulesSection)); });
  await act(async () => { await new Promise(r => setTimeout(r, 0)); });
}
const all = (id: string) => [...container.querySelectorAll(`[data-testid="${id}"]`)] as HTMLElement[];
const q = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const click = async (el: Element | null) => { await act(async () => { (el as HTMLElement).click(); }); await act(async () => { await new Promise(r => setTimeout(r, 0)); }); };
const type = async (el: HTMLTextAreaElement, value: string) => {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
};
const submit = async (form: HTMLElement) => {
  await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  await act(async () => { await new Promise(r => setTimeout(r, 0)); });
};

describe('StandingRulesSection', () => {
  it('lists the rules with their scope', async () => {
    await mount();
    expect(all('standing-rule')).toHaveLength(2);
    expect(all('standing-rule-scope').map(e => e.textContent)).toEqual(['Only billing-web', 'Every chat']);
    expect(q('standing-rules')!.id).toBe('standing-rules');
  });

  it('adds a rule everywhere by default', async () => {
    await mount();
    await click(q('standing-rules-add'));
    await type(q('standing-rule-new-text') as HTMLTextAreaElement, '  Never force-push to dev. ');
    await submit(q('standing-rule-new')!);
    expect(calls.find(c => c.method === 'POST')).toEqual({ url: '/api/chat/directives', method: 'POST', body: { text: 'Never force-push to dev.', workspaceId: null } });
  });

  it('edits a rule and keeps its scope', async () => {
    await mount();
    await click(all('standing-rule-edit-open')[0]);
    await type(q('standing-rule-edit-text') as HTMLTextAreaElement, 'Run the billing smoke test before a PR.');
    await submit(q('standing-rule-edit')!);
    expect(calls.find(c => c.method === 'PATCH')).toEqual({
      url: '/api/chat/directives/d-2', method: 'PATCH', body: { text: 'Run the billing smoke test before a PR.', workspaceId: WS.id },
    });
  });

  it('removes a rule and reloads', async () => {
    await mount();
    await click(all('standing-rule-remove')[1]);
    expect(calls.find(c => c.method === 'DELETE')!.url).toBe('/api/chat/directives/d-1');
    expect(all('standing-rule')).toHaveLength(1);
  });

  it('says rules attached to tasks chat files are visible to people in that workspace', async () => {
    await mount();
    expect(q('standing-rules')!.textContent).toContain('visible to the workspace');
  });

  it('says so when there are none, with the one add control inline', async () => {
    directives = [];
    await mount();
    expect(q('standing-rules-empty')!.textContent).toBe('No rules.');
    expect(all('standing-rules-add')).toHaveLength(1);
    expect(all('standing-rules-add')[0].textContent?.trim()).toBe('Add a rule');
  });

  it('has exactly one add control with rules listed', async () => {
    await mount();
    expect(all('standing-rules-add')).toHaveLength(1);
  });

  it('shows the scope in mono sentence case, no uppercase', async () => {
    await mount();
    expect(container.innerHTML).not.toContain('uppercase');
  });
});
