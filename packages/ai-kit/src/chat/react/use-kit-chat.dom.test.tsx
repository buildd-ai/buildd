/**
 * End to end: `useKitChat` + `<ChatThread>` + `<ChatComposer>` against the
 * real `createChatTurn` (mock model, in-memory store) over the real SSE wire.
 * A question streams an answer; a write shows one card; Confirm sends the
 * approval back automatically and the write runs once; a refusal lands in
 * `unavailable`.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
// happy-dom replaces the Web Streams / fetch globals with its own classes,
// which Bun's native Response bodies can't pipe through. The SSE wire under
// test is the runtime's, so keep the runtime's classes.
const NATIVE = ['ReadableStream', 'WritableStream', 'TransformStream', 'TextDecoderStream', 'TextEncoderStream', 'Response', 'Request', 'Headers', 'AbortController', 'AbortSignal'] as const;
const native = Object.fromEntries(NATIVE.map(k => [k, (globalThis as Record<string, unknown>)[k]]));
GlobalRegistrator.register({ url: 'http://localhost/chat' });
for (const k of NATIVE) (globalThis as Record<string, unknown>)[k] = native[k];

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act, createElement } = await import('react');
// Props are checked by the components' own types; the fixtures here are loose on purpose.
const h = createElement as (type: unknown, props?: unknown, ...children: unknown[]) => any;
const { createRoot } = await import('react-dom/client');
const { tool } = await import('ai');
const { MockLanguageModelV4, convertArrayToReadableStream } = await import('ai/test');
const { z } = await import('zod');
const kit = await import('./index');
const server = await import('@builddai/ai-kit/chat/server');

const usage = { inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 2, text: 2, reasoning: 0 } };
const finish = (unified: string) => ({ type: 'finish', finishReason: { unified, raw: unified }, usage });
const textStream = (text: string) => ({
  stream: convertArrayToReadableStream([
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: text }, { type: 'text-end', id: 't' },
    finish('stop'),
  ]),
});
const toolStream = (id: string, name: string, input: unknown) => ({
  stream: convertArrayToReadableStream([
    { type: 'stream-start', warnings: [] },
    { type: 'tool-call', toolCallId: id, toolName: name, input: JSON.stringify(input) },
    finish('tool-calls'),
  ]),
});

const groups = server.defineToolGroups({
  notes: { label: 'Notes', modes: ['ask', 'allow'], tools: [{ name: 'create_note', class: 'write' }] },
});

let created: string[];
let container: HTMLElement;
let root: ReturnType<typeof createRoot>;

function makeTurn(responses: unknown[], opts: { key?: string | null } = {}) {
  const model = new MockLanguageModelV4({ doStream: responses as never });
  const plan = { planId: 'p', planSource: 'registry', tier: 'standard', provider: 'openrouter', model: 'm', price: null };
  return server.createChatTurn({
    toolGroups: groups,
    store: server.memoryChatStore(),
    system: 'test',
    model: async () => (opts.key === null
      ? { ok: false as const, reason: 'no_key' as const, message: 'Add your OpenRouter key.' }
      : { ok: true as const, model, plan: plan as never }),
    preview: (_t, input) => ({ ok: true, preview: { v: 1, verb: 'Create note', target: { kind: 'note', id: 'new', label: String(input.title) }, changes: [], fingerprint: 'f' } }),
    tools: {
      create_note: tool({
        description: 'Create a note', inputSchema: z.object({ title: z.string() }),
        execute: async ({ title }: { title: string }) => { created.push(title); return { data: 'ok', objects: [], summary: 'created' }; },
      }),
    },
  });
}

function App({ turn }: { turn: ReturnType<typeof makeTurn> }) {
  const chat = kit.useKitChat({
    api: '/api/chat/c-1',
    id: 'c-1',
    fetch: (async (_url: string, init: RequestInit) => turn.run({ body: JSON.parse(String(init.body)), userId: 'u-1', conversationId: 'c-1' })) as never,
  });
  return h('div', null,
    h(kit.ChatThread, { messages: chat.messages, status: chat.status, onApprovalResponse: chat.respond }),
    chat.unavailable ? h(kit.ChatSetupCard, { reason: chat.unavailable.error, message: chat.unavailable.message }) : null,
    h('span', { 'data-testid': 'status' }, chat.status),
    h('span', { 'data-testid': 'err' }, chat.error ? String(chat.error.stack ?? chat.error.message) : ''),
    h(kit.ChatComposer, { busy: chat.busy, onSend: (t: string) => { void chat.send(t); }, onStop: () => { void chat.stop(); } }),
  );
}

const $ = (sel: string) => container.querySelector<HTMLElement>(sel);
async function waitFor(check: () => boolean, ms = 3000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error(`timed out; DOM: ${container.innerHTML.slice(0, 1500)}`);
    await act(async () => { await new Promise(r => setTimeout(r, 10)); });
  }
}
async function sendText(text: string) {
  const box = container.querySelector<HTMLTextAreaElement>('[data-testid="kit-composer-input"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, text);
    box.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => { box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); });
}

beforeEach(() => {
  created = [];
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('useKitChat steering', () => {
  it('a steer the turn ended before applying is sent as the next message', async () => {
    const queue = server.memorySteerQueue();
    let calls = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        calls++;
        if (calls === 1) queue.push('c-1', { id: 's1', text: 'and thanks', userId: 'u-1', at: '' });
        return textStream(calls === 1 ? 'Done.' : 'You are welcome.');
      },
    } as never);
    const turn = server.createChatTurn({
      toolGroups: groups, store: server.memoryChatStore(), system: 'test', tools: {}, steering: { queue },
      model: async () => ({ ok: true as const, model, plan: { planId: 'p', planSource: 'registry', tier: 'standard', provider: 'openrouter', model: 'm' } as never }),
    });
    function SteerApp() {
      const chat = kit.useKitChat({
        api: '/api/chat/c-1', id: 'c-1', steer: { api: '/api/chat/c-1/steer' },
        fetch: (async (_url: string, init: RequestInit) => turn.run({ body: JSON.parse(String(init.body)), userId: 'u-1', conversationId: 'c-1' })) as never,
      });
      return h('div', null, h(kit.ChatThread, { messages: chat.messages, status: chat.status }), h('span', { 'data-testid': 'status' }, chat.status),
        h(kit.ChatComposer, { busy: chat.busy, onSend: (t: string) => { void chat.send(t); } }));
    }
    await act(async () => { root.render(h(SteerApp)); });
    await sendText('hi');
    await waitFor(() => !!container.textContent?.includes('You are welcome.') && $('[data-testid="status"]')!.textContent === 'ready');
    const users = [...container.querySelectorAll('[data-role="user"]')].map(e => e.textContent);
    expect(users).toEqual(['hi', 'and thanks']);
    expect(calls).toBe(2);
  });
});

describe('useKitChat end to end', () => {
  it('streams an answer', async () => {
    await act(async () => { root.render(h(App, { turn: makeTurn([textStream('Hello there.')]) })); });
    await sendText('hi');
    await waitFor(() => !!$('[data-role="assistant"]')?.textContent?.includes('Hello there.') && $('[data-testid="status"]')!.textContent === 'ready');
    expect($('[data-role="user"]')!.textContent).toBe('hi');
  });

  it('a write shows one card; Confirm sends the answer back and the write runs once', async () => {
    await act(async () => { root.render(h(App, { turn: makeTurn([toolStream('w1', 'create_note', { title: 'Milk' }), textStream('Added.')]) })); });
    await sendText('add milk');
    await waitFor(() => !!$('[data-testid="kit-approval"][data-state="awaiting"]') && $('[data-testid="status"]')!.textContent === 'ready');
    expect($('.kit-card-title')!.textContent).toBe('Create note: Milk');
    expect(created).toEqual([]);
    await act(async () => { $('[data-testid="kit-approval-confirm"]')!.click(); });
    await waitFor(() => created.length === 1 && !!container.textContent?.includes('Added.') && $('[data-testid="status"]')!.textContent === 'ready');
    expect(created).toEqual(['Milk']);
    expect($('[data-testid="kit-approval"]')!.getAttribute('data-state')).toBe('done');
  });

  it('a refusal (409 no_key) lands in unavailable for the setup card', async () => {
    await act(async () => { root.render(h(App, { turn: makeTurn([], { key: null }) })); });
    await sendText('hi');
    await waitFor(() => !!$('[data-testid="kit-setup"]'));
    expect($('[data-testid="kit-setup"]')!.textContent).toContain('Add your OpenRouter key.');
  });
});
