/**
 * The Thinking panel's derivations (docs/design/chat-canvas.md, "Thinking"):
 * a streaming turn's tool calls become plain-language steps (never a tool
 * name), and the user's message carries a tiny tag naming where the turn went.
 */
import { describe, expect, it } from 'bun:test';
import { CHAT_READ_TOOLS } from '@buildd/shared';
import type { ChatMessage, ChatPart, ChatToolPart } from './chat-contract';
import { intentTag, stepLabel, thinkingSteps } from './thinking-model';

let seq = 0;
function call(name: string, input: Record<string, unknown> = {}, over: Partial<ChatToolPart> = {}): ChatToolPart {
  seq += 1;
  return { type: `tool-${name}`, toolCallId: `c${seq}`, state: 'output-available', input, output: { data: [] }, ...over };
}
const text = (t: string, streaming = true): ChatPart => ({ type: 'text', text: t, state: streaming ? 'streaming' : 'done' });

describe('stepLabel', () => {
  it('rewords every read tool into a human verb, never its name', () => {
    for (const name of CHAT_READ_TOOLS) {
      for (const state of ['active', 'done'] as const) {
        const label = stepLabel(call(name), state);
        expect(label).not.toContain('_');
        expect(label.toLowerCase()).not.toContain(name.replace(/_/g, ' '));
        expect(label).toMatch(/^[A-Z]/);
      }
    }
  });

  it('reads a multi-op tool by its action', () => {
    expect(stepLabel(call('manage_missions', { action: 'list' }), 'done')).toBe('Looked over the missions');
    expect(stepLabel(call('manage_missions', { action: 'create' }), 'active')).toBe('Drafting a mission');
  });

  it('an unknown tool still reads as plain words', () => {
    expect(stepLabel(call('some_new_tool'), 'active')).toBe('Looking something up');
    expect(stepLabel(call('some_new_tool'), 'done')).toBe('Looked something up');
  });

  it('counts a run of the same call', () => {
    expect(stepLabel(call('get_task'), 'done', 3)).toBe('Read 3 tasks');
    expect(stepLabel(call('get_task'), 'done', 1)).toBe('Read a task');
  });
});

describe('thinkingSteps', () => {
  it('nothing streamed yet: one active step', () => {
    expect(thinkingSteps([])).toEqual([{ key: 'start', label: 'Reading your question', state: 'active' }]);
  });

  it('finished calls are done, the running call is active, and nothing else is', () => {
    const steps = thinkingSteps([call('manage_missions', { action: 'list' }), call('recall', {}, { state: 'input-available' })]);
    expect(steps.map(s => [s.label, s.state])).toEqual([
      ['Looked over the missions', 'done'],
      ['Searching what buildd remembers', 'active'],
    ]);
  });

  it('once calls are done and prose streams, writing the answer is the active step', () => {
    const steps = thinkingSteps([call('get_pr'), text('Most failures happen')]);
    expect(steps.map(s => s.state)).toEqual(['done', 'active']);
    expect(steps[1].label).toBe('Writing the answer');
  });

  it('calls done and no prose yet: still thinking, not idle', () => {
    const steps = thinkingSteps([call('get_pr')]);
    expect(steps.at(-1)).toMatchObject({ label: 'Thinking it through', state: 'active' });
  });

  it('a change waiting on the person is the pending step', () => {
    const steps = thinkingSteps([
      call('list_tasks'),
      call('manage_missions', { action: 'create' }, { state: 'approval-requested', approval: { id: 'a1' } }),
    ]);
    expect(steps.at(-1)).toMatchObject({ label: 'Check it with you', state: 'pending' });
    expect(steps.filter(s => s.state === 'active')).toHaveLength(0);
  });

  it('collapses consecutive identical calls', () => {
    const steps = thinkingSteps([call('get_task'), call('get_task'), call('get_task'), text('ok')]);
    expect(steps[0]).toMatchObject({ label: 'Read 3 tasks', state: 'done' });
    expect(steps).toHaveLength(2);
  });

  it('a failed call says so in plain words', () => {
    const steps = thinkingSteps([call('get_pr', {}, { state: 'output-error', errorText: 'boom' }), text('x')]);
    expect(steps[0]).toMatchObject({ label: "Couldn't check the change", state: 'done' });
  });

  it('never shows more than one active step', () => {
    const steps = thinkingSteps([call('get_task', {}, { state: 'input-available' }), call('get_pr', {}, { state: 'input-available' })]);
    expect(steps.filter(s => s.state === 'active')).toHaveLength(1);
  });
});

describe('intentTag', () => {
  const user = (id: string): ChatMessage => ({ id, role: 'user', parts: [text('hi', false)] });
  const reply = (id: string, scope: unknown): ChatMessage => ({ id, role: 'assistant', metadata: { scope }, parts: [text('ok', false)] });

  it('names the workspace the turn after this message went to', () => {
    const msgs = [user('u1'), reply('a1', { id: 'w1', name: 'billing-web', source: 'routed' })];
    expect(intentTag(msgs, 0)).toEqual({ label: 'routed · billing-web', workspaceId: 'w1' });
  });

  it('a pinned scope reads as pinned', () => {
    const msgs = [user('u1'), reply('a1', { id: 'w1', name: 'billing-web', source: 'pinned' })];
    expect(intentTag(msgs, 0)?.label).toBe('pinned · billing-web');
  });

  it('no reply yet, or an unscoped reply: no tag', () => {
    expect(intentTag([user('u1')], 0)).toBeNull();
    expect(intentTag([user('u1'), reply('a1', null)], 0)).toBeNull();
    expect(intentTag([user('u1'), user('u2'), reply('a1', { id: 'w', name: 'x', source: 'routed' })], 0)).toBeNull();
  });
});
