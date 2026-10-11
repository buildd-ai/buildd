/**
 * Per-call event capture for the buildd MCP tool's `action` param.
 *
 * The buildd MCP server multiplexes ~55 actions through a handful of SDK tool
 * names (`mcp__buildd__buildd_<group>`, or the legacy `mcp__buildd__buildd`), so
 * the tool histogram (tool-metrics.ts) can only show one bar per tool. An aggregate count map can't fix that either:
 * whether a call like `create_pr` / `create_artifact` / `upload_artifact` /
 * `merge_pr` is RUNTIME (the platform forces it) or WORK (the agent chose it)
 * depends on the CALLING TASK's `outputRequirement`/`loopConfig`, not the
 * action name — so classifying a call requires joining it to its task at
 * query time, which requires a per-call event (action + when), not a count.
 *
 * This module only extracts the action name from a tool_use block; the
 * caller (workers.ts) buffers events and worker-sync.ts drains/ships them,
 * the same way pendingErrorTraces is buffered and drained.
 */

import { BUILDD_ACTION_TOOL_MATCHER, BUILDD_ACTION_TOOL_NAMES, LEGACY_BUILDD_ACTION_TOOL, isBuilddActionTool } from '@buildd/shared';

/**
 * SDK hook matcher for every tool that dispatches a buildd action: the group
 * tools (`mcp__buildd__buildd_<group>`) and the legacy `mcp__buildd__buildd`.
 * A hook still checks the name with isBuilddActionTool and reads input.action.
 */
export const BUILDD_MCP_TOOL_MATCHER = BUILDD_ACTION_TOOL_MATCHER;

/**
 * A role's subagent `tools` list that names the legacy `mcp__buildd__buildd`
 * meant "every buildd action". Group tools are the standard surface now, so
 * that name alone would leave the subagent with no buildd tool: widen it to
 * every action tool. Role rows seeded before group tools (and custom roles)
 * still carry only the legacy name. Lists without it are returned unchanged.
 */
export function withBuilddActionTools(tools: readonly string[]): string[] {
  if (!tools.includes(LEGACY_BUILDD_ACTION_TOOL)) return [...tools];
  return [...new Set([...tools, ...BUILDD_ACTION_TOOL_NAMES])];
}

/** Extract the buildd MCP action name from a tool_use block, or null if this isn't one. */
export function extractBuilddAction(toolName: string, input: unknown): string | null {
  if (!isBuilddActionTool(toolName)) return null;
  const action = (input as { action?: unknown } | null | undefined)?.action;
  return typeof action === 'string' && action ? action : null;
}
