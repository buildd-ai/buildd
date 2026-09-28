/**
 * The two tool surfaces under test, built from the real definitions:
 *
 * - `chat`: chat v3's tool set (lib/chat/tools.ts buildChatTools), with its
 *   per-turn group gating (turn.ts turnGroups) and instructions.
 * - `mcp`: what `/api/mcp` advertises to an admin-level agent (the `buildd`
 *   mega-tool plus recall / learn).
 *
 * A tool is described as { name, description, inputSchema } exactly as the
 * model receives it, so static sizes and the proxy share one source.
 */
import { z } from 'zod';
import { buildChatTools, CORE_GROUPS, FALLBACK_GROUPS, needsApproval, toolNamesForGroups } from '../../../src/lib/chat/tools';
import { ALL_CHAT_TOOL_SPECS, opSpec, TOOL_GROUPS, type ToolGroup } from '../../../src/lib/chat/registry';
import { CHAT_INSTRUCTIONS } from '../../../src/lib/chat/instructions';
import { renderChatContextBlock } from '../../../src/lib/chat/context-block';
import { listMcpTools } from '../../../src/app/api/mcp/tools';

export type Surface = 'chat' | 'mcp';

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  group?: ToolGroup;
}

export function chatToolDefs(opts: { allowWrites?: boolean; canAdmin?: boolean } = {}): ToolDef[] {
  const tools = buildChatTools({
    ctx: {} as never,
    makeApi: () => (async () => ({})) as never,
    allowWrites: opts.allowWrites ?? true,
    canAdmin: opts.canAdmin ?? true,
    authorizedToolCallIds: new Set(),
  });
  return Object.entries(tools).map(([name, t]) => {
    const schema = z.toJSONSchema((t as { inputSchema: z.ZodType }).inputSchema) as Record<string, unknown>;
    delete schema.$schema;
    return { name, description: (t as { description: string }).description, inputSchema: schema, group: ALL_CHAT_TOOL_SPECS[name]?.group };
  });
}

export function mcpToolDefs(): ToolDef[] {
  return (listMcpTools({ accountLevel: 'admin', isSensitive: false }) as Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>)
    .map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
}

/**
 * Chat's groups for a turn, as turn.ts picks them: core + the routed area
 * (else the fallback set), admin only for owners/admins. `all` sends every tool.
 */
export function chatGroups(area: ToolGroup | null | 'all', canAdmin = true): Set<ToolGroup> {
  if (area === 'all') return new Set(TOOL_GROUPS.filter(g => canAdmin || g !== 'admin'));
  const g = new Set<ToolGroup>(CORE_GROUPS);
  for (const a of area ? [area] : FALLBACK_GROUPS) g.add(a);
  if (!canAdmin) g.delete('admin');
  return g;
}

export function activeChatDefs(defs: ToolDef[], groups: Set<ToolGroup>): ToolDef[] {
  const names = new Set(toolNamesForGroups(Object.fromEntries(defs.map(d => [d.name, d])) as never, groups));
  return defs.filter(d => names.has(d.name));
}

/** Chat's system prompt for one turn (unscoped unless a workspace is pinned). */
export function chatSystemPrompt(args: {
  workspace: { id: string; name: string } | null;
  workspaces: Array<{ id: string; name: string }>;
  now?: Date;
  timeZone?: string;
  tier?: string;
}): string {
  return `${CHAT_INSTRUCTIONS}\n\n${renderChatContextBlock({
    now: args.now ?? new Date(),
    timeZone: args.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    conversationId: '00000000-0000-4000-8000-000000000000',
    workspace: args.workspace ? { ...args.workspace, source: 'pinned' } : null,
    ...(args.workspace ? {} : { workspaces: args.workspaces.map(w => ({ ...w, lastActiveAt: new Date().toISOString() })) }),
    user: { name: null, teamRole: 'owner', isOperator: true },
    tier: args.tier ?? 'standard',
  })}`;
}

/**
 * An external agent's system prompt for the MCP surface: the server's own
 * `instructions` block is what a connected agent gets, plus one line of role.
 */
export const MCP_SYSTEM_PROMPT = 'You are an assistant with access to buildd, a task coordination system for AI coding agents, through its MCP tools. Answer the user from live buildd state; call the tools rather than guess. Be brief.';

/**
 * Would this call change something? Chat: the registry's approval rule.
 * MCP: the chat registry's class for the same action/op; anything the
 * registry doesn't know (worker-only lifecycle actions) counts as a write.
 */
export function isWrite(surface: Surface, tool: string, input: Record<string, unknown>): boolean {
  if (surface === 'chat') return needsApproval(tool, input);
  if (tool === 'recall') return false;
  if (tool === 'learn') return true;
  if (tool !== 'buildd') return true;
  const action = String(input.action ?? '');
  const params = (input.params && typeof input.params === 'object' ? input.params : {}) as Record<string, unknown>;
  if (!ALL_CHAT_TOOL_SPECS[action]) return true;
  const s = opSpec(action, params);
  return !s || s.spec.class !== 'read';
}

/** `/api/mcp`'s server `instructions` at admin level (route.ts), sent on initialize. */
export const MCP_SERVER_INSTRUCTIONS = `Buildd is a task coordination system for AI coding agents. Tools: \`buildd\` (task actions), \`recall\` (read knowledge), \`learn\` (write knowledge). \`buildd_memory\` is deprecated.

**Token level:** admin — gates which \`buildd\` actions you can call (trigger ⊂ worker ⊂ admin). A call outside your level returns \`{"error":"forbidden",...}\`, not an expired-token error.

**Before your first task action**, load the buildd-mcp-consumer skill for the full workflow (claim → progress → PR → artifact → learn → complete), the blocked-vs-question rule, friction reporting, and branch strategy. No skill installed? Read the \`buildd://workspace/skills\` resource for the same content, or ask a human to install it.`;
