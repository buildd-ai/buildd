/**
 * The two tool surfaces under test, built from the real definitions:
 *
 * - `chat`: chat v3's tool set (lib/chat/tools.ts buildChatTools), with its
 *   per-turn group gating (turn.ts turnGroups) and instructions.
 * - `mcp`: what `/api/mcp` advertises to an admin-level agent: the
 *   `buildd_<group>` tools plus recall / learn (or, with `legacy`, the one
 *   `buildd` mega-tool it listed before).
 *
 * A tool is described as { name, description, inputSchema } exactly as the
 * model receives it, so static sizes and the proxy share one source.
 */
import { z } from 'zod';
import { buildChatTools, CORE_GROUPS, FALLBACK_GROUPS, needsApproval, toolNamesForGroups } from '../../../src/lib/chat/tools';
import { ALL_CHAT_TOOL_SPECS, isExposed, opSpec, TOOL_GROUPS, type ToolGroup } from '../../../src/lib/chat/registry';
import type { BuilddAction } from '@buildd/core/mcp-tools';
import { chatInstructions } from '../../../src/lib/chat/instructions';
import { renderChatContextBlock } from '../../../src/lib/chat/context-block';
import { listMcpTools, mcpServerInstructions, routeGroupToolCall, type McpToolSurface } from '../../../src/app/api/mcp/tools';
import { mcpGroupOfToolName } from '@buildd/core/mcp-tool-groups';

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

export function mcpToolDefs(surface: McpToolSurface = 'groups'): ToolDef[] {
  return (listMcpTools({ accountLevel: 'admin', isSensitive: false, surface }) as Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>)
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
  return `${chatInstructions()}\n\n${renderChatContextBlock({
    now: args.now ?? new Date(),
    timeZone: args.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    conversationId: crypto.randomUUID(),
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
 * The MCP class of each action chat does not expose (not in the chat
 * registry, or every op deferred there). Chat's `deferred` means "not offered
 * in chat yet", not "a write", so it can't decide an MCP call. Everything
 * chat exposes is classified by the registry's own op class instead; the
 * safety test checks each MCP action is classified by exactly one of the two.
 * Multi-op actions listed here are writes whole (fail closed).
 */
export const MCP_ONLY_CLASS: Partial<Record<BuilddAction, 'read' | 'write'>> = {
  get_usage_stats: 'read',
  get_manifest_coverage: 'read',
  get_path_claim_stats: 'read',
  get_decision_stats: 'read',
  dispatch_health: 'read',
  resolve_capability: 'read',
  merge_pr: 'write',
  close_pr: 'write',
  update_pr: 'write',
  request_pr_review: 'write',
  update_artifact: 'write',
  manage_model_tiers: 'write',
  manage_secrets: 'write',
  claim_task: 'write',
  update_progress: 'write',
  receive_messages: 'write',
  complete_task: 'write',
  create_pr: 'write',
  emit_event: 'write',
  upload_artifact: 'write',
  get_page_source: 'read',
  deploy: 'write',
  record_pr_supersession: 'write',
  post_note: 'write',
  suggest_schedule_update: 'write',
};

/**
 * Would this call change something? Chat: the registry's approval rule.
 * MCP: the chat registry's op class when chat exposes the action, else
 * MCP_ONLY_CLASS; an unknown action or op counts as a write.
 */
export function isWrite(surface: Surface, tool: string, input: Record<string, unknown>): boolean {
  if (surface === 'chat') return needsApproval(tool, input);
  if (tool === 'recall') return false;
  if (tool === 'learn') return true;
  if (tool !== 'buildd' && !mcpGroupOfToolName(tool)) return true;
  const action = String(input.action ?? '');
  if (action === 'help' && tool !== 'buildd') return false;
  const params = (input.params && typeof input.params === 'object' ? input.params : {}) as Record<string, unknown>;
  const spec = ALL_CHAT_TOOL_SPECS[action];
  if (!spec || !isExposed(spec)) return (MCP_ONLY_CLASS as Record<string, string>)[action] !== 'read';
  const s = opSpec(action, params);
  return !s || s.spec.class !== 'read';
}

/**
 * What `/api/mcp` answers a group-tool call without running anything: help,
 * an unknown action, an action of another group. The proxy returns this
 * before classifying, so a malformed call gets the server's real error
 * (which the model can recover from) instead of "writes are not run".
 * Null when the router would dispatch the action, or for any other tool.
 */
export function groupRouterReply(tool: string, input: Record<string, unknown>): { text: string; isError: boolean } | null {
  const group = mcpGroupOfToolName(tool);
  if (!group) return null;
  const routed = routeGroupToolCall(group, input, 'admin');
  return routed.kind === 'reply' ? { text: routed.text, isError: routed.isError } : null;
}

/** `--mcp-tools legacy|groups`: which tool list `/api/mcp` advertises (default groups). */
export function parseMcpTools(v: string | undefined): McpToolSurface {
  if (v === undefined || v === 'groups') return 'groups';
  if (v === 'legacy') return 'legacy';
  throw new Error(`--mcp-tools must be legacy or groups, got ${v}`);
}

/** A run's id: time, surface (with its routing or MCP tool list), model, label. */
export function runIdFor(a: { at: Date; surface: Surface; mcpTools: McpToolSurface; routing: string; model: string; label?: string }): string {
  const variant = a.surface === 'chat' ? a.routing : a.mcpTools;
  return `${a.at.toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${a.surface}-${variant}-${a.model}${a.label ? `-${a.label}` : ''}`;
}

/** `/api/mcp`'s server `instructions` at admin level (route.ts), sent on initialize. */
export const mcpServerInstructionsFor = (surface: McpToolSurface): string => mcpServerInstructions('admin', surface);
