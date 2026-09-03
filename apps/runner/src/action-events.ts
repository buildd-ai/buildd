/**
 * Per-call event capture for the buildd MCP tool's `action` param.
 *
 * `mcp__buildd__buildd` multiplexes ~55 actions through one SDK tool name, so
 * the tool histogram (tool-metrics.ts) can only ever show one aggregate bar
 * for the whole surface. An aggregate count map can't fix that either:
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

/** SDK tool name the buildd MCP server multiplexes ~55 actions through. */
export const BUILDD_MCP_TOOL_NAME = 'mcp__buildd__buildd';

/** Extract the buildd MCP action name from a tool_use block, or null if this isn't one. */
export function extractBuilddAction(toolName: string, input: unknown): string | null {
  if (toolName !== BUILDD_MCP_TOOL_NAME) return null;
  const action = (input as { action?: unknown } | null | undefined)?.action;
  return typeof action === 'string' && action ? action : null;
}
