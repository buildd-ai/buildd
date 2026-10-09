/**
 * Tool visibility rules for the remote MCP server.
 *
 * These assert the two gates that decide what a caller is even told exists:
 * token level, and whether the workspace is data-class `sensitive`. Both were
 * previously only reachable through a full HTTP request and had no coverage.
 */

import { describe, it, expect, test } from 'bun:test';
import { allActions, adminActions, PERSONAL_ROLE_ACTIONS, ORCHESTRATION_TASK_TOKEN_ADMIN_ACTIONS } from '@buildd/core/mcp-tools';
import { ACTION_LISTING, actionHelp, MCP_TOOL_GROUPS, mcpGroupOf, mcpGroupToolName } from '@buildd/core/mcp-tool-groups';
import {
  requiredScopeForMcpTool, actionsForLevel, groupActionsForLevel, listMcpTools, mcpServerInstructions, mcpToolSurfaceFor, routeGroupToolCall,
  type McpAccountLevel,
} from './tools';

const LEVELS: McpAccountLevel[] = ['trigger', 'worker', 'admin'];

type Tool = { name: string; description: string; inputSchema: { properties: { action: { enum: string[] }; params: { description: string } } } };
const tools = (opts: Parameters<typeof listMcpTools>[0]) => listMcpTools(opts) as Tool[];
/** Same estimate the chat-eval `static` command uses. */
const estTokens = (t: Tool) => Math.ceil(JSON.stringify({ name: t.name, description: t.description, input_schema: t.inputSchema }).length / 3.6);

function toolNames(opts: Parameters<typeof listMcpTools>[0]): string[] {
  return listMcpTools(opts).map((t) => (t as { name: string }).name);
}

/** Tools that read or write team knowledge — all gated on data class. */
const KNOWLEDGE_TOOLS = ['buildd_memory', 'recall', 'learn'];

describe('listMcpTools — token level gating', () => {
  it('legacy surface: exposes the buildd tool at every level', () => {
    for (const accountLevel of LEVELS) {
      expect(toolNames({ accountLevel, isSensitive: false, surface: 'legacy' })).toContain('buildd');
    }
  });

  it('groups surface: does not list buildd', () => {
    for (const accountLevel of LEVELS) {
      expect(toolNames({ accountLevel, isSensitive: false, surface: 'groups' })).not.toContain('buildd');
    }
  });

  it('withholds worker coordination tools from trigger tokens', () => {
    const names = toolNames({ accountLevel: 'trigger', isSensitive: false, surface: 'groups' });
    expect(names).not.toContain('check_path_claim');
    expect(names).not.toContain('send_worker_message');
  });

  it('exposes worker coordination tools to worker and admin tokens', () => {
    for (const accountLevel of ['worker', 'admin'] as McpAccountLevel[]) {
      const names = toolNames({ accountLevel, isSensitive: false, surface: 'groups' });
      expect(names).toContain('check_path_claim');
      expect(names).toContain('send_worker_message');
    }
  });

  it('check_path_claim declares release (and its reason/expectedRevision companions) in its input schema', () => {
    // Regression: the description has always promised "With release=true, gives
    // the paths back instead", and the handler has always read args.release /
    // args.reason / args.expectedRevision — but the schema only declared
    // `paths`, so a client that validates arguments against the published
    // schema drops `release` before it reaches the server, silently re-claiming
    // instead of releasing.
    const [tool] = tools({ accountLevel: 'worker', isSensitive: false, surface: 'groups' }).filter(t => t.name === 'check_path_claim') as Array<{
      inputSchema: { properties: Record<string, unknown> };
    }>;
    expect(Object.keys(tool.inputSchema.properties)).toEqual(
      expect.arrayContaining(['paths', 'release', 'reason', 'expectedRevision'])
    );
  });

  it('narrows the advertised action list to the caller level', () => {
    const trigger = actionsForLevel('trigger');
    const worker = actionsForLevel('worker');
    const admin = actionsForLevel('admin');

    // Each level is a strict superset of what the level below may call.
    expect(worker.length).toBeGreaterThan(trigger.length);
    expect(admin.length).toBeGreaterThan(worker.length);
    for (const action of worker) expect(admin).toContain(action);

    // Admin-only knowledge management is never advertised below admin.
    expect(admin).toContain('consolidate_knowledge');
    expect(worker).not.toContain('consolidate_knowledge');
    expect(trigger).not.toContain('consolidate_knowledge');
  });

  it('exposes the explain read to worker and admin, but not to trigger tokens', () => {
    // A deterministic read over rows the caller can already see, needed by the
    // agent standing in the stuck state — so worker level, not admin.
    expect(actionsForLevel('worker')).toContain('explain');
    expect(actionsForLevel('admin')).toContain('explain');
    expect(actionsForLevel('trigger')).not.toContain('explain');
  });

  it('documents every advertised action in the params description', () => {
    const [builddTool] = listMcpTools({ accountLevel: 'admin', isSensitive: false, surface: 'legacy' }) as Array<{
      inputSchema: { properties: { params: { description: string } } };
    }>;
    const description = builddTool.inputSchema.properties.params.description;
    for (const action of actionsForLevel('admin')) {
      expect(description, `${action} must be documented`).toContain(`${action}:`);
    }
  });

  it('publishes the same action list in the schema enum and the description', () => {
    const [builddTool] = listMcpTools({ accountLevel: 'worker', isSensitive: false, surface: 'legacy' }) as Array<{
      inputSchema: { properties: { action: { enum: string[] } } };
    }>;
    expect(builddTool.inputSchema.properties.action.enum).toEqual(actionsForLevel('worker'));
  });
});

describe('listMcpTools — sensitive workspace gating', () => {
  it('does not expose knowledge tools for a sensitive workspace, at any level', () => {
    for (const accountLevel of LEVELS) {
      for (const surface of ['groups', 'legacy'] as const) {
        const names = toolNames({ accountLevel, isSensitive: true, surface });
        for (const tool of KNOWLEDGE_TOOLS) expect(names).not.toContain(tool);
      }
    }
  });

  it('exposes knowledge tools for a standard workspace', () => {
    const names = toolNames({ accountLevel: 'worker', isSensitive: false, surface: 'legacy' });
    for (const tool of KNOWLEDGE_TOOLS) expect(names).toContain(tool);
    const groups = toolNames({ accountLevel: 'worker', isSensitive: false, surface: 'groups' });
    expect(groups).toContain('recall');
    expect(groups).toContain('learn');
    // Deprecated: callable, no longer listed on the groups surface.
    expect(groups).not.toContain('buildd_memory');
  });

  it('still exposes task coordination tools for a sensitive workspace', () => {
    // The data class gates knowledge, not the ability to do the work.
    const names = toolNames({ accountLevel: 'worker', isSensitive: true, surface: 'groups' });
    expect(names).toContain('buildd_work');
    expect(toolNames({ accountLevel: 'worker', isSensitive: true, surface: 'legacy' })).toContain('buildd');
    expect(names).toContain('check_path_claim');
    expect(names).toContain('send_worker_message');
  });
});

describe('listMcpTools — group tools', () => {
  const groupTools = (accountLevel: McpAccountLevel) => tools({ accountLevel, isSensitive: false, surface: 'groups' }).filter(t => t.name.startsWith('buildd_') && t.name !== 'buildd_memory');

  it('lists one tool per group the level reaches', () => {
    expect(groupTools('admin').map(t => t.name)).toEqual(MCP_TOOL_GROUPS.map(mcpGroupToolName));
    expect(groupTools('worker').map(t => t.name)).toEqual(
      MCP_TOOL_GROUPS.filter(g => groupActionsForLevel(g, 'worker').length > 0).map(mcpGroupToolName),
    );
    // Trigger tokens reach only these areas.
    expect(groupTools('trigger').map(t => t.name).sort()).toEqual(['buildd_artifacts', 'buildd_schedules', 'buildd_tasks', 'buildd_work']);
  });

  it("each group's enum is its actions at that level, plus help", () => {
    for (const level of LEVELS) {
      const allowed = new Set(actionsForLevel(level));
      for (const t of groupTools(level)) {
        const actions = t.inputSchema.properties.action.enum;
        expect(actions[actions.length - 1]).toBe('help');
        for (const a of actions.slice(0, -1)) {
          expect(allowed.has(a), `${level} ${t.name} ${a}`).toBe(true);
          expect(mcpGroupToolName(mcpGroupOf(a)!)).toBe(t.name);
          // Listed with its own line, or named on the More: line (ACTION_LISTING).
          if (ACTION_LISTING[a as keyof typeof ACTION_LISTING] === 'more') expect(t.description).toMatch(new RegExp(`\\nMore: (.*, )?${a}(,| —)`));
          else expect(t.description).toContain(`- ${a} {`);
        }
      }
    }
  });

  it('a partial group describes only what the level can use', () => {
    const byName = (level: McpAccountLevel, name: string) => groupTools(level).find(t => t.name === name)!;
    const purpose = (level: McpAccountLevel, name: string) => byName(level, name).description.split('\n')[0];
    // Worker level reaches only the discrepancy ledger in missions.
    const missions = purpose('worker', 'buildd_missions');
    expect(missions).toContain('discrepancy');
    expect(missions.toLowerCase()).not.toContain('missions (');
    expect(missions).not.toContain('initiatives');
    expect(missions).not.toContain('visual review');
    expect(byName('worker', 'buildd_missions').description).not.toContain('manage_missions');
    // ...and only experiments in admin.
    const admin = purpose('worker', 'buildd_admin');
    expect(admin).toContain('xperiments');
    for (const w of ['orkspace', 'skills', 'secrets', 'model tiers']) expect(admin).not.toContain(w);
    // Trigger work is not a claim/complete lifecycle.
    const work = purpose('trigger', 'buildd_work');
    expect(work).not.toContain('claim');
    expect(work).not.toContain('complete');
    // Full level keeps the full purpose.
    expect(purpose('admin', 'buildd_missions')).toContain('initiatives');
    expect(purpose('admin', 'buildd_missions')).toContain('visual review');
  });

  it('every action the level may call is reachable through exactly one listed group', () => {
    for (const level of LEVELS) {
      const listed = groupTools(level).flatMap(t => t.inputSchema.properties.action.enum.filter(a => a !== 'help'));
      expect([...listed].sort()).toEqual([...actionsForLevel(level)].sort());
      expect(new Set(listed).size).toBe(listed.length);
    }
  });

  it('keeps each group tool well under 4k tokens, and missions + runners under 5k', () => {
    const admin = groupTools('admin');
    for (const t of admin) expect(estTokens(t), t.name).toBeLessThan(3000);
    const visual = admin.filter(t => t.name === 'buildd_missions' || t.name === 'buildd_runners');
    expect(visual.reduce((s, t) => s + estTokens(t), 0)).toBeLessThan(5000);
  });

  it('types the params a common question needs, so no help call is needed to find them', () => {
    type P = Record<string, { type?: string; description?: string }>;
    const params = (name: string) => (groupTools('admin').find(t => t.name === name)!.inputSchema.properties.params as unknown as { properties?: P }).properties ?? {};
    const m = params('buildd_missions');
    expect(m.autoSurfaceAudit?.type).toBe('boolean');
    expect(m.workspaceId?.description).toMatch(/awaiting your review/);
    expect(params('buildd_analytics').workspaceId?.description?.toLowerCase()).toContain('browser');
    for (const n of ['taskId', 'status', 'workspaceId']) expect(params('buildd_tasks')[n], n).toBeDefined();
    // Worker level sees only the discrepancy ledger, so no mission fields.
    const w = (groupTools('worker').find(t => t.name === 'buildd_missions')!.inputSchema.properties.params as unknown as { properties?: P }).properties ?? {};
    expect(w.autoSurfaceAudit).toBeUndefined();
  });

  it("the missions description says get_visual_review with only workspaceId lists what awaits review", () => {
    const d = groupTools('admin').find(t => t.name === 'buildd_missions')!.description;
    const line = d.split('\n').find(l => l.startsWith('- get_visual_review'))!;
    expect(line).toMatch(/workspaceId alone/);
  });

  it('warns that update by UUID with workspaceId moves the mission', () => {
    type P = Record<string, { description?: string }>;
    const m = (groupTools('admin').find(t => t.name === 'buildd_missions')!.inputSchema.properties.params as unknown as { properties: P }).properties;
    expect(m.workspaceId.description).toMatch(/update by UUID: moves the mission/);
  });

  it('does not repeat the help line of the description in params', () => {
    for (const t of groupTools('admin')) {
      const props = (t.inputSchema.properties.params as unknown as { properties?: Record<string, { description?: string }> }).properties ?? {};
      for (const [k, v] of Object.entries(props)) expect(v.description ?? '', `${t.name}.${k}`).not.toMatch(/^help:|\. help:/);
    }
  });

  // Budget: 6k tokens (docs/specs/mcp-action-contracts.md). Measured ~4.8k for
  // admin once rare actions moved to More: lines (2026-10-08); the ceiling sits
  // ~300 above that so one more action summary does not turn a parallel PR red.
  it('keeps the whole groups surface under 5.1k tokens', () => {
    const all = tools({ accountLevel: 'admin', isSensitive: false, surface: 'groups' });
    expect(all.reduce((s, t) => s + estTokens(t), 0)).toBeLessThan(5100);
  });

  it('keeps a runner worker session (task token) under 4k tokens', () => {
    const all = tools({ accountLevel: 'worker', isSensitive: false, surface: 'groups', principal: 'task_token' });
    expect(all.reduce((s, t) => s + estTokens(t), 0)).toBeLessThan(4000);
  });

  it('names the rare actions on one More: line per group, and keeps them callable', () => {
    for (const t of groupTools('admin')) {
      const more = t.description.split('\n').filter(l => l.startsWith('More: '));
      const rare = t.inputSchema.properties.action.enum.filter(a => ACTION_LISTING[a as keyof typeof ACTION_LISTING] === 'more');
      if (rare.length === 0) { expect(more, t.name).toEqual([]); continue; }
      expect(more, t.name).toEqual([`More: ${rare.join(', ')} — call help {action} for docs.`]);
      const group = MCP_TOOL_GROUPS.find(g => mcpGroupToolName(g) === t.name)!;
      for (const a of rare) {
        expect(t.description, `${t.name} ${a}`).not.toContain(`- ${a} {`);
        expect(routeGroupToolCall(group, { action: a, params: { x: 1 } }, 'admin')).toEqual({ kind: 'dispatch', action: a, params: { x: 1 } });
        const help = routeGroupToolCall(group, { action: 'help', params: { action: a } }, 'admin');
        expect(help.kind === 'reply' && !help.isError && help.text.startsWith(`${a} params:`), `${a} help`).toBe(true);
      }
    }
  });

  it('is far smaller than the legacy buildd tool', () => {
    const groups = groupTools('admin').reduce((s, t) => s + estTokens(t), 0);
    const [legacy] = tools({ accountLevel: 'admin', isSensitive: false, surface: 'legacy' });
    expect(groups * 3).toBeLessThan(estTokens(legacy));
  });
});

describe('routeGroupToolCall', () => {
  it('dispatches an action of its own group unchanged', () => {
    expect(routeGroupToolCall('missions', { action: 'manage_missions', params: { action: 'list' } }, 'admin'))
      .toEqual({ kind: 'dispatch', action: 'manage_missions', params: { action: 'list' } });
    expect(routeGroupToolCall('work', { action: 'claim_task' }, 'worker'))
      .toEqual({ kind: 'dispatch', action: 'claim_task', params: {} });
  });

  it('folds fields passed beside action into params when params is absent (a flattened call)', () => {
    expect(routeGroupToolCall('missions', { action: 'manage_missions', title: 'x', autoSurfaceAudit: false }, 'admin'))
      .toEqual({ kind: 'dispatch', action: 'manage_missions', params: { title: 'x', autoSurfaceAudit: false } });
    // An explicit params object wins; stray top-level keys are not merged into it.
    expect(routeGroupToolCall('missions', { action: 'manage_missions', params: { action: 'list' }, title: 'x' }, 'admin'))
      .toEqual({ kind: 'dispatch', action: 'manage_missions', params: { action: 'list' } });
  });

  it("names the action for a sub-action passed as the tool's action", () => {
    const r = routeGroupToolCall('missions', { action: 'update', title: 'x' }, 'admin');
    expect(r.kind).toBe('reply');
    if (r.kind !== 'reply') return;
    expect(r.isError).toBe(true);
    expect(r.text).toContain('params.action');
    expect(r.text).toContain('manage_missions');
  });

  it("the tool's action field says a sub-action goes in params", () => {
    const t = tools({ accountLevel: 'admin', isSensitive: false, surface: 'groups' }).find(x => x.name === 'buildd_missions')!;
    expect((t.inputSchema.properties.action as { description?: string }).description).toContain('params');
  });

  it('dispatches above-level actions too, so the handler refuses them as buildd does', () => {
    expect(routeGroupToolCall('admin', { action: 'manage_secrets', params: {} }, 'trigger').kind).toBe('dispatch');
  });

  it('names the right tool for an action from another group, in one line', () => {
    const r = routeGroupToolCall('missions', { action: 'list_tasks' }, 'admin');
    expect(r.kind).toBe('reply');
    if (r.kind !== 'reply') return;
    expect(r.isError).toBe(true);
    expect(r.text).toContain('buildd_tasks');
    expect(r.text.includes('\n')).toBe(false);
  });

  it('does not point a caller at a group tool its level cannot call', () => {
    // manage_missions lives in buildd_missions, which a trigger token is not shown.
    const r = routeGroupToolCall('tasks', { action: 'manage_missions' }, 'trigger');
    expect(r.kind).toBe('reply');
    if (r.kind !== 'reply') return;
    expect(r.isError).toBe(true);
    expect(r.text).toBe('"manage_missions" is not available at your token level (trigger).');
    expect(r.text).not.toContain('buildd_missions');
  });

  it('a wrong-group action the level may call still names its tool', () => {
    const r = routeGroupToolCall('missions', { action: 'list_tasks' }, 'trigger');
    expect(r.kind === 'reply' && r.text.includes('buildd_tasks')).toBe(true);
  });

  it('refuses an unknown action, listing the group', () => {
    const r = routeGroupToolCall('prs', { action: 'nope' }, 'admin');
    expect(r.kind === 'reply' && r.isError && r.text.includes('get_pr')).toBe(true);
  });

  it('help returns the long docs for an action', () => {
    const r = routeGroupToolCall('work', { action: 'help', params: { action: 'create_pr' } }, 'worker');
    expect(r).toEqual({ kind: 'reply', isError: false, text: actionHelp('create_pr')! });
    expect(r.kind === 'reply' && r.text.includes('lede')).toBe(true);
  });

  it('help without an action lists the group', () => {
    const r = routeGroupToolCall('analytics', { action: 'help' }, 'worker');
    expect(r.kind === 'reply' && !r.isError && r.text.includes('explain')).toBe(true);
  });

  it('help for another group works and says where to call it', () => {
    const r = routeGroupToolCall('missions', { action: 'help', params: { action: 'list_tasks' } }, 'admin');
    expect(r.kind === 'reply' && !r.isError && r.text.includes('buildd_tasks')).toBe(true);
  });

  it('help does not document an action above the level', () => {
    const r = routeGroupToolCall('admin', { action: 'help', params: { action: 'manage_secrets' } }, 'worker');
    expect(r.kind === 'reply' && r.isError).toBe(true);
  });

  it('every action is dispatched by its group and refused by every other', () => {
    for (const a of allActions) {
      for (const g of MCP_TOOL_GROUPS) {
        const r = routeGroupToolCall(g, { action: a }, 'admin');
        expect(r.kind, `${g} ${a}`).toBe(mcpGroupOf(a) === g ? 'dispatch' : 'reply');
      }
    }
  });
});

describe('surface choice and instructions', () => {
  it('groups is the standard surface for every session that is not a runner worker', () => {
    expect(mcpToolSurfaceFor({})).toBe('groups');
    expect(mcpToolSurfaceFor({ workerParam: null })).toBe('groups');
    expect(mcpToolSurfaceFor({ workerParam: '' })).toBe('groups');
  });

  it('a runner worker session gets groups only when its runner supports them', () => {
    expect(mcpToolSurfaceFor({ workerParam: 'w', runnerSupportsGroupTools: true })).toBe('groups');
    // A runner that predates group tools (or one that cannot be identified) keeps legacy.
    expect(mcpToolSurfaceFor({ workerParam: 'w', runnerSupportsGroupTools: false })).toBe('legacy');
    expect(mcpToolSurfaceFor({ workerParam: 'w', runnerSupportsGroupTools: null })).toBe('legacy');
    expect(mcpToolSurfaceFor({ workerParam: 'w' })).toBe('legacy');
  });

  it('takes no client or server opt-in: the surface is not a URL or env choice', () => {
    // The old ?tools= / BUILDD_MCP_TOOL_SURFACE inputs no longer exist; extra keys change nothing.
    expect(mcpToolSurfaceFor({ workerParam: 'w', toolsParam: 'groups', serverDefault: 'groups' } as never)).toBe('legacy');
    expect(mcpToolSurfaceFor({ toolsParam: 'legacy', serverDefault: 'legacy' } as never)).toBe('groups');
  });

  it('listMcpTools and the instructions default to groups', () => {
    expect(toolNames({ accountLevel: 'admin', isSensitive: false })).toContain('buildd_tasks');
    expect(toolNames({ accountLevel: 'admin', isSensitive: false })).not.toContain('buildd');
    expect(mcpServerInstructions('admin')).toBe(mcpServerInstructions('admin', 'groups'));
  });

  it('groups instructions name the reachable group tools and help', () => {
    const t = mcpServerInstructions('trigger', 'groups');
    expect(t).toContain('buildd_<group>');
    expect(t).toContain('help');
    expect(t).toContain('tasks');
    expect(t).not.toContain('runners');
  });

  it('groups instructions map "buildd action=X" to the group tool, and never offer the unlisted buildd', () => {
    const t = mcpServerInstructions('admin', 'groups');
    expect(t).toContain('`buildd action=X`');
    expect(t).toContain('group tool that lists it');
    expect(t).not.toContain('still callable');
    expect(t).not.toMatch(/`buildd` \(any action\)/);
  });

  it('legacy instructions are unchanged', () => {
    expect(mcpServerInstructions('admin', 'legacy').startsWith('Buildd is a task coordination system for AI coding agents. Tools: `buildd` (task actions)')).toBe(true);
    expect(mcpServerInstructions('admin', 'legacy')).toContain('gates which `buildd` actions you can call');
  });
});

describe('explicit scope advertisement', () => {
  it('advertises analytics to trigger tokens and hides unrelated capabilities', () => {
    const listed = tools({ accountLevel: 'trigger', isSensitive: false, surface: 'groups', scopes: ['analytics:read'] });
    expect(listed.map(t => t.name)).toContain('buildd_analytics');
    expect(listed.map(t => t.name)).not.toContain('buildd_tasks');
    expect(listed.map(t => t.name)).not.toContain('learn');
    expect(actionsForLevel('trigger', ['analytics:read'])).toContain('get_usage_stats');
  });
  it('does not advertise admin privileges to a restricted admin-level token', () => {
    const listed = tools({ accountLevel: 'admin', isSensitive: false, surface: 'groups', scopes: ['tasks:read'] });
    expect(actionsForLevel('admin', ['tasks:read'])).not.toContain('manage_secrets');
    expect(actionsForLevel('admin', ['tasks:read'])).not.toContain('register_skill');
    expect(listed.map(t => t.name)).toContain('recall');
    expect(listed.map(t => t.name)).not.toContain('learn');
    expect(listed.map(t => t.name)).not.toContain('check_path_claim');
  });
  it('advertises knowledge writes independently from reads', () => {
    const listed = tools({ accountLevel: 'worker', isSensitive: false, surface: 'groups', scopes: ['knowledge:write'] });
    expect(listed.map(t => t.name)).toContain('learn');
    expect(listed.map(t => t.name)).not.toContain('recall');
  });
});

test('scoped group dispatch advertises and helps on mission reads', () => {
  expect(actionsForLevel('worker', ['tasks:read'])).toContain('manage_missions');
  const reply = routeGroupToolCall('analytics', { action: 'help', params: { action: 'get_usage_stats' } }, 'trigger', ['analytics:read']);
  expect(reply.kind).toBe('reply');
  if (reply.kind === 'reply') expect(reply.isError).toBe(false);
});

test('standalone knowledge scopes cannot be bypassed with a help action', () => {
  expect(requiredScopeForMcpTool('recall', { action: 'help' })).toBe('tasks:read');
  expect(requiredScopeForMcpTool('learn', { action: 'help' })).toBe('knowledge:write');
  expect(requiredScopeForMcpTool('buildd_missions', { action: 'manage_missions', params: { action: 'list' } })).toBe('tasks:read');
  expect(requiredScopeForMcpTool('buildd', { action: 'manage_secrets', params: { action: 'list' } })).toBe('secrets');
});

it('scoped sessions describe capabilities instead of legacy levels', () => {
  const instructions = mcpServerInstructions('worker','groups',['analytics:read']);
  expect(instructions).toContain('**Token scopes:** analytics:read');
  expect(instructions).not.toContain('**Token level:**');
});

describe('groups scoped by who is behind the session', () => {
  const ADMIN_ONLY = new Set<string>(adminActions);
  const listedActions = (opts: Parameters<typeof listMcpTools>[0]) =>
    tools(opts).filter(t => t.name.startsWith('buildd_')).flatMap(t => t.inputSchema.properties.action.enum.filter(a => a !== 'help'));

  it('a runner worker session (task token or key) lists no admin-only action', () => {
    for (const principal of ['task_token', 'key'] as const) {
      const listed = listedActions({ accountLevel: 'worker', isSensitive: false, surface: 'groups', principal });
      expect(listed.filter(a => ADMIN_ONLY.has(a)), principal).toEqual([]);
      // ...and its descriptions do not name one either.
      const text = tools({ accountLevel: 'worker', isSensitive: false, surface: 'groups', principal }).map(t => t.description).join('\n');
      for (const a of ADMIN_ONLY) expect(text, `${principal} ${a}`).not.toMatch(new RegExp(`\\b${a}\\b`));
    }
  });

  it('a person at worker level keeps the personal-role path of the skill actions', () => {
    const listed = listedActions({ accountLevel: 'worker', isSensitive: false, surface: 'groups', principal: 'person' });
    expect(listed.filter(a => ADMIN_ONLY.has(a)).sort()).toEqual([...PERSONAL_ROLE_ACTIONS].sort());
  });

  it("an orchestration task token lists only its own mission's admin actions", () => {
    const listed = listedActions({ accountLevel: 'admin', isSensitive: false, surface: 'groups', principal: 'task_token', orchestrationTaskToken: true });
    expect(listed.filter(a => ADMIN_ONLY.has(a)).sort()).toEqual(Object.keys(ORCHESTRATION_TASK_TOKEN_ADMIN_ACTIONS).sort());
    // Help does not document what it cannot call.
    const r = routeGroupToolCall('admin', { action: 'help', params: { action: 'manage_secrets' } }, 'admin', null, { orchestrationTaskToken: true });
    expect(r).toEqual({ kind: 'reply', isError: true, text: '"manage_secrets" is not available at your token level (admin).' });
  });

  it('no reach given keeps the level list (chat and other callers unchanged)', () => {
    for (const level of LEVELS) expect(actionsForLevel(level, null, {})).toEqual(actionsForLevel(level));
  });

  it('the legacy surface is untouched by reach', () => {
    const a = tools({ accountLevel: 'worker', isSensitive: false, surface: 'legacy', principal: 'task_token' });
    const b = tools({ accountLevel: 'worker', isSensitive: false, surface: 'legacy' });
    expect(a).toEqual(b);
  });
});
