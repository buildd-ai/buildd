import { describe, it, expect, mock } from 'bun:test';
import { allActions } from '@buildd/core/mcp-tools';
import { CHAT_APPROVAL_TOOLS, CHAT_READ_TOOLS, chatToolNeedsApproval } from '@buildd/shared';
import { buildChatTools, CHAT_TOOL_ACTIONS, CHAT_WRITE_TOOLS } from './tools';

function setup(opts: { allowWrites?: boolean; authorized?: string[]; respond?: (endpoint: string, init?: RequestInit) => unknown } = {}) {
  const apiCalls: string[] = [];
  const handle = mock(async (api: any, action: string, params: any) => {
    if (action === 'manage_missions' && params.action === 'create') {
      await api('/api/missions', { method: 'POST', body: JSON.stringify({ title: params.title }) });
      return { content: [{ type: 'text', text: `Mission created: "${params.title}"` }] };
    }
    if (action === 'create_task') {
      await api('/api/tasks', { method: 'POST', body: JSON.stringify({ title: params.title, workspaceId: 'ws' }) });
      return { content: [{ type: 'text', text: `Task created: "${params.title}"` }] };
    }
    await api('/api/tasks?status=active');
    return { content: [{ type: 'text', text: '2 tasks' }] };
  });
  const onWorkFiled = mock(async (_: any) => {});
  const tools = buildChatTools({
    ctx: { getWorkspaceId: async () => 'ws', getLevel: async () => 'admin' } as any,
    allowWrites: opts.allowWrites ?? true,
    authorizedToolCallIds: new Set(opts.authorized ?? []),
    onWorkFiled,
    handle: handle as any,
    makeApi: (onCall) => async (endpoint: string, init?: RequestInit) => {
      apiCalls.push(`${init?.method ?? 'GET'} ${endpoint}`);
      const path = endpoint.split('?')[0];
      const method = init?.method ?? 'GET';
      const body = path === '/api/missions'
        ? { id: 'm-new', title: 'Bill in local currency', status: 'active', workspaceId: 'ws' }
        : method === 'POST' && path === '/api/tasks'
        ? { id: 't-new', title: 'Add a currency column', status: 'pending', workspaceId: 'ws' }
        : { tasks: [{ id: 't1', title: 'A' }, { id: 't2', title: 'B' }] };
      onCall({ method: init?.method ?? 'GET', path, status: 200, body });
      return body;
    },
  });
  const run = (name: string, input: unknown, toolCallId = 'call-1') =>
    (tools[name] as any).execute(input, { toolCallId, messages: [] });
  return { tools, run, handle, onWorkFiled, apiCalls };
}

describe('allowlist parity', () => {
  it('every chat tool is a real MCP action — a rename fails here, not silently in chat', () => {
    for (const a of CHAT_TOOL_ACTIONS) expect(allActions as readonly string[]).toContain(a);
  });

  it('every tool the server exposes is in a shared class the UI groups by: read, or approval', () => {
    for (const a of CHAT_TOOL_ACTIONS) {
      const read = (CHAT_READ_TOOLS as readonly string[]).includes(a);
      const approval = a in CHAT_APPROVAL_TOOLS;
      expect(read || approval).toBe(true);
    }
  });

  it('every write-only tool renders as an approval card for any input', () => {
    for (const a of CHAT_WRITE_TOOLS) {
      expect(chatToolNeedsApproval(a, {})).toBe(true);
      expect(chatToolNeedsApproval(a, { title: 'x' })).toBe(true);
      expect((CHAT_READ_TOOLS as readonly string[]).includes(a)).toBe(false);
    }
    expect(chatToolNeedsApproval('manage_missions', { action: 'create' })).toBe(true);
    expect(chatToolNeedsApproval('manage_missions', { action: 'list' })).toBe(false);
    expect(chatToolNeedsApproval('list_tasks', {})).toBe(false);
  });

  it('never exposes a never-from-chat action', () => {
    const { tools } = setup();
    for (const banned of ['manage_secrets', 'manage_model_tiers', 'manage_workspaces', 'trigger_release', 'send_agent_message', 'merge_pr', 'update_task', 'create_schedule']) {
      expect(Object.keys(tools)).not.toContain(banned);
    }
  });
});

describe('read tools', () => {
  it('run straight away and return a ChatToolResult with object refs', async () => {
    const { run } = setup();
    const out = await run('list_tasks', {});
    expect(out.data).toBe('2 tasks');
    expect(out.objects.map((o: any) => o.id)).toEqual(['t1', 't2']);
    expect(out.summary).toBe('2 tasks');
  });
});

describe('manage_missions', () => {
  it('refuses sub-actions outside the P1 set without calling the handler', async () => {
    const { run, handle } = setup();
    for (const op of ['update', 'delete', 'arm', 'link_task', 'evaluate']) {
      const out = await run('manage_missions', { action: op, missionId: 'm1' });
      expect(out.data).toContain('not available from chat');
    }
    expect(handle).not.toHaveBeenCalled();
  });

  it('create without a won approval files nothing', async () => {
    const { run, handle, apiCalls } = setup({ authorized: [] });
    const out = await run('manage_missions', { action: 'create', title: 'X' }, 'call-1');
    expect(out.data).toContain('not approved');
    expect(handle).not.toHaveBeenCalled();
    expect(apiCalls).toEqual([]);
  });

  it('create with this request\'s approval files exactly one mission and links it', async () => {
    const { run, apiCalls, onWorkFiled } = setup({ authorized: ['call-1'] });
    const out = await run('manage_missions', { action: 'create', title: 'Bill in local currency' }, 'call-1');
    expect(apiCalls).toEqual(['POST /api/missions']);
    expect(out.objects).toEqual([expect.objectContaining({ kind: 'mission', id: 'm-new' })]);
    expect(onWorkFiled).toHaveBeenCalledTimes(1);
    expect((onWorkFiled.mock.calls[0] as any)[0]).toMatchObject({ kind: 'mission', id: 'm-new', toolCallId: 'call-1' });
  });

  it('an approval for another tool call does not authorize this one', async () => {
    const { run, handle } = setup({ authorized: ['call-other'] });
    await run('manage_missions', { action: 'create', title: 'X' }, 'call-1');
    expect(handle).not.toHaveBeenCalled();
  });

  it('with writes off, create is not even in the schema', () => {
    const { tools } = setup({ allowWrites: false });
    const schema = (tools.manage_missions as any).inputSchema;
    expect(schema.safeParse({ action: 'create', title: 'X' }).success).toBe(false);
    expect(schema.safeParse({ action: 'list' }).success).toBe(true);
  });
});

describe('create_task', () => {
  const INPUT = { title: 'Add a currency column', description: 'Add invoices.currency.', kind: 'engineering' };

  it('without a won approval files nothing', async () => {
    const { run, handle, apiCalls } = setup({ authorized: [] });
    const out = await run('create_task', INPUT, 'call-1');
    expect(out.data).toContain('not approved');
    expect(handle).not.toHaveBeenCalled();
    expect(apiCalls).toEqual([]);
  });

  it('with this request\'s approval files exactly one task and reports it', async () => {
    const { run, apiCalls, onWorkFiled } = setup({ authorized: ['call-1'] });
    const out = await run('create_task', INPUT, 'call-1');
    expect(apiCalls).toEqual(['POST /api/tasks']);
    expect(out.objects).toEqual([expect.objectContaining({ kind: 'task', id: 't-new' })]);
    expect(out.summary).toBe('filed "Add a currency column"');
    expect(onWorkFiled).toHaveBeenCalledTimes(1);
    expect((onWorkFiled.mock.calls[0] as any)[0]).toMatchObject({ kind: 'task', id: 't-new', toolCallId: 'call-1' });
  });

  it('an approval for another tool call does not authorize this one', async () => {
    const { run, handle } = setup({ authorized: ['call-other'] });
    await run('create_task', INPUT, 'call-1');
    expect(handle).not.toHaveBeenCalled();
  });

  it('is not registered at all when writes are off', () => {
    const { tools } = setup({ allowWrites: false });
    expect(Object.keys(tools)).not.toContain('create_task');
    expect(Object.keys(tools)).toContain('list_tasks');
  });

  it('the schema requires a title, a description and a kind from the tasks vocabulary', () => {
    const schema = (setup().tools.create_task as any).inputSchema;
    expect(schema.safeParse(INPUT).success).toBe(true);
    expect(schema.safeParse({ ...INPUT, kind: undefined }).success).toBe(false);
    expect(schema.safeParse({ ...INPUT, kind: 'vibes' }).success).toBe(false);
    expect(schema.safeParse({ title: 'x', kind: 'engineering' }).success).toBe(false);
    expect(schema.safeParse({ ...INPUT, missionId: 'not-a-uuid' }).success).toBe(false);
    expect(schema.safeParse({ ...INPUT, parentTaskId: 't1' }).success).toBe(true); // zod strips unknown keys
    expect(schema.parse({ ...INPUT, parentTaskId: 't1' })).not.toHaveProperty('parentTaskId');
  });
});
