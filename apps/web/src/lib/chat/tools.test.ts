import { describe, it, expect, mock } from 'bun:test';
import { allActions } from '@buildd/core/mcp-tools';
import { CHAT_READ_TOOLS } from '@buildd/shared';
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

  it('every tool the server exposes is in the shared read class (the UI groups by it)', () => {
    for (const a of CHAT_TOOL_ACTIONS) expect(CHAT_READ_TOOLS as readonly string[]).toContain(a);
  });

  it('never exposes a never-from-chat action', () => {
    const { tools } = setup();
    for (const banned of ['manage_secrets', 'manage_model_tiers', 'manage_workspaces', 'trigger_release', 'send_agent_message', 'merge_pr', 'create_task']) {
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

  it('with writes off, create is not even in the schema', () => {
    const { tools } = setup({ allowWrites: false });
    const schema = (tools.manage_missions as any).inputSchema;
    expect(schema.safeParse({ action: 'create', title: 'X' }).success).toBe(false);
    expect(schema.safeParse({ action: 'list' }).success).toBe(true);
  });
});
