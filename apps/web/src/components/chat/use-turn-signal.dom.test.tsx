/**
 * useTurnSignal follows the chat's status and messages: a user turn starts on
 * submit, its answer is checked after each commit, and one record goes out
 * after the paint grace. Background and leaving are flagged, never blamed.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/chat/c-1' });

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { TurnSignal } from '@/lib/chat/turn-signal';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { useTurnSignal } = await import('./use-turn-signal');
const { RENDER_GRACE_MS } = await import('./turn-signal-tracker');
import type { ProbeResult, TrackerEnv } from './turn-signal-tracker';

const AID = '0a0a0a0a-0000-4000-8000-000000000001';
type Status = 'ready' | 'submitted' | 'streaming' | 'error';
type Msg = { id: string; role: string; parts: Array<{ type: string; text?: string }> };

let container: HTMLElement;
let root: ReturnType<typeof createRoot>;
let posts: Array<{ ref: string; signal: TurnSignal; beacon: boolean }>;
let probe: ProbeResult;
let hidden: boolean;
let env: TrackerEnv;

function Harness({ id, messages, status }: { id: string | null; messages: Msg[]; status: Status }) {
  useTurnSignal({ conversationId: id, messages, status, env });
  return null;
}

const render = (messages: Msg[], status: Status, id: string | null = 'c-1') => act(async () => { root.render(<Harness id={id} messages={messages} status={status} />); });
const wait = (ms: number) => act(async () => { await new Promise(r => setTimeout(r, ms)); });
const q: Msg = { id: 'client-1', role: 'user', parts: [{ type: 'text', text: 'hi' }] };
const answer: Msg = { id: AID, role: 'assistant', parts: [{ type: 'text', text: 'hello' }] };

beforeEach(() => {
  posts = []; probe = 'not_visible'; hidden = false;
  env = { now: () => Date.now(), probe: () => probe, docHidden: () => hidden, online: () => true, post: (ref, signal, beacon) => posts.push({ ref, signal, beacon }) };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('useTurnSignal', () => {
  it('a rendered turn: one record after the grace, with renderMs and the server\'s assistant id', async () => {
    await render([], 'ready');
    await render([q], 'submitted');
    await render([q, answer], 'streaming');
    probe = 'visible';
    await render([q, { ...answer, parts: [{ type: 'text', text: 'hello there' }] }], 'streaming');
    await render([q, answer], 'ready');
    expect(posts).toEqual([]);
    await wait(RENDER_GRACE_MS + 50);
    expect(posts).toHaveLength(1);
    expect(posts[0].ref).toBe('client-1');
    expect(posts[0].signal).toMatchObject({ assistantId: AID, outcome: 'ready' });
    expect(posts[0].signal.renderMs).toBeDefined();
  });

  it('an answer that never reached the screen: endMs and no renderMs', async () => {
    await render([], 'ready');
    await render([q], 'submitted');
    await render([q, answer], 'streaming');
    await render([q, answer], 'ready');
    await wait(RENDER_GRACE_MS + 50);
    expect(posts[0].signal.renderMs).toBeUndefined();
    expect(posts[0].signal.endMs).toBeDefined();
  });

  it('the tab going to the background mid-turn is flagged', async () => {
    await render([], 'ready');
    await render([q], 'submitted');
    hidden = true;
    document.dispatchEvent(new Event('visibilitychange'));
    await render([q, answer], 'ready');
    await wait(RENDER_GRACE_MS + 50);
    expect(posts[0].signal.hidden).toBe(true);
  });

  it('pagehide sends a beacon at once', async () => {
    await render([], 'ready');
    await render([q], 'submitted');
    window.dispatchEvent(new Event('pagehide'));
    expect(posts).toEqual([{ ref: 'client-1', signal: expect.objectContaining({ pagehide: true }), beacon: true }]);
  });

  it('leaving the conversation mid-turn posts it as left; a new chat without an id tracks nothing', async () => {
    await render([], 'ready');
    await render([q], 'submitted');
    await render([], 'ready', 'c-2');
    expect(posts.map(p => [p.ref, p.signal.left])).toEqual([['client-1', true]]);

    posts = [];
    await render([], 'ready', null);
    await render([q], 'submitted', null);
    await render([q, answer], 'ready', null);
    await wait(RENDER_GRACE_MS + 50);
    expect(posts).toEqual([]);
  });

  it('an approval answer (no new user message) is not a new turn', async () => {
    await render([q, answer], 'ready');
    await render([q, answer], 'submitted');
    await render([q, answer], 'ready');
    await wait(RENDER_GRACE_MS + 50);
    expect(posts).toEqual([]);
  });
});
