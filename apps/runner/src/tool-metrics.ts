/**
 * Per-worker tool-call histogram.
 *
 * The CBM counters (cbmToolCounts / cbmFileAccessCounts) only bucket
 * `mcp__codebase-memory__*` and Read/Grep/Glob, so Edit/Write/Bash/Task and
 * every non-CBM MCP server were invisible to any usage rollup — and
 * `workers.mcpCalls` keeps only the last 100 calls, so even MCP totals were a
 * floor rather than a count. This records one increment per tool_use block
 * under its exact SDK tool name: counts, not events, so nothing is truncated
 * and the payload stays a few hundred bytes regardless of session length.
 *
 * Keys are the raw SDK tool names (`Bash`, `mcp__buildd__buildd`, …). The
 * server splits `mcp__<server>__<tool>` when it wants a per-server rollup —
 * pre-aggregating here would throw away the tool grain.
 */

/**
 * Max distinct tool names retained per worker. Tool names come from the
 * session's registered tools, so real cardinality is bounded (tens); this only
 * guards against a misbehaving MCP server synthesizing names per call.
 */
export const MAX_TOOL_KEYS = 200;

/** Bucket for calls beyond MAX_TOOL_KEYS distinct names. */
export const OTHER_TOOL_KEY = '__other__';

/** Increment `toolName`'s count in place. No-ops on an empty name. */
export function recordToolCall(counts: Record<string, number>, toolName: string): void {
  if (!toolName) return;
  const known = counts[toolName] !== undefined;
  const key = known || Object.keys(counts).length < MAX_TOOL_KEYS ? toolName : OTHER_TOOL_KEY;
  counts[key] = (counts[key] ?? 0) + 1;
}

/** Total calls across all tools. */
export function totalToolCalls(counts: Record<string, number>): number {
  let total = 0;
  for (const n of Object.values(counts)) total += n;
  return total;
}
