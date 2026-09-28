/**
 * 0.10.0: rich tool rows (`ToolCallRow`, `ToolCallGroup`, `ChatThread
 * toolRows="rich"`). The first test pins the default thread's tool markup
 * byte for byte (checked against the 0.9.1 component), so apps that never
 * opt in (Cue, moa) render exactly what they did.
 * Runs in its own process (scripts/run-unit-tests.ts), so the DOM globals stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/chat' });

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act, createElement } = await import('react');
const h = createElement as (type: unknown, props?: unknown, ...children: unknown[]) => any;
const { createRoot } = await import('react-dom/client');
const kit = await import('./index');

let container: HTMLElement;
let root: ReturnType<typeof createRoot>;
const render = async (el: unknown) => { await act(async () => { root.render(el as never); }); };
const $ = <T extends Element = HTMLElement>(sel: string, from: ParentNode = container) => from.querySelector<T>(sel as never) as T | null;
const $$ = (sel: string, from: ParentNode = container) => [...from.querySelectorAll<HTMLElement>(sel)];
const click = async (el: Element | null) => { await act(async () => { (el as HTMLElement).click(); }); };

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const tool = (id: string, name: string, over: Record<string, unknown> = {}) => ({
  type: `tool-${name}`, toolCallId: id, state: 'output-available', input: { q: 'x' }, output: { data: [], objects: [], summary: `${id} done` }, ...over,
});

describe('ChatThread default tool rows (unchanged)', () => {
  it('pins the 0.9 markup: one line per call, no rich rows', async () => {
    const messages = [{ id: 'a1', role: 'assistant', parts: [
      tool('r1', 'search_notes'),
      tool('r2', 'list', { state: 'input-available', output: undefined }),
      tool('r3', 'x', { state: 'output-error', errorText: 'boom' }),
      { type: 'text', text: 'Done.' },
    ] }];
    await render(h(kit.ChatThread, { messages, status: 'ready' }));
    expect(container.innerHTML).toBe(
      '<div class="kit-chat kit-thread" role="log" aria-label="Conversation" aria-live="polite" data-testid="kit-thread">'
      + '<div class="kit-msg" data-role="assistant" data-message-id="a1">'
      + '<div><div class="kit-tool" data-state="done" data-tool-call-id="r1"><span aria-hidden="true">✓</span><span>Search notes</span><span class="kit-tool-summary">· r1 done</span></div></div>'
      + '<div><div class="kit-tool" data-state="running" data-tool-call-id="r2"><span aria-hidden="true">·</span><span>List</span></div></div>'
      + '<div><div class="kit-tool" data-state="failed" data-tool-call-id="r3"><span aria-hidden="true">!</span><span>X</span><span class="kit-tool-summary">· boom</span></div></div>'
      + '<div><p class="kit-text">Done.</p></div>'
      + '</div></div>',
    );
    expect($('.kit-toolcall')).toBeNull();
    expect($('[data-testid="tool-call-group"]')).toBeNull();
  });
});

describe('ToolCallRow', () => {
  const view = (over: Record<string, unknown> = {}, opts = {}) => kit.toolCallView(tool('c1', 'manage_items', { input: { action: 'list', owner: 'billing', region: 'eu' }, ...over }) as never, opts);

  it('the tool as the verb, its action, key args, a state mark and the result line', async () => {
    await render(h(kit.ToolCallRow, { view: view() }));
    const row = $('[data-testid="tool-call-row"]')!;
    expect(row.className).toBe('kit-toolcall');
    expect(row.dataset.state).toBe('done');
    expect(row.dataset.tool).toBe('manage_items');
    expect(row.dataset.flush).toBeUndefined();
    expect($('.kit-toolcall-mark')!.getAttribute('aria-label')).toBe('done');
    expect($('.kit-toolcall-name')!.textContent).toBe('manage_items');
    expect($('.kit-toolcall-action')!.textContent).toBe('list');
    expect($('.kit-toolcall-args')!.textContent).toBe('· billing · eu');
    expect($('.kit-toolcall-result')!.textContent).toBe('→ c1 done');
    expect($('[data-testid="tool-call-allowed"]')).toBeNull();
  });

  it('a running call says so and is live; a failed one shows the error', async () => {
    await render(h(kit.ToolCallRow, { view: view({ state: 'input-available', output: undefined }) }));
    expect($('[data-testid="tool-call-row"]')!.dataset.live).toBe('true');
    expect($('.kit-toolcall-result')!.textContent).toBe('→ running…');
    await render(h(kit.ToolCallRow, { view: view({ state: 'output-error', errorText: 'Forbidden\nstack' }) }));
    expect($('[data-testid="tool-call-row"]')!.dataset.live).toBeUndefined();
    expect($('.kit-toolcall-result')!.textContent).toBe('→ Forbidden');
  });

  it('a write that ran under Allow carries the allowed badge', async () => {
    await render(h(kit.ToolCallRow, { view: view({ output: { data: {}, objects: [], summary: 'filed', allowed: true } }) }));
    expect($('[data-testid="tool-call-allowed"]')!.textContent).toBe('allowed');
  });

  it('expands to the raw input and output; a failure shows its error', async () => {
    await render(h(kit.ToolCallRow, { view: view() }));
    const head = $('button.kit-toolcall-head')!;
    expect(head.getAttribute('aria-expanded')).toBe('false');
    expect($('[data-testid="tool-call-raw"]')).toBeNull();
    await click(head);
    expect(head.getAttribute('aria-expanded')).toBe('true');
    const raw = $('[data-testid="tool-call-raw"]')!;
    expect($$('.kit-toolcall-raw-label', raw).map(l => l.textContent)).toEqual(['Input', 'Output']);
    expect($$('pre', raw)[0].textContent).toContain('"owner": "billing"');
    expect($$('pre', raw)[1].textContent).toContain('"summary": "c1 done"');
    await click(head);
    expect($('[data-testid="tool-call-raw"]')).toBeNull();

    await render(h(kit.ToolCallRow, { view: view({ state: 'output-error', errorText: 'Forbidden\nstack' }) }));
    await click($('button.kit-toolcall-head'));
    expect($$('.kit-toolcall-raw-label').map(l => l.textContent)).toEqual(['Input', 'Error']);
    expect($$('pre')[1].textContent).toBe('Forbidden\nstack');
  });

  it('a label replaces the name and action; a note replaces the args', async () => {
    await render(h(kit.ToolCallRow, { view: view(), label: 'New item', note: 'approved by Sam' }));
    expect($('.kit-toolcall-name')!.textContent).toBe('New item');
    expect($('.kit-toolcall-action')).toBeNull();
    expect($('.kit-toolcall-args')).toBeNull();
    expect($('.kit-toolcall-note')!.textContent).toBe('· approved by Sam');
  });

  it('app hooks: a label table and which args are key', async () => {
    await render(h(kit.ToolCallRow, { view: view({}, { toolLabel: () => 'Items', keyArgs: { prefer: ['region'], max: 1 } }) }));
    expect($('.kit-toolcall-name')!.textContent).toBe('Items');
    expect($('.kit-toolcall-args')!.textContent).toBe('· eu');
  });
});

describe('ToolCallGroup', () => {
  it('one call is a bare row, no header', async () => {
    await render(h(kit.ToolCallGroup, { calls: [tool('a', 'search')] }));
    expect($('[data-testid="tool-call-group"]')).toBeNull();
    expect($$('[data-testid="tool-call-row"]')).toHaveLength(1);
    expect($('[data-testid="tool-call-row"]')!.dataset.flush).toBeUndefined();
  });

  it('more get a count header over flush rows, open, and fold', async () => {
    await render(h(kit.ToolCallGroup, { calls: [tool('a', 'search'), tool('b', 'list')], isReadOnly: () => true }));
    const group = $('[data-testid="tool-call-group"]')!;
    expect(group.className).toBe('kit-toolcalls');
    const head = $('button.kit-toolcalls-head', group)!;
    expect(head.textContent).toBe('2 tool calls· read-only›');
    expect(head.getAttribute('aria-expanded')).toBe('true');
    expect($$('[data-testid="tool-call-row"]', group).map(r => [r.dataset.tool, r.dataset.flush])).toEqual([['search', 'true'], ['list', 'true']]);
    await click(head);
    expect(head.getAttribute('aria-expanded')).toBe('false');
    expect(group.dataset.open).toBeUndefined();
    expect($$('[data-testid="tool-call-row"]')).toHaveLength(0);
  });

  it('read-only only when the app says every call is; running beats failed in the tail', async () => {
    await render(h(kit.ToolCallGroup, { calls: [tool('a', 'search'), tool('b', 'x', { state: 'output-error', errorText: 'no' })] }));
    expect($('.kit-toolcalls-head')!.textContent).not.toContain('read-only');
    expect($('.kit-toolcalls-tail')!.textContent).toBe('· 1 failed');
    expect($('.kit-toolcalls-tail')!.dataset.tone).toBe('failed');
    await render(h(kit.ToolCallGroup, { calls: [tool('a', 'search', { state: 'input-available' }), tool('b', 'x', { state: 'output-error' })] }));
    expect($('.kit-toolcalls-tail')!.textContent).toBe('· 1 running');
    expect($('.kit-toolcalls-tail')!.dataset.tone).toBe('running');
  });

  it('no calls, nothing', async () => {
    await render(h(kit.ToolCallGroup, { calls: [] }));
    expect(container.innerHTML).toBe('');
  });
});

describe('ChatThread toolRows="rich"', () => {
  const messages = [
    { id: 'a1', role: 'assistant', parts: [
      { type: 'step-start' },
      tool('r1', 'search', { output: { data: [], objects: [{ kind: 'note', id: 'n1', workspaceId: null, fallbackText: 'Note 1' }], summary: 'one' } }),
      tool('r2', 'list'),
      { type: 'text', text: 'Two things.' },
      tool('r3', 'search'),
      { type: 'tool-file', toolCallId: 'w1', state: 'approval-requested', input: { title: 'x' }, approval: { id: 'ap1' } },
    ] },
  ];

  it('each run of calls is a ToolCallGroup, followed by the objects it returned; approvals stay cards', async () => {
    await render(h(kit.ChatThread, {
      messages, status: 'ready', toolRows: 'rich',
      toolCallOptions: { toolLabel: (n: string) => n.toUpperCase() },
      renderObject: (o: { id: string }) => h('i', { className: 'obj' }, o.id),
    }));
    const a1 = $('[data-message-id="a1"]')!;
    expect([...a1.children].map(c => (c.matches('.kit-card') ? 'card' : $('[data-testid="tool-call-group"]', c) ? 'group' : $('[data-testid="tool-call-row"]', c) ? 'row' : c.textContent))).toEqual(['group', 'Two things.', 'row', 'card']);
    expect($$('.kit-toolcall-name').map(n => n.textContent)).toEqual(['SEARCH', 'LIST', 'SEARCH']);
    expect($$('.obj').map(o => o.textContent)).toEqual(['n1']);
    expect($('.kit-tool')).toBeNull();
  });

  it('an app renderToolGroup still wins', async () => {
    await render(h(kit.ChatThread, { messages, status: 'ready', toolRows: 'rich', renderToolGroup: () => h('p', { className: 'own' }, 'own') }));
    expect($$('.own')).toHaveLength(2);
    expect($('.kit-toolcall')).toBeNull();
  });
});
