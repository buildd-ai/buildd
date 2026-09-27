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

describe('workspace-scoped reads with no scope', () => {
  const NOW = Date.parse('2026-09-27T12:00:00Z');
  const ago = (days: number) => new Date(NOW - days * 86_400_000).toISOString();
  const WS = [
    { id: 'w1', name: 'web', lastActiveAt: ago(0) },
    { id: 'w2', name: 'docs', lastActiveAt: ago(3) },
    { id: 'w3', name: 'site', lastActiveAt: ago(2) },
    { id: 'w4', name: 'old', lastActiveAt: ago(60) },
    { id: 'w5', name: 'never', lastActiveAt: null },
  ];
  function unscoped(respond: (action: string, wsId: string | undefined) => { text: string } | Error, workspaces = WS) {
    const handle = mock(async (_api: any, action: string, params: any) => {
      const r = respond(action, params.workspaceId);
      if (r instanceof Error) throw r;
      return { content: [{ type: 'text', text: r.text }] };
    });
    const tools = buildChatTools({
      ctx: { getWorkspaceId: async () => null, getLevel: async () => 'admin' } as any,
      workspaces, now: () => NOW,
      allowWrites: false, authorizedToolCallIds: new Set(),
      handle: handle as any,
      makeApi: () => async () => ({}),
    });
    const run = (name: string, input: unknown) => (tools[name] as any).execute(input, { toolCallId: 'c', messages: [] });
    return { run, handle, called: () => handle.mock.calls.map(c => c[2].workspaceId).sort() };
  }

  it('one call spans the recently active workspaces instead of erroring', async () => {
    const { run, called } = unscoped((_a, ws) => (ws ? { text: `- v1 of ${ws}` } : new Error('Cannot resolve workspace.')));
    const out = await run('list_releases', { sinceDays: 7 });
    expect(called()).toEqual(['w1', 'w2', 'w3']);
    expect(out.data).toContain('## web\n- v1 of w1');
    expect(out.data).not.toContain('Error');
  });

  it('names the idle workspaces it skipped, so the model can offer them', async () => {
    const { run } = unscoped((_a, ws) => ({ text: `- v1 of ${ws}` }));
    const out = await run('list_releases', {});
    expect(out.data).toContain('Not checked (no activity in 14 days): old, never.');
  });

  it('folds empty answers into one line rather than a heading each', async () => {
    const { run } = unscoped((_a, ws) => ({ text: ws === 'w1' ? '- v1' : 'No releases in the last 7 days.' }));
    const out = await run('list_releases', { sinceDays: 7 });
    expect(out.data).not.toContain('## docs');
    expect(out.data).toContain('Nothing in: docs, site.');
  });

  it('with nothing active, spans every workspace rather than none', async () => {
    const idle = WS.map(w => ({ ...w, lastActiveAt: ago(90) }));
    const { run, called } = unscoped((_a, ws) => ({ text: `ok ${ws}` }), idle);
    await run('list_tasks', {});
    expect(called()).toEqual(['w1', 'w2', 'w3', 'w4', 'w5']);
  });

  it('a single workspace in reach is just that workspace', async () => {
    const { run, called } = unscoped((_a, ws) => ({ text: `ok ${ws}` }), [WS[3]]);
    const out = await run('list_tasks', {});
    expect(called()).toEqual(['w4']);
    expect(out.data).toBe('ok w4');
  });

  it('an explicit workspaceId is one call, even for an idle workspace', async () => {
    const { run, called } = unscoped((_a, ws) => ({ text: `tasks of ${ws}` }));
    await run('list_tasks', { workspaceId: 'old' });
    expect(called()).toEqual(['old']);
  });

  it('a workspace that fails is named, the rest still answer', async () => {
    const { run } = unscoped((_a, ws) => (ws === 'w2' ? new Error('boom') : { text: `ok ${ws}` }));
    const out = await run('list_tasks', { status: 'completed' });
    expect(out.data).toContain('## web\nok w1');
    expect(out.data).toContain('## docs\nError: boom');
  });

  it('reads that already span workspaces are not fanned out', async () => {
    const { run, handle } = unscoped(() => ({ text: 'all missions' }));
    await run('manage_missions', { action: 'list' });
    expect(handle).toHaveBeenCalledTimes(1);
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
