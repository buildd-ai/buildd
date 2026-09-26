import { describe, expect, it } from 'bun:test';
import type { BuilddObjectRef, ChatMessage, ChatToolPart } from './chat-contract';
import { objectsOf } from './chat-contract';
import {
  conversationRefs, feedSegments, keyArgs, paneFocus, provisionalTitle, toolGroupSummary,
  toolResultLine, toolRowState, toolRowView,
} from './feed-model';

const ref = (kind: BuilddObjectRef['kind'], id: string): BuilddObjectRef => ({ kind, id, workspaceId: 'ws-1', fallbackText: `${kind} ${id}` });
const tool = (name: string, over: Partial<ChatToolPart> = {}): ChatToolPart => ({
  type: `tool-${name}`, toolCallId: `call-${name}-${Math.random().toString(36).slice(2, 7)}`, state: 'output-available',
  input: {}, output: { data: [], objects: [] }, ...over,
});
const msg = (parts: ChatMessage['parts'], role: ChatMessage['role'] = 'assistant'): ChatMessage => ({ id: Math.random().toString(36), role, parts });

describe('tool rows', () => {
  it('maps every v7 tool state to a row state', () => {
    expect(toolRowState(tool('x', { state: 'input-streaming' }))).toBe('running');
    expect(toolRowState(tool('x', { state: 'input-available' }))).toBe('running');
    expect(toolRowState(tool('x', { state: 'approval-requested', approval: { id: 'a' } }))).toBe('awaiting');
    expect(toolRowState(tool('x', { state: 'approval-responded', approval: { id: 'a', approved: true } }))).toBe('approved');
    expect(toolRowState(tool('x', { state: 'approval-responded', approval: { id: 'a', approved: false } }))).toBe('denied');
    expect(toolRowState(tool('x', { state: 'output-error', errorText: 'boom' }))).toBe('failed');
    expect(toolRowState(tool('x', { state: 'output-denied', approval: { id: 'a', approved: false } }))).toBe('denied');
  });

  it('names the verb from the tool and its action, and keeps the args a reader wants', () => {
    const v = toolRowView(tool('manage_missions', {
      input: { action: 'list', workspaceId: '5f0c7a51-2b9e-4c1e-9d55-0c3a4b1d2e3f', workspace: 'billing-web', limit: 20 },
    }));
    expect(v.name).toBe('manage_missions');
    expect(v.action).toBe('list');
    expect(v.args).toEqual(['billing-web']);
    expect(v.readOnly).toBe(true);
  });

  it('drops uuids and paging args, truncates long values, caps at two', () => {
    expect(keyArgs({ id: '5f0c7a51-2b9e-4c1e-9d55-0c3a4b1d2e3f', limit: 5 })).toEqual([]);
    expect(keyArgs({ title: 'x'.repeat(80) })[0]).toHaveLength(40);
    expect(keyArgs({ a: 'one', b: 'two', c: 'three' })).toHaveLength(2);
  });

  it('write actions are not read-only', () => {
    expect(toolRowView(tool('manage_missions', { input: { action: 'create' } })).readOnly).toBe(false);
    expect(toolRowView(tool('create_task')).readOnly).toBe(false);
    expect(toolRowView(tool('get_task')).readOnly).toBe(true);
  });

  it('the result line prefers the tool summary, then the object, then a count', () => {
    expect(toolResultLine(tool('get_task', { output: { summary: '#413 merged, CI green\nmore', objects: [] } }))).toBe('#413 merged, CI green');
    expect(toolResultLine(tool('get_task', { output: { data: {}, objects: [ref('task', 't1')] } }))).toBe('task t1');
    expect(toolResultLine(tool('list_tasks', { output: { data: [1, 2, 3], objects: [] } }))).toBe('3 results');
    expect(toolResultLine(tool('list_tasks', { output: { data: [], objects: [] } }))).toBe('none');
    expect(toolResultLine(tool('x', { state: 'output-error', errorText: 'Forbidden\nstack' }))).toBe('Forbidden');
    expect(toolResultLine(tool('x', { state: 'input-available' }))).toBeNull();
  });

  it('only a finished call contributes objects, and malformed refs are dropped', () => {
    expect(objectsOf(tool('x', { state: 'input-available', output: { objects: [ref('task', 't')] } }))).toEqual([]);
    expect(objectsOf(tool('x', { output: { objects: [ref('task', 't'), { kind: 'nope', id: 'z' }, null] } }))).toEqual([ref('task', 't')]);
  });
});

describe('feedSegments', () => {
  it('groups consecutive calls across step-start parts and renders their objects after the group', () => {
    const segs = feedSegments([
      { type: 'step-start' },
      tool('list_tasks'),
      { type: 'step-start' },
      tool('get_task', { output: { data: {}, objects: [ref('task', 't1')] } }),
      { type: 'text', text: 'Three are in.' },
    ]);
    expect(segs.map(s => s.kind)).toEqual(['tools', 'objects', 'text']);
    const tools = segs[0];
    expect(tools.kind === 'tools' && tools.calls).toHaveLength(2);
  });

  it('an approval part breaks a group and renders as its own card', () => {
    const segs = feedSegments([
      tool('manage_missions', { input: { action: 'list' } }),
      { type: 'text', text: 'Here is a draft.' },
      tool('manage_missions', { state: 'approval-requested', input: { action: 'create', title: 'M' }, approval: { id: 'ap-1' } }),
    ]);
    expect(segs.map(s => s.kind)).toEqual(['tools', 'text', 'approval']);
  });

  it('a confirmed approval that filed something is followed by the live object', () => {
    const segs = feedSegments([
      tool('manage_missions', {
        state: 'output-available', input: { action: 'create' }, approval: { id: 'ap-1', approved: true },
        output: { data: {}, objects: [ref('mission', 'm1')] },
      }),
    ]);
    expect(segs.map(s => s.kind)).toEqual(['approval', 'objects']);
  });

  it('shows each object once per message even when two calls return it', () => {
    const segs = feedSegments([
      tool('get_task', { output: { objects: [ref('task', 't1')] } }),
      tool('get_task', { output: { objects: [ref('task', 't1')] } }),
    ]);
    const objs = segs.filter(s => s.kind === 'objects');
    expect(objs).toHaveLength(1);
  });

  it('skips empty text and flags streaming text', () => {
    const segs = feedSegments([{ type: 'text', text: '  ' }, { type: 'text', text: 'Hel', state: 'streaming' }]);
    expect(segs).toEqual([{ kind: 'text', key: 'text-1', text: 'Hel', streaming: true }]);
  });

  it('summarises a group', () => {
    expect(toolGroupSummary([tool('list_tasks'), tool('get_task', { state: 'input-available' })]))
      .toEqual({ count: 2, readOnly: true, running: 1, failed: 0 });
  });
});

describe('pane focus', () => {
  const withRefs = (...refs: BuilddObjectRef[]) => msg([tool('x', { output: { objects: refs } })]);

  it('follows the most recently referenced object', () => {
    expect(paneFocus([withRefs(ref('task', 't1')), withRefs(ref('mission', 'm1'))], null)).toEqual(ref('mission', 'm1'));
  });

  it('a pinned object wins', () => {
    expect(paneFocus([withRefs(ref('mission', 'm1'))], ref('task', 't9'))).toEqual(ref('task', 't9'));
  });

  it('a question keeps the pane on its mission when the mission is in the conversation', () => {
    expect(paneFocus([withRefs(ref('mission', 'm1')), withRefs(ref('question', 'q1'))], null)).toEqual(ref('mission', 'm1'));
    expect(paneFocus([withRefs(ref('question', 'q1'))], null)).toEqual(ref('question', 'q1'));
  });

  it('nothing referenced: no pane', () => {
    expect(paneFocus([msg([{ type: 'text', text: 'hi' }])], null)).toBeNull();
  });

  it('re-mentioning an object moves it to the end', () => {
    const refs = conversationRefs([withRefs(ref('task', 'a')), withRefs(ref('task', 'b')), withRefs(ref('task', 'a'))]);
    expect(refs.map(r => r.id)).toEqual(['b', 'a']);
  });
});

describe('provisionalTitle', () => {
  it('uses the first user message, trimmed', () => {
    expect(provisionalTitle([msg([{ type: 'text', text: '  what shipped\ntoday? ' }], 'user')])).toBe('what shipped today?');
    expect(provisionalTitle([])).toBe('New chat');
  });
});
