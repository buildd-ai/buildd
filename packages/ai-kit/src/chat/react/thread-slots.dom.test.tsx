/**
 * 0.9.0: the thread and composer slots an app with its own feed needs
 * (buildd's): a header and footer per message, tool calls drawn as one group,
 * the app's own checklist and thinking title, its own event part type, the
 * text part in `renderText`, and the composer's input id. All optional: the
 * first test pins the default thread for an app that passes none of them.
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
const $ = <T extends Element = HTMLElement>(sel: string) => container.querySelector<T>(sel as never) as T | null;
const $$ = (sel: string) => [...container.querySelectorAll<HTMLElement>(sel)];
const kids = (el: Element | null) => [...(el?.children ?? [])].map(c => `${c.tagName.toLowerCase()}${c.className ? `.${String(c.className).split(' ').join('.')}` : ''}`);

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const tool = (id: string, name = 'search', over: Record<string, unknown> = {}) => ({
  type: `tool-${name}`, toolCallId: id, state: 'output-available', input: {}, output: { data: [], objects: [], summary: `${id} done` }, ...over,
});
const messages = [
  { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'What is running?' }] },
  {
    id: 'a1', role: 'assistant', parts: [
      { type: 'step-start' },
      tool('r1'),
      { type: 'step-start' },
      tool('r2', 'list'),
      { type: 'text', text: 'Two things.' },
      tool('r3'),
      { type: 'tool-file', toolCallId: 'w1', state: 'approval-requested', input: { title: 'x' }, approval: { id: 'ap1' } },
      tool('r4'),
    ],
  },
  { id: 'e1', role: 'event', parts: [{ type: 'data-app-event', data: { event: 'ping', text: 'Mission done' } }] },
];

describe('ChatThread defaults (0.9.0)', () => {
  it('unchanged without the new props: one row per call, the kit card, no head or foot, app event types ignored', async () => {
    await render(h(kit.ChatThread, { messages, status: 'ready' }));
    const a1 = $('[data-message-id="a1"]')!;
    expect(kids(a1)).toEqual(['div', 'div', 'div', 'div', 'section.kit-card', 'div']);
    expect($$('.kit-tool').map(t => t.dataset.toolCallId)).toEqual(['r1', 'r2', 'r3', 'r4']);
    expect($('.kit-msg-head')).toBeNull();
    expect($('.kit-msg-foot')).toBeNull();
    // `data-app-event` is not the kit's event part: no row.
    expect($('[data-message-id="e1"]')).toBeNull();
  });
});

describe('ChatThread slots (0.9.0)', () => {
  it('renderToolGroup gets each run of consecutive calls; text and approvals end a run, step-start does not', async () => {
    const runs: string[][] = [];
    await render(h(kit.ChatThread, {
      messages, status: 'ready',
      renderToolGroup: (parts: Array<{ toolCallId: string }>) => { runs.push(parts.map(p => p.toolCallId)); return h('p', { className: 'group' }, parts.map(p => p.toolCallId).join('+')); },
    }));
    expect(runs).toEqual([['r1', 'r2'], ['r3'], ['r4']]);
    expect($$('.group').map(g => g.textContent)).toEqual(['r1+r2', 'r3', 'r4']);
    expect($('.kit-tool')).toBeNull();
    // Reading order: group, text, group, card, group.
    const a1 = $('[data-message-id="a1"]')!;
    expect([...a1.children].map(c => c.querySelector('.group')?.textContent ?? (c.matches('.kit-card') ? 'card' : c.textContent))).toEqual(['r1+r2', 'Two things.', 'r3', 'card', 'r4']);
  });

  it('a group drawn as null leaves no frame', async () => {
    await render(h(kit.ChatThread, { messages, status: 'ready', renderToolGroup: () => null }));
    expect(kids($('[data-message-id="a1"]'))).toEqual(['div', 'section.kit-card']);
  });

  it('renderTool still wins over the group and ends the run', async () => {
    await render(h(kit.ChatThread, {
      messages, status: 'ready',
      renderTool: (p: { toolCallId: string }) => (p.toolCallId === 'r2' ? h('i', { className: 'own' }, 'own r2') : undefined),
      renderToolGroup: (parts: Array<{ toolCallId: string }>) => h('p', { className: 'group' }, parts.map(p => p.toolCallId).join('+')),
    }));
    expect($$('.group').map(g => g.textContent)).toEqual(['r1', 'r3', 'r4']);
    expect($('.own')!.textContent).toBe('own r2');
  });

  it('header and footer per message, with its index and whether it streams', async () => {
    const seen: Array<[string, number, boolean]> = [];
    await render(h(kit.ChatThread, {
      messages: messages.slice(0, 2), status: 'streaming',
      renderMessageHeader: (m: { id: string }, ctx: { index: number; streaming: boolean }) => { seen.push([m.id, ctx.index, ctx.streaming]); return h('b', null, `head ${m.id}`); },
      renderMessageFooter: (m: { id: string; role: string }) => (m.role === 'assistant' ? null : h('i', null, `foot ${m.id}`)),
    }));
    expect(seen).toEqual([['u1', 0, false], ['a1', 1, true]]);
    const u1 = $('[data-message-id="u1"]')!;
    expect(kids(u1)[0]).toBe('div.kit-msg-head');
    expect(u1.lastElementChild!.className).toBe('kit-msg-foot');
    // A null footer renders no wrapper.
    expect($('[data-message-id="a1"] .kit-msg-foot')).toBeNull();
  });

  it('steps and thinkingName replace the checklist, also while the first chunk is awaited', async () => {
    const calls: Array<[string, boolean]> = [];
    const steps = (m: { id: string; parts: unknown[] }, streaming: boolean) => {
      calls.push([m.id, streaming]);
      return streaming ? [{ id: 's1', label: `Reading ${m.parts.length} parts`, state: 'active' as const }] : [];
    };
    await render(h(kit.ChatThread, { messages: messages.slice(0, 1), status: 'submitted', steps, thinkingName: 'buildd is working' }));
    expect(calls).toEqual([['kit-pending', true]]);
    const line = $('[data-testid="kit-thread"] > .kit-msg:last-child [data-testid="kit-thinking-live"]')!;
    expect(line.textContent).toContain('Reading 0 parts');
    expect(line.getAttribute('aria-label')).toBe('buildd is working: Reading 0 parts');
    // No header line any more.
    expect($('[data-testid="kit-thread"] > .kit-msg:last-child summary')).toBeNull();
    calls.length = 0;
    await render(h(kit.ChatThread, { messages: messages.slice(0, 2), status: 'ready', steps }));
    // Not streaming: the app returns none, so there is no panel at all.
    expect(calls).toEqual([['a1', false]]);
    expect($('[data-testid="kit-thinking"]')).toBeNull();
  });

  it('eventPartType: an app event part reaches renderEvent as is, with a header', async () => {
    await render(h(kit.ChatThread, {
      messages, status: 'ready', eventPartType: 'data-app-event',
      renderEvent: (d: { event: string; text: string }) => h('p', { className: 'ev' }, `${d.event}: ${d.text}`),
      renderMessageHeader: (m: { role: string }) => (m.role === 'event' ? h('b', null, 'buildd') : null),
    }));
    const e1 = $('[data-message-id="e1"]')!;
    expect(e1.dataset.role).toBe('event');
    expect(kids(e1)).toEqual(['div.kit-msg-head', 'p.ev']);
    expect(e1.querySelector('.ev')!.textContent).toBe('ping: Mission done');
  });

  it('renderText gets the text part (its streaming state)', async () => {
    const states: Array<string | undefined> = [];
    await render(h(kit.ChatThread, {
      messages: [{ id: 'a', role: 'assistant', parts: [{ type: 'text', text: 'Hel', state: 'streaming' }] }], status: 'streaming',
      renderText: (t: string, _m: unknown, p: { state?: string }) => { states.push(p.state); return t; },
    }));
    expect(states).toEqual(['streaming']);
  });
});

describe('ChatComposer inputId (0.9.0)', () => {
  it('names the box and its label; default is generated', async () => {
    await render(h(kit.ChatComposer, { onSend() {}, inputId: 'app-composer' }));
    const box = $('[data-testid="kit-composer-input"]')!;
    expect(box.id).toBe('app-composer');
    expect($('label')!.getAttribute('for')).toBe('app-composer');
    await render(h(kit.ChatComposer, { onSend() {} }));
    expect($('[data-testid="kit-composer-input"]')!.id).not.toBe('app-composer');
    expect($('[data-testid="kit-composer-input"]')!.id.length).toBeGreaterThan(0);
  });
});

describe('ChatThread turnFold (0.13.0)', () => {
  const withSteps = [
    { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Go' }] },
    { id: 'a1', role: 'assistant', parts: [
      { type: 'data-step', id: 's1', data: { id: 's1', label: 'Looked', state: 'done' } },
      tool('r1'), tool('r2', 'list'),
      { type: 'tool-file', toolCallId: 'w1', state: 'output-available', input: {}, output: {}, approval: { id: 'ap1', approved: true } },
      { type: 'text', text: 'Answer.' },
    ] },
  ];
  const fold = (open: Set<string>, toggles: Array<[string, boolean]> = []) => ({
    summary: (_m: unknown, steps: readonly unknown[]) => `Did ${steps.length} step`,
    isOpen: (m: { id: string }) => open.has(m.id),
    onToggle: (m: { id: string }, o: boolean) => { toggles.push([m.id, o]); },
  });

  it('a finished turn folds its steps and tool rows under the line; text and approvals stay', async () => {
    await render(h(kit.ChatThread, { messages: withSteps, status: 'ready', toolRows: 'rich', turnFold: fold(new Set()) }));
    const d = $<HTMLDetailsElement>('[data-testid="kit-thinking"]')!;
    expect(d.dataset.settled).toBe('true');
    expect(d.open).toBe(false);
    expect($('[data-testid="kit-thinking-summary"]')?.textContent).toBe('Did 1 step');
    expect($$('[data-testid="tool-call-row"]')).toHaveLength(0);
    expect($('[data-testid="kit-approval"]')).not.toBeNull();
    expect($('.kit-msg[data-role="assistant"]')?.textContent).toContain('Answer.');
    expect($('.kit-msg[data-role="assistant"]')?.dataset.folded).toBe('true');
  });

  it('open, the rows draw in place; a toggle reports back', async () => {
    const toggles: Array<[string, boolean]> = [];
    await render(h(kit.ChatThread, { messages: withSteps, status: 'ready', toolRows: 'rich', turnFold: fold(new Set(['a1']), toggles) }));
    expect($$('[data-testid="tool-call-row"]').length).toBeGreaterThan(0);
    const d = $<HTMLDetailsElement>('[data-testid="kit-thinking"]')!;
    expect(d.open).toBe(true);
    // happy-dom fires `toggle` itself when `open` flips, as a browser does.
    await act(async () => { d.open = false; });
    expect(toggles).toEqual([['a1', false]]);
  });

  it('while streaming the turn is the live panel, never folded', async () => {
    await render(h(kit.ChatThread, { messages: withSteps, status: 'streaming', toolRows: 'rich', turnFold: fold(new Set()) }));
    const d = $<HTMLDetailsElement>('[data-testid="kit-thinking"]')!;
    expect(d.dataset.streaming).toBe('true');
    expect(d.dataset.settled).toBeUndefined();
    expect($$('[data-testid="tool-call-row"]').length).toBeGreaterThan(0);
  });

  it('a null summary leaves the turn as it was', async () => {
    await render(h(kit.ChatThread, { messages: withSteps, status: 'ready', toolRows: 'rich', turnFold: { ...fold(new Set()), summary: () => null } }));
    expect($$('[data-testid="tool-call-row"]').length).toBeGreaterThan(0);
  });
});
