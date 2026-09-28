/**
 * Tool visibility rules for the remote MCP server.
 *
 * These assert the two gates that decide what a caller is even told exists:
 * token level, and whether the workspace is data-class `sensitive`. Both were
 * previously only reachable through a full HTTP request and had no coverage.
 */

import { describe, it, expect } from 'bun:test';
import { allActions } from '@buildd/core/mcp-tools';
import { actionHelp, MCP_TOOL_GROUPS, mcpGroupOf, mcpGroupToolName } from '@buildd/core/mcp-tool-groups';
import {
  actionsForLevel, groupActionsForLevel, listMcpTools, mcpServerInstructions, mcpToolSurfaceFor, routeGroupToolCall,
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
          expect(t.description).toContain(`- ${a} {`);
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
    expect(params('buildd_runners').workspaceId?.description?.toLowerCase()).toContain('browser');
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

  it('keeps the whole groups surface under 6k tokens', () => {
    const all = tools({ accountLevel: 'admin', isSensitive: false, surface: 'groups' });
    expect(all.reduce((s, t) => s + estTokens(t), 0)).toBeLessThan(6000);
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
    const r = routeGroupToolCall('runners', { action: 'help' }, 'worker');
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
  it('legacy is the default for every session; groups is opt-in', () => {
    expect(mcpToolSurfaceFor({})).toBe('legacy');
    expect(mcpToolSurfaceFor({ workerParam: 'w' })).toBe('legacy');
    expect(mcpToolSurfaceFor({ toolsParam: 'bogus' })).toBe('legacy');
    expect(mcpToolSurfaceFor({ toolsParam: 'legacy' })).toBe('legacy');
    expect(mcpToolSurfaceFor({ toolsParam: 'groups' })).toBe('groups');
    expect(mcpToolSurfaceFor({ workerParam: 'w', toolsParam: 'groups' })).toBe('groups');
  });

  it('the server default flag moves non-worker sessions to groups, never runner workers', () => {
    expect(mcpToolSurfaceFor({ serverDefault: 'groups' })).toBe('groups');
    expect(mcpToolSurfaceFor({ serverDefault: 'groups', workerParam: 'w' })).toBe('legacy');
    expect(mcpToolSurfaceFor({ serverDefault: 'groups', toolsParam: 'legacy' })).toBe('legacy');
    expect(mcpToolSurfaceFor({ serverDefault: 'bogus' })).toBe('legacy');
  });

  it('listMcpTools and the instructions default to legacy', () => {
    expect(toolNames({ accountLevel: 'admin', isSensitive: false })).toContain('buildd');
    expect(toolNames({ accountLevel: 'admin', isSensitive: false })).not.toContain('buildd_tasks');
    expect(mcpServerInstructions('admin')).toBe(mcpServerInstructions('admin', 'legacy'));
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
