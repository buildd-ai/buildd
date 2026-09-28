import { describe, expect, it } from 'bun:test';
import type { BuilddObjectRef, ChatMessage, ChatToolPart } from './chat-contract';
import { objectsOf } from './chat-contract';
import {
  canvasPin, conversationRefs, feedSegments, keyArgs, paneFocus, provisionalTitle, toolGroupSummary,
  routedScope, toolResultLine, toolRowState, toolRowView,
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
    // Answer first: a read's objects follow the reply, not the tool rows.
    expect(segs.map(s => s.kind)).toEqual(['tools', 'text', 'objects']);
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

  it('a list read shows cards only for what the answer names; the rest stay in the tool row', () => {
    const T1 = '514a1539-0000-4000-8000-000000000001';
    const titled = (kind: BuilddObjectRef['kind'], id: string, title: string): BuilddObjectRef => ({ ...ref(kind, id), title });
    const segs = feedSegments([
      tool('list_tasks', { output: { objects: [titled('task', T1, 'Delta review includes inherited dev changes'), ref('task', 'q1'), ref('task', 'q2')] } }),
      tool('manage_missions', { input: { action: 'list' }, output: { objects: [
        titled('mission', 'm-kit', 'Shared AI kit'), titled('mission', 'm-done', 'Deep UI pass for the web app'),
      ] } }),
      { type: 'text', text: 'Running: task 514a1539. The Shared AI kit mission is held.' },
    ]);
    const shown = segs.filter(s => s.kind === 'objects').flatMap(s => (s.kind === 'objects' ? s.refs.map(r => r.id) : []));
    expect(shown).toEqual([T1, 'm-kit']);
    const more = segs.find(s => s.kind === 'more');
    expect(more?.kind === 'more' && more.refs.map(r => r.id)).toEqual(['q1', 'q2', 'm-done']);
    expect(segs.map(s => s.kind)).toEqual(['tools', 'text', 'objects', 'more']);
  });

  it('PRs a list returned stay shown: they stack as one compact list', () => {
    const segs = feedSegments([
      tool('list_tasks', { output: { objects: [ref('pr', 'p1'), ref('pr', 'p2'), ref('task', 'q1')] } }),
      { type: 'text', text: 'Two PRs merged today.' },
    ]);
    expect(segs.map(s => s.kind)).toEqual(['tools', 'text', 'objects', 'more']);
    expect(segs[2].kind === 'objects' && segs[2].refs.map(r => r.id)).toEqual(['p1', 'p2']);
  });

  it('an object fetched on its own is shown even when the answer does not name it', () => {
    const segs = feedSegments([
      tool('list_tasks', { output: { objects: [ref('task', 'q1'), ref('task', 'q2')] } }),
      tool('get_task', { output: { objects: [ref('task', 't9')] } }),
      { type: 'text', text: 'One is running.' },
    ]);
    expect(segs.map(s => s.kind)).toEqual(['tools', 'text', 'objects', 'more']);
    expect(segs[2].kind === 'objects' && segs[2].refs.map(r => r.id)).toEqual(['t9']);
  });

  it('a list with nothing named renders no cards, only the collapsed row', () => {
    const segs = feedSegments([
      tool('list_tasks', { output: { objects: [ref('task', 'q1'), ref('task', 'q2')] } }),
      { type: 'text', text: 'Nothing is running.' },
    ]);
    expect(segs.map(s => s.kind)).toEqual(['tools', 'text', 'more']);
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

describe('routedScope', () => {
  const a = (scope: unknown) => ({ id: 'a', role: 'assistant' as const, parts: [], metadata: { scope } });
  const u = { id: 'u', role: 'user' as const, parts: [] };
  it('the latest assistant turn\'s routed workspace', () => {
    expect(routedScope([a({ id: 'w1', name: 'billing-web', source: 'routed' }), u])).toEqual({ id: 'w1', name: 'billing-web' });
  });
  it('pinned, unscoped or no assistant turn: none', () => {
    expect(routedScope([a({ id: 'w1', name: 'x', source: 'pinned' })])).toBeNull();
    expect(routedScope([a(null)])).toBeNull();
    expect(routedScope([u])).toBeNull();
  });
  it('only the latest turn counts', () => {
    expect(routedScope([a({ id: 'w1', name: 'x', source: 'routed' }), a(null)])).toBeNull();
  });
});

describe('canvas pin', () => {
  const withRefs = (...refs: BuilddObjectRef[]) => msg([tool('x', { output: { objects: refs } })]);

  it("a list read's unnamed tail doesn't pin: the object the answer is about does", () => {
    const m = msg([
      tool('manage_missions', { input: { action: 'list' }, output: { objects: [ref('mission', 'm-kit'), ref('mission', 'm-done')] } }),
      tool('get_task', { output: { objects: [ref('task', 't1')] } }),
      { type: 'text', text: 'One task is running; mission m-kit is held.' },
    ]);
    expect(canvasPin([m], null)).toEqual(ref('mission', 'm-kit'));
    expect(paneFocus([m], null)).toEqual(ref('task', 't1'));
    expect(conversationRefs([m]).map(r => r.id)).not.toContain('m-done');
  });

  it('the object the chat was opened about wins', () => {
    expect(canvasPin([withRefs(ref('mission', 'm1'))], ref('task', 't9'))).toEqual(ref('task', 't9'));
  });

  it('otherwise the latest mission in the conversation, then the latest task', () => {
    expect(canvasPin([withRefs(ref('mission', 'm1')), withRefs(ref('task', 't1'))], null)).toEqual(ref('mission', 'm1'));
    expect(canvasPin([withRefs(ref('task', 't1'), ref('pr', 'p1'))], null)).toEqual(ref('task', 't1'));
  });

  it('PRs and questions alone pin nothing', () => {
    expect(canvasPin([withRefs(ref('pr', 'p1'), ref('question', 'q1'))], null)).toBeNull();
    expect(canvasPin([], null)).toBeNull();
  });
});
