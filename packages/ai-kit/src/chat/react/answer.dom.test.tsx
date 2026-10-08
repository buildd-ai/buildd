/**
 * 0.18.0: `ChatThread answer="replace"`. A turn draws one answer region: its
 * latest prose, updated in place while the turn streams and left as the final
 * answer once it settles. Earlier prose stays in the parts, not on screen.
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
const $$ = (sel: string) => [...container.querySelectorAll<HTMLElement>(sel)];

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const EARLY = 'A fix is already queued. Let me check why it has not been claimed.';
const FINAL = 'I checked the queue: the fix was never queued. The task is held on a question nobody answered.';
const tool = (id: string, over: Record<string, unknown> = {}) => ({ type: 'tool-search', toolCallId: id, state: 'output-available', input: {}, output: { summary: `${id} done` }, ...over });
const user = { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Why is the fix not claimed?' }] };
const turn = (parts: unknown[]) => [user, { id: 'a1', role: 'assistant', parts }];

const early = turn([{ type: 'step-start' }, { type: 'text', text: EARLY, state: 'done' }, tool('t1', { state: 'input-available', output: undefined })]);
const later = turn([{ type: 'step-start' }, { type: 'text', text: EARLY, state: 'done' }, tool('t1'), { type: 'step-start' }, { type: 'text', text: FINAL, state: 'streaming' }]);
const done = turn([{ type: 'step-start' }, { type: 'text', text: EARLY, state: 'done' }, tool('t1'), { type: 'step-start' }, { type: 'text', text: FINAL, state: 'done' }]);

const answers = () => $$('.kit-msg[data-role="assistant"] [data-testid="kit-answer"]');

describe('ChatThread answer="replace" (0.18.0)', () => {
  it('shows the early prose while the turn works, in the answer region, marked live and busy', async () => {
    await render(h(kit.ChatThread, { messages: early, status: 'streaming', answer: 'replace' }));
    expect(answers()).toHaveLength(1);
    expect(answers()[0].textContent).toBe(EARLY);
    expect(answers()[0].getAttribute('data-answer')).toBe('live');
    expect(answers()[0].getAttribute('aria-busy')).toBe('true');
  });

  it('the final prose replaces the early prose in the same region: same node, no second answer', async () => {
    await render(h(kit.ChatThread, { messages: early, status: 'streaming', answer: 'replace' }));
    const node = answers()[0];
    await render(h(kit.ChatThread, { messages: later, status: 'streaming', answer: 'replace' }));
    expect(answers()).toHaveLength(1);
    expect(answers()[0]).toBe(node);
    expect(answers()[0].textContent).toBe(FINAL);
    await render(h(kit.ChatThread, { messages: done, status: 'ready', answer: 'replace' }));
    expect(answers()).toHaveLength(1);
    expect(answers()[0]).toBe(node);
    expect(answers()[0].getAttribute('data-answer')).toBe('settled');
    expect(answers()[0].hasAttribute('aria-busy')).toBe(false);
    expect(container.textContent).not.toContain(EARLY);
  });

  it('a settled turn on load draws only the final answer', async () => {
    await render(h(kit.ChatThread, { messages: done, status: 'ready', answer: 'replace' }));
    expect(answers().map(a => a.textContent)).toEqual([FINAL]);
    expect(container.textContent).not.toContain(EARLY);
  });

  it('superseded prose does not split a run of tool calls', async () => {
    const parts = [{ type: 'text', text: EARLY }, tool('t1'), { type: 'text', text: 'Interim: still looking at the queue.' }, tool('t2'), { type: 'text', text: FINAL }];
    const groups: string[][] = [];
    await render(h(kit.ChatThread, {
      messages: turn(parts), status: 'ready', answer: 'replace',
      renderToolGroup: (ps: Array<{ toolCallId: string }>) => { groups.push(ps.map(p => p.toolCallId)); return h('div', null, 'calls'); },
    }));
    expect(groups.at(-1)).toEqual(['t1', 't2']);
  });

  it('user messages and the default mode keep every text part', async () => {
    await render(h(kit.ChatThread, { messages: done, status: 'ready' }));
    expect(answers()).toHaveLength(0);
    expect(container.textContent).toContain(EARLY);
    expect(container.textContent).toContain(FINAL);
    await render(h(kit.ChatThread, { messages: done, status: 'ready', answer: 'replace' }));
    expect(container.textContent).toContain('Why is the fix not claimed?');
  });

  it('an approval continuation settles on the prose after the decision; the card stays', async () => {
    const asked = turn([{ type: 'text', text: 'I can file the fix. Approve it below.' }, { type: 'tool-file', toolCallId: 'w1', state: 'approval-requested', input: { title: 'fix' }, approval: { id: 'ap1' } }]);
    await render(h(kit.ChatThread, { messages: asked, status: 'ready', answer: 'replace', onApprovalResponse: () => {} }));
    expect(answers().map(a => a.textContent)).toEqual(['I can file the fix. Approve it below.']);
    const node = answers()[0];
    const resumed = turn([
      { type: 'text', text: 'I can file the fix. Approve it below.' },
      { type: 'tool-file', toolCallId: 'w1', state: 'output-available', input: { title: 'fix' }, output: {}, approval: { id: 'ap1', approved: true } },
      { type: 'step-start' },
      { type: 'text', text: 'Filed the fix; a builder can claim it now.' },
    ]);
    await render(h(kit.ChatThread, { messages: resumed, status: 'ready', answer: 'replace', onApprovalResponse: () => {} }));
    expect(answers().map(a => a.textContent)).toEqual(['Filed the fix; a builder can claim it now.']);
    expect(answers()[0]).toBe(node);
    expect($$('.kit-approval, [data-approval-id], .kit-card').length).toBeGreaterThan(0);
  });
});
