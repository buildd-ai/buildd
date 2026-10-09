/**
 * create_personal_role / share_personal_role: a member creates and shares an
 * agent role of their own from chat. They live in a member-usable group
 * (workers), are writes (an approval card, nothing runs unapproved), and go
 * through MCP's register_skill / update_skill { personal: true } path, whose
 * routes are /api/roles only. Team-role creation (register_skill) stays admin.
 */
import { describe, it, expect, mock } from 'bun:test';
import { ALL_CHAT_TOOL_SPECS, opSpec } from './registry';
import { buildChatTools, needsApproval, toolNamesForGroups, groupOf } from './tools';
import { routeReachProblems } from './reach-rules';
import { CHAT_ROUTES } from './in-process-api';

function setup(opts: { canAdmin?: boolean; authorized?: string[] } = {}) {
  const handled: Array<{ action: string; params: any }> = [];
  const routes: string[][] = [];
  const handle = mock(async (_api: any, action: string, params: any) => {
    handled.push({ action, params });
    return { content: [{ type: 'text', text: 'Personal role created: "Helper" (slug: helper)' }] };
  });
  const tools = buildChatTools({
    ctx: { getWorkspaceId: async () => 'ws', getLevel: async () => 'admin', principal: 'person' } as any,
    allowWrites: true,
    canAdmin: opts.canAdmin ?? false,
    authorizedToolCallIds: new Set(opts.authorized ?? []),
    handle: handle as any,
    makeApi: (_onCall, o) => { routes.push((o?.routes ?? []).flatMap(r => r.methods.map(m => `${m} ${r.pattern}`))); return async () => ({}); },
  });
  const run = (name: string, input: unknown, toolCallId = 'call-1') =>
    (tools[name] as any).execute(input, { toolCallId, messages: [] });
  return { tools, run, handle, handled, routes };
}

describe('personal-role chat tools: registry', () => {
  it('are writes in the member-usable workers group; register_skill stays admin', () => {
    for (const t of ['create_personal_role', 'share_personal_role']) {
      expect(ALL_CHAT_TOOL_SPECS[t].group).toBe('workers');
      expect(opSpec(t, {})!.spec.class).toBe('write');
      expect(needsApproval(t, {})).toBe(true);
    }
    expect(opSpec('register_skill', {})!.spec.class).toBe('admin');
    expect(groupOf('register_skill')).toBe('admin');
  });

  it('reach only /api/roles, and every route they name is declared with a reach rule', () => {
    const refs = ['create_personal_role', 'share_personal_role'].flatMap(t => opSpec(t, {})!.spec.routes);
    expect(refs.filter(r => r !== 'GET /api/workspaces').every(r => / \/api\/roles(\/|$)/.test(r))).toBe(true);
    for (const r of CHAT_ROUTES.filter(r => r.pattern.startsWith('/api/roles'))) expect(routeReachProblems(r)).toEqual([]);
    expect(CHAT_ROUTES.find(r => r.pattern === '/api/roles')!.reach.pinTeam).toBe(true);
  });
});

describe('personal-role chat tools: a member', () => {
  it('is offered both, and not register_skill', () => {
    const { tools } = setup({ canAdmin: false });
    expect(Object.keys(tools)).toContain('create_personal_role');
    expect(Object.keys(tools)).toContain('share_personal_role');
    expect(Object.keys(tools)).not.toContain('register_skill');
    expect(toolNamesForGroups(tools, ['workers'])).toEqual(expect.arrayContaining(['create_personal_role', 'share_personal_role']));
  });

  it('nothing runs without an approval card', async () => {
    const { run, handle } = setup();
    const out = await run('create_personal_role', { name: 'Helper', content: 'You help me' });
    expect(out.data).toContain('not approved');
    expect(handle).not.toHaveBeenCalled();
  });

  it('an approved create goes through the MCP personal path with only its own routes', async () => {
    const { run, handled, routes } = setup({ authorized: ['call-1'] });
    await run('create_personal_role', { name: 'Helper', content: 'You help me', visibility: 'team' });
    expect(handled).toEqual([{ action: 'register_skill', params: { name: 'Helper', content: 'You help me', visibility: 'team', personal: true } }]);
    expect(routes[0].sort()).toEqual(['GET /api/workspaces', 'POST /api/roles', 'POST /api/roles/:id/share']);
  });

  it('an approved share goes through update_skill { personal: true } with only slug and visibility', async () => {
    const { run, handled, routes } = setup({ authorized: ['call-1'] });
    await run('share_personal_role', { slug: 'helper', visibility: 'team' });
    expect(handled).toEqual([{ action: 'update_skill', params: { slug: 'helper', visibility: 'team', personal: true } }]);
    expect(routes[0].sort()).toEqual(['GET /api/roles', 'GET /api/workspaces', 'POST /api/roles/:id/share']);
  });

  it('a share needs a visibility of team or private', () => {
    const { tools } = setup();
    const schema = (tools.share_personal_role as any).inputSchema;
    expect(schema.safeParse({ slug: 'helper', visibility: 'public' }).success).toBe(false);
    expect(schema.safeParse({ slug: 'helper', visibility: 'private' }).success).toBe(true);
  });
});
