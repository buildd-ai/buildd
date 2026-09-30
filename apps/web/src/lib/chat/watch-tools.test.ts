import { describe, it, expect } from 'bun:test';
import { buildChatTools } from './tools';

const T = '33333333-3333-4333-8333-333333333333';
const SUB = '44444444-4444-4444-8444-444444444444';
const OTHER = '55555555-5555-4555-8555-555555555555';
const ctx = { getWorkspaceId: async () => 'ws', getLevel: async () => 'admin' } as any;

describe('watch tools', () => {
  function watchSetup(opts: { allowed?: string[] } = {}) {
    const calls: Array<{ method: string; path: string; body: any }> = [];
    const tools = buildChatTools({
      ctx,
      allowWrites: true,
      authorizedToolCallIds: new Set(),
      allowedToolCallIds: new Set(opts.allowed ?? []),
      conversationId: 'conv-1',
      preview: async (_tool, input) => ({ ok: true, input: { taskId: input.taskId, on: ['task.completed', 'task.failed'] }, preview: { v: 1, verb: 'Watch', target: { kind: 'task', id: T, label: 'Checkout' }, changes: [], fingerprint: 'f' } }),
      makeApi: (_onCall, o) => async (endpoint: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        const path = endpoint.split('?')[0];
        if (!o?.routes?.some(r => r.methods.includes(method))) throw new Error(`route not declared: ${method} ${path}`);
        calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : null });
        if (path === '/api/subscriptions' && method === 'POST') return { subscription: { id: 'sub-1', eventTypes: ['task.completed', 'task.failed'] } };
        return { subscriptions: [] };
      },
    });
    const run = (name: string, input: unknown, id = 'call-1') => (tools[name] as any).execute(input, { toolCallId: id, messages: [] });
    return { tools, run, calls };
  }

  it('watch without an approval or an allow writes nothing', async () => {
    const { run, calls } = watchSetup();
    const out = await run('watch', { taskId: T });
    expect(out.data).toContain('not approved');
    expect(calls.filter(c => c.method !== 'GET')).toEqual([]);
  });

  it('an allowed watch is delivered to the turn\'s conversation, whatever the model passed', async () => {
    const { tools, run, calls } = watchSetup({ allowed: ['call-1'] });
    // The schema has no conversationId: a model-supplied one is refused as a
    // tool error, and even one that got past it never reaches the route.
    expect((tools.watch as any).inputSchema.safeParse({ taskId: T, conversationId: 'someone-elses' }).success).toBe(false);
    const out = await run('watch', { taskId: T, conversationId: 'someone-elses' });
    expect(out.allowed).toBe(true);
    expect(calls).toEqual([{ method: 'POST', path: '/api/subscriptions', body: { taskId: T, eventTypes: ['task.completed', 'task.failed'], conversationId: 'conv-1' } }]);
    expect(out.objects).toEqual([expect.objectContaining({ kind: 'task', id: T })]);
  });

  it('list_watches is a read; unwatch with no match deletes nothing', async () => {
    const { run, calls } = watchSetup();
    expect((await run('list_watches', {})).data).toBe('No watches are running.');
    expect((await run('unwatch', { prNumber: 42 })).data).toContain('No running watch matches');
    expect(calls.map(c => c.method)).toEqual(['GET', 'GET']);
  });

  it('with writes off, watch is not offered; list_watches still is', () => {
    const off = buildChatTools({ ctx, allowWrites: false, authorizedToolCallIds: new Set(), makeApi: () => async () => ({}) });
    expect(off.watch).toBeUndefined();
    expect(off.list_watches).toBeDefined();
  });
});

describe('an approved unwatch', () => {
  const card = { v: 1 as const, verb: 'Stop watching', target: { kind: 'subscription', id: SUB, label: 'Checkout' }, changes: [], fingerprint: 'fp' };

  function approved(nowTarget = SUB) {
    const calls: string[] = [];
    const tools = buildChatTools({
      ctx,
      allowWrites: true,
      authorizedToolCallIds: new Set(['call-1']),
      approvedPreviews: new Map([['call-1', card]]),
      preview: async () => ({ ok: true, input: { watchId: nowTarget }, preview: { ...card, target: { ...card.target, id: nowTarget } } }),
      makeApi: () => async (endpoint: string, init?: RequestInit) => {
        calls.push(`${init?.method ?? 'GET'} ${endpoint}`);
        return { subscriptions: [
          { id: SUB, subjectKind: 'task', subjectKey: 't1', eventTypes: [], expiresAt: '', label: 'Checkout' },
          { id: OTHER, subjectKind: 'pr', subjectKey: 'a/b#99', subjectRef: { number: 99 }, eventTypes: [], expiresAt: '', label: 'PR #99' },
        ] };
      },
    });
    return { run: (input: unknown) => (tools.unwatch as any).execute(input, { toolCallId: 'call-1', messages: [] }), calls };
  }

  it('stops exactly the watch the card showed, not whatever the raw input now names', async () => {
    const { run, calls } = approved();
    await run({ prNumber: 99 });
    expect(calls.filter(c => c.startsWith('DELETE'))).toEqual([`DELETE /api/subscriptions/${SUB}`]);
  });

  it('if the card no longer matches, nothing is stopped', async () => {
    const { run, calls } = approved(OTHER);
    const out = await run({ watchId: SUB });
    expect(out.data).toContain('nothing changed');
    expect(calls.filter(c => c.startsWith('DELETE'))).toEqual([]);
  });
});
