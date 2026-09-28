/** 0.10.0: the rich tool rows' pure view model (`tool-calls.ts`). */
import { describe, expect, it } from 'bun:test';
import type { ChatToolPart } from '@builddai/ai-kit/chat/contract';
import { DEFAULT_KEY_ARG_SKIP, keyArgs, toolCallResult, toolCallState, toolCallView, toolGroupSummary } from './index';

const tool = (name: string, over: Partial<ChatToolPart> = {}): ChatToolPart => ({
  type: `tool-${name}`, toolCallId: `call-${name}`, state: 'output-available', input: {}, output: { data: [], objects: [] }, ...over,
});
const ref = (id: string) => ({ kind: 'task', id, workspaceId: null, fallbackText: `task ${id}` });

describe('toolCallState', () => {
  it('maps every tool state; an approved write still running is `approved`', () => {
    expect(toolCallState(tool('x', { state: 'input-streaming' }))).toBe('running');
    expect(toolCallState(tool('x', { state: 'input-available' }))).toBe('running');
    expect(toolCallState(tool('x', { state: 'approval-requested', approval: { id: 'a' } }))).toBe('awaiting');
    expect(toolCallState(tool('x', { state: 'approval-responded', approval: { id: 'a', approved: true } }))).toBe('approved');
    expect(toolCallState(tool('x', { state: 'approval-responded', approval: { id: 'a', approved: false } }))).toBe('denied');
    expect(toolCallState(tool('x', { state: 'output-error', errorText: 'boom' }))).toBe('failed');
    expect(toolCallState(tool('x', { state: 'output-denied' }))).toBe('denied');
    expect(toolCallState(tool('x'))).toBe('done');
  });
});

describe('keyArgs', () => {
  it('drops uuids, objects, the action and paging args; truncates; caps at two', () => {
    expect(DEFAULT_KEY_ARG_SKIP).toEqual(['action', 'limit', 'offset', 'cursor']);
    expect(keyArgs({ action: 'list', id: '5f0c7a51-2b9e-4c1e-9d55-0c3a4b1d2e3f', limit: 5, filter: { a: 1 } })).toEqual([]);
    expect(keyArgs({ title: 'x'.repeat(80) })[0]).toHaveLength(40);
    expect(keyArgs({ a: 'one', b: 'two', c: 'three' })).toEqual(['one', 'two']);
    expect(keyArgs({ n: 3, flag: true })).toEqual(['3', 'true']);
    expect(keyArgs(null)).toEqual([]);
  });
  it('the app names what to skip, what comes first, and how many', () => {
    const input = { workspaceId: 'ws', status: 'open', title: 'Checkout', repo: 'web' };
    expect(keyArgs(input, { skip: ['workspaceId'], prefer: ['title', 'status'] })).toEqual(['Checkout', 'open']);
    expect(keyArgs(input, { skip: ['workspaceId'], prefer: ['repo'], max: 3 })).toEqual(['web', 'open', 'Checkout']);
  });
});

describe('toolCallResult', () => {
  it('prefers the summary, then the one object, then counts', () => {
    expect(toolCallResult(tool('x', { output: { summary: '#413 merged\nmore', objects: [] } }))).toBe('#413 merged');
    expect(toolCallResult(tool('x', { output: { data: { summary: 'from data' }, objects: [] } }))).toBe('from data');
    expect(toolCallResult(tool('x', { output: { data: {}, objects: [ref('t1')] } }))).toBe('task t1');
    expect(toolCallResult(tool('x', { output: { data: {}, objects: [ref('t1'), ref('t2')] } }))).toBe('2 results');
    expect(toolCallResult(tool('x', { output: { data: [1, 2, 3], objects: [] } }))).toBe('3 results');
    expect(toolCallResult(tool('x', { output: { data: [1], objects: [] } }))).toBe('1 result');
    expect(toolCallResult(tool('x', { output: { data: [], objects: [] } }))).toBe('none');
    expect(toolCallResult(tool('x', { output: 'plain\ntext' }))).toBe('plain');
    expect(toolCallResult(tool('x', { output: undefined }))).toBe('done');
  });
  it('failed: the first line of the error; denied: nothing changed; running: null', () => {
    expect(toolCallResult(tool('x', { state: 'output-error', errorText: 'Forbidden\nstack' }))).toBe('Forbidden');
    expect(toolCallResult(tool('x', { state: 'output-denied' }))).toBe('nothing changed');
    expect(toolCallResult(tool('x', { state: 'input-available' }))).toBeNull();
  });
});

describe('toolCallView', () => {
  const part = tool('manage_items', {
    input: { action: 'list', workspaceId: 'ws-1', owner: 'billing' },
    output: { data: [], objects: [], summary: 'none open', allowed: true },
  });
  it('defaults: the tool name as the label, the action, key args, not read-only, the allowed flag', () => {
    const v = toolCallView(part);
    expect(v).toMatchObject({ id: 'call-manage_items', name: 'manage_items', label: 'manage_items', action: 'list', args: ['ws-1', 'billing'], state: 'done', result: 'none open', readOnly: false, allowed: true });
    expect(toolCallView(tool('x')).allowed).toBe(false);
  });
  it('app hooks: a label table, key args, read-only, the result line', () => {
    const v = toolCallView(part, {
      toolLabel: name => ({ manage_items: 'Items' } as Record<string, string>)[name],
      keyArgs: { skip: ['action', 'workspaceId'] },
      isReadOnly: p => (p.input as { action?: string }).action === 'list',
      result: () => 'custom',
    });
    expect(v).toMatchObject({ name: 'manage_items', label: 'Items', args: ['billing'], readOnly: true, result: 'custom' });
    expect(toolCallView(tool('other'), { toolLabel: () => null }).label).toBe('other');
    expect(toolCallView(part, { keyArgs: () => ['mine'] }).args).toEqual(['mine']);
  });
});

describe('toolGroupSummary', () => {
  it('counts, read-only only when every call is, running and failed', () => {
    const ro = { isReadOnly: () => true };
    expect(toolGroupSummary([toolCallView(tool('a'), ro), toolCallView(tool('b', { state: 'input-available' }), ro)]))
      .toEqual({ count: 2, readOnly: true, running: 1, failed: 0 });
    expect(toolGroupSummary([toolCallView(tool('a'), ro), toolCallView(tool('b', { state: 'output-error' }))]))
      .toEqual({ count: 2, readOnly: false, running: 0, failed: 1 });
    expect(toolGroupSummary([]).readOnly).toBe(false);
  });
});
