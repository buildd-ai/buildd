import { describe, expect, it } from 'bun:test';
import type { BuilddObjectRef, ChatMessage, ChatToolPart } from './chat-contract';
import { objectsOf } from './chat-contract';
import {
  canvasPin, conversationRefs, eventRefsShownLater, feedSegments, keyArgs, paneFocus, provisionalTitle, shownRefs, toolGroupSummary, turnLayout,
  intentTag, routedScope, toolResultLine, toolRowState, toolRowView,
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
  it('a visual_review event renders its line, its tone data, then the mission it is about', () => {
    const visual = { phase: 'needs_you', round: 1, ok: 11, issues: 2, unsure: 1, awaitingHuman: 1 };
    const segs = feedSegments([
      { type: 'data-buildd-event', data: { event: 'visual_review', objects: [ref('mission', 'm1')], text: 'Round 1 done: 11 ok, 2 issues, 1 unsure. 1 needs you.', visual } },
    ]);
    expect(segs.map(s => s.kind)).toEqual(['event', 'objects']);
    const ev = segs[0];
    expect(ev.kind === 'event' && ev.event).toBe('visual_review');
    expect(ev.kind === 'event' && ev.visual).toEqual(visual);
    const objs = segs[1];
    expect(objs.kind === 'objects' && objs.refs.map(r => `${r.kind}:${r.id}`)).toEqual(['mission:m1']);
  });

  it('an assistant turn is not its business any more: only event parts make segments', () => {
    expect(feedSegments([tool('get_task', { output: { objects: [ref('task', 't1')] } }), { type: 'text', text: 'Hi.' }])).toEqual([]);
  });

  it('summarises a group', () => {
    expect(toolGroupSummary([tool('list_tasks'), tool('get_task', { state: 'input-available' })]))
      .toEqual({ count: 2, readOnly: true, running: 1, failed: 0 });
  });
});

describe('turnLayout', () => {
  const titled = (kind: BuilddObjectRef['kind'], id: string, title: string): BuilddObjectRef => ({ ...ref(kind, id), title });
  const ids = (refs: readonly BuilddObjectRef[]) => refs.map(r => r.id);
  const only = (parts: ChatMessage['parts']) => turnLayout(parts).results.get('answer') ?? [];

  it('read 1: a get is cited under the answer as one Referenced group', () => {
    const groups = only([tool('get_task', { output: { objects: [ref('task', 't1')] } }), { type: 'text', text: 'It is in CI.' }]);
    expect(groups).toEqual([{ kind: 'referenced', key: 'ref-answer', refs: [ref('task', 't1')], more: [] }]);
  });

  it('read 10: what the answer names is featured in the order it names them; the rest fold into one row', () => {
    const list = Array.from({ length: 8 }, (_, i) => ref('task', `q${i}`));
    const groups = only([
      tool('list_tasks', { output: { objects: [titled('task', 'tA', 'Rates service rollout'), ...list, titled('task', 'tB', 'Checkout rounding fix')] } }),
      { type: 'text', text: 'Two matter: the checkout rounding fix is blocked, and the rates service rollout is in CI.' },
    ]);
    expect(groups).toHaveLength(1);
    const g = groups[0];
    expect(g.kind === 'referenced' && ids(g.refs)).toEqual(['tB', 'tA']);
    expect(g.kind === 'referenced' && ids(g.more)).toEqual(list.map(r => r.id));
  });

  it('a list with nothing named is one collapsed row, no cards', () => {
    const groups = only([tool('list_tasks', { output: { objects: [ref('task', 'q1'), ref('task', 'q2')] } }), { type: 'text', text: 'Nothing is running.' }]);
    expect(groups).toEqual([{ kind: 'referenced', key: 'ref-answer', refs: [], more: [ref('task', 'q1'), ref('task', 'q2')] }]);
  });

  it('PRs a list returned stay shown: they stack as one list', () => {
    const g = only([tool('list_tasks', { output: { objects: [ref('pr', 'p1'), ref('pr', 'p2'), ref('task', 'q1')] } }), { type: 'text', text: 'Two PRs merged today.' }])[0];
    expect(g.kind === 'referenced' && [ids(g.refs), ids(g.more)]).toEqual([['p1', 'p2'], ['q1']]);
  });

  it('write 1 / write many: each write is its own Created group with every object it returned, before the references', () => {
    const w1 = tool('create_task', { output: { objects: [ref('task', 'n1')] } });
    const w2 = tool('create_task', { output: { objects: [ref('task', 'n2'), ref('task', 'n3')] } });
    const groups = only([tool('get_task', { output: { objects: [ref('task', 't1')] } }), w1, w2, { type: 'text', text: 'Filed three.' }]);
    expect(groups.map(g => g.kind)).toEqual(['created', 'created', 'referenced']);
    expect(groups[0]).toMatchObject({ kind: 'created', key: `made-${w1.toolCallId}`, label: 'Created' });
    expect(groups[1].kind === 'created' && ids(groups[1].refs)).toEqual(['n2', 'n3']);
  });

  it('an object is drawn once per turn: what a write made is not cited again', () => {
    const groups = only([
      tool('create_task', { output: { objects: [ref('task', 'n1')] } }),
      tool('get_task', { output: { objects: [ref('task', 'n1')] } }),
      tool('get_task', { output: { objects: [ref('task', 'n1')] } }),
      { type: 'text', text: 'Filed n1.' },
    ]);
    expect(groups.map(g => g.kind)).toEqual(['created']);
  });

  it('an approval card keeps the objects it filed; its phase\'s references are fixed before the decision', () => {
    const asked = [
      tool('get_mission', { output: { objects: [ref('mission', 'm1')] } }),
      { type: 'text', text: 'Here is the change. Approve it below.' },
      tool('manage_missions', { state: 'approval-requested', input: { action: 'update' }, approval: { id: 'ap-1' } }),
    ] as ChatMessage['parts'];
    const before = turnLayout(asked);
    const id = (asked[2] as ChatToolPart).toolCallId;
    const after = turnLayout([
      asked[0], asked[1],
      { ...(asked[2] as ChatToolPart), state: 'output-available', approval: { id: 'ap-1', approved: true }, output: { objects: [ref('mission', 'm1'), ref('task', 'n1')] } },
      { type: 'text', text: 'Updated; one task filed for it.' },
    ]);
    expect(after.results.get('answer')).toEqual(before.results.get('answer'));
    // m1 already sits in the references: the receipt shows only what is new.
    expect(ids(after.receipts.get(id) ?? [])).toEqual(['n1']);
    expect(after.results.get('answer@2')).toEqual([]);
  });

  it('the same parts give the same layout: reload and reconnect draw nothing twice', () => {
    const parts: ChatMessage['parts'] = [tool('get_task', { output: { objects: [ref('task', 't1')] } }), { type: 'text', text: 'In CI.' }];
    expect(turnLayout([...parts])).toEqual(turnLayout(parts));
  });

  it('shownRefs: the cards a message draws, and what it only folded', () => {
    const m = msg([
      tool('manage_missions', { input: { action: 'list' }, output: { objects: [ref('mission', 'm-kit'), ref('mission', 'm-done')] } }),
      tool('create_task', { output: { objects: [ref('task', 'n1')] } }),
      { type: 'text', text: 'Filed one; mission m-kit is held.' },
    ]);
    const shown = shownRefs(m);
    expect(ids(shown.cards)).toEqual(['n1', 'm-kit']);
    expect(ids(shown.more)).toEqual(['m-done']);
  });
});

describe('visual review event runs', () => {
  const ev = (id: string): ChatMessage => ({ id, role: 'event', parts: [{ type: 'data-buildd-event', data: { event: 'visual_review', objects: [ref('mission', 'm1')], text: `line ${id}` } }] });
  it('each event keeps its line; the mission card shows only on the newest message naming it', () => {
    const msgs = [ev('e1'), ev('e2'), ev('e3')];
    const hidden = eventRefsShownLater(msgs);
    expect(hidden.get('e1')?.has('mission:m1')).toBe(true);
    expect(hidden.get('e2')?.has('mission:m1')).toBe(true);
    expect(hidden.has('e3')).toBe(false);
    const segs = feedSegments(msgs[0].parts, { hideEventRefs: hidden.get('e1') });
    expect(segs.map(s => s.kind)).toEqual(['event']);
  });

  it('a later assistant card for the same mission hides the event card too; other events are untouched', () => {
    const plan: ChatMessage = { id: 'p', role: 'event', parts: [{ type: 'data-buildd-event', data: { event: 'plan_ready', objects: [ref('mission', 'm1')], text: 'Plan ready' } }] };
    const reply = msg([tool('get_visual_review', { output: { data: 'x', objects: [ref('mission', 'm1')] } })]);
    const hidden = eventRefsShownLater([plan, ev('e1'), reply]);
    expect(hidden.has('p')).toBe(false);
    expect(hidden.get('e1')?.has('mission:m1')).toBe(true);
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

describe('intentTag', () => {
  const user = (id: string): ChatMessage => ({ id, role: 'user', parts: [{ type: 'text', text: 'hi' }] });
  const reply = (id: string, scope: unknown): ChatMessage => ({ id, role: 'assistant', metadata: { scope }, parts: [{ type: 'text', text: 'ok' }] });

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
