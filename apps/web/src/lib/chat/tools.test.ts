import { describe, it, expect, mock } from 'bun:test';
import { allActions } from '@buildd/core/mcp-tools';
import { buildChatTools, CHAT_TOOL_ACTIONS } from './tools';

function setup(opts: { allowWrites?: boolean; authorized?: string[]; respond?: (endpoint: string, init?: RequestInit) => unknown } = {}) {
  const apiCalls: string[] = [];
  const handle = mock(async (api: any, action: string, params: any) => {
    if (action === 'manage_missions' && params.action === 'create') {
      await api('/api/missions', { method: 'POST', body: JSON.stringify({ title: params.title }) });
      return { content: [{ type: 'text', text: `Mission created: "${params.title}"` }] };
    }
    await api('/api/tasks?status=active');
    return { content: [{ type: 'text', text: '2 tasks' }] };
  });
  const onMissionFiled = mock(async () => {});
  const tools = buildChatTools({
    ctx: { getWorkspaceId: async () => 'ws', getLevel: async () => 'admin' } as any,
    allowWrites: opts.allowWrites ?? true,
    authorizedToolCallIds: new Set(opts.authorized ?? []),
    onMissionFiled,
    handle: handle as any,
    makeApi: (onCall) => async (endpoint: string, init?: RequestInit) => {
      apiCalls.push(`${init?.method ?? 'GET'} ${endpoint}`);
      const path = endpoint.split('?')[0];
      const body = path === '/api/missions'
        ? { id: 'm-new', title: 'Bill in local currency', status: 'active', workspaceId: 'ws' }
        : { tasks: [{ id: 't1', title: 'A' }, { id: 't2', title: 'B' }] };
      onCall({ method: init?.method ?? 'GET', path, status: 200, body });
      return body;
    },
  });
  const run = (name: string, input: unknown, toolCallId = 'call-1') =>
    (tools[name] as any).execute(input, { toolCallId, messages: [] });
  return { tools, run, handle, onMissionFiled, apiCalls };
}

describe('allowlist parity', () => {
  it('every chat tool is a real MCP action — a rename fails here, not silently in chat', () => {
    for (const a of CHAT_TOOL_ACTIONS) expect(allActions as readonly string[]).toContain(a);
  });

  it('never exposes a never-in-chat, worker-only or deferred action', () => {
    const { tools } = setup();
    for (const banned of ['manage_secrets', 'claim_task', 'complete_task', 'create_pr', 'manage_model_tiers', 'merge_pr', 'update_artifact', 'get_usage_stats']) {
      expect(Object.keys(tools)).not.toContain(banned);
    }
  });

  it('admin ops are not even in the schema for a member', () => {
    const member = setup().tools;
    expect((member.manage_workspaces as any).inputSchema.safeParse({ action: 'list' }).success).toBe(true);
    expect((member.manage_missions as any).inputSchema.safeParse({ action: 'delete', missionId: 'm' }).success).toBe(false);
  });

  it('a read op gets an API with only its declared routes', async () => {
    const seen: any[] = [];
    const tools = buildChatTools({
      ctx: { getWorkspaceId: async () => 'ws', getLevel: async () => 'admin' } as any,
      allowWrites: true, authorizedToolCallIds: new Set(),
      handle: (async () => ({ content: [{ type: 'text', text: 'ok' }] })) as any,
      makeApi: (_onCall, opts) => { seen.push(opts?.routes?.map(r => `${r.methods.join(',')} ${r.pattern}`)); return async () => ({}); },
    });
    await (tools.get_task as any).execute({ taskId: 'x' }, { toolCallId: 'c', messages: [] });
    expect(seen[0]).toEqual(['GET /api/tasks/:id', 'GET /api/workspaces']);
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
  it('write sub-actions without an approval never reach the handler; admin ones not even for a member', async () => {
    const { run, handle } = setup();
    for (const op of ['update', 'arm', 'link_task', 'evaluate']) {
      const out = await run('manage_missions', { action: op, missionId: 'm1' });
      expect(out.data).toContain('not approved');
    }
    const del = await run('manage_missions', { action: 'delete', missionId: 'm1' });
    expect(del.data).toMatch(/not available from chat|needs a team owner or admin/);
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
    const { run, apiCalls, onMissionFiled } = setup({ authorized: ['call-1'] });
    const out = await run('manage_missions', { action: 'create', title: 'Bill in local currency' }, 'call-1');
    expect(apiCalls).toEqual(['POST /api/missions']);
    expect(out.objects).toEqual([expect.objectContaining({ kind: 'mission', id: 'm-new' })]);
    expect(onMissionFiled).toHaveBeenCalledTimes(1);
    expect((onMissionFiled.mock.calls[0] as any)[0].missionId).toBe('m-new');
  });

  it('an approval for another tool call does not authorize this one', async () => {
    const { run, handle } = setup({ authorized: ['call-other'] });
    await run('manage_missions', { action: 'create', title: 'X' }, 'call-1');
    expect(handle).not.toHaveBeenCalled();
  });

  it('with writes off, create is not even in the schema (watch tools)', () => {
    expect(setup({ allowWrites: false }).tools.watch).toBeUndefined();
    expect(setup({ allowWrites: false }).tools.list_watches).toBeDefined();
  });

  it('with writes off, create is not even in the schema', () => {
    const { tools } = setup({ allowWrites: false });
    const schema = (tools.manage_missions as any).inputSchema;
    expect(schema.safeParse({ action: 'create', title: 'X' }).success).toBe(false);
    expect(schema.safeParse({ action: 'list' }).success).toBe(true);
  });
});
