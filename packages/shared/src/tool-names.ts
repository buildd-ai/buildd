/**
 * One name per tool, whichever backend reported the call.
 *
 * Backends name the same tool differently: Codex surfaces an MCP server's tools
 * through its own `codex_apps` server as `<server>.<tool>`
 * (`mcp__codex_apps__buildd.recall`), and some sessions report built-ins in
 * lower case (`bash`). Counted under their raw names, one tool shows as two
 * rows and its breakdowns (Bash buckets, buildd actions) attach to only one.
 *
 * The runner canonicalises at capture; the web app canonicalises stored
 * histograms on read, so older rows merge too.
 */

/** Built-ins that have been reported in a different case. */
const BUILT_IN_BY_LOWER: Record<string, string> = {
  bash: 'Bash',
  read: 'Read',
  edit: 'Edit',
  write: 'Write',
  grep: 'Grep',
  glob: 'Glob',
};

/** Codex re-exposes other MCP servers' tools under this server as `<server>.<tool>`. */
const CODEX_APPS_PREFIX = 'mcp__codex_apps__';

export function canonicalToolName(name: string): string {
  if (!name) return name;
  if (!name.startsWith('mcp__')) return BUILT_IN_BY_LOWER[name.toLowerCase()] ?? name;
  if (name.startsWith(CODEX_APPS_PREFIX)) {
    const rest = name.slice(CODEX_APPS_PREFIX.length);
    const dot = rest.indexOf('.');
    if (dot > 0 && dot < rest.length - 1) return `mcp__${rest.slice(0, dot)}__${rest.slice(dot + 1)}`;
  }
  return name;
}

/**
 * The buildd MCP server's group tools (`buildd_<group>`), one per action area.
 * @buildd/core/mcp-tool-groups places each action in one of these; it is
 * declared here so the runner and client bundles can match tool names without
 * importing the action registry.
 */
export const BUILDD_MCP_TOOL_GROUPS = ['missions', 'tasks', 'work', 'prs', 'runners', 'analytics', 'artifacts', 'schedules', 'admin'] as const;

/**
 * The legacy one-tool surface's SDK name. Only a runner that predates group
 * tools is still served it. Remove with the legacy surface (apps/web/src/app/api/mcp/tools.ts).
 */
export const LEGACY_BUILDD_ACTION_TOOL = 'mcp__buildd__buildd';

/**
 * Every SDK tool name that takes `{action, params}` and dispatches a buildd
 * action: the legacy `mcp__buildd__buildd` and each `mcp__buildd__buildd_<group>`.
 * Not `buildd_memory`, `recall` or `learn`.
 */
export const BUILDD_ACTION_TOOL_NAMES: readonly string[] = [
  LEGACY_BUILDD_ACTION_TOOL,
  ...BUILDD_MCP_TOOL_GROUPS.map(g => `mcp__buildd__buildd_${g}`),
];

const BUILDD_ACTION_TOOL_SET: ReadonlySet<string> = new Set(BUILDD_ACTION_TOOL_NAMES);

/**
 * Is this tool call a buildd action call, whichever surface served it? Match a
 * buildd action by this plus `input.action`, never by one exact tool name: the
 * action `create_pr` arrives as `mcp__buildd__buildd_work` on the group surface.
 */
export function isBuilddActionTool(name: string | undefined | null): boolean {
  return !!name && BUILDD_ACTION_TOOL_SET.has(canonicalToolName(name));
}

/**
 * SDK hook matcher for every buildd action tool. Word characters and `|` only,
 * so it reads as an exact-name list (and as a regex alternation).
 */
export const BUILDD_ACTION_TOOL_MATCHER = BUILDD_ACTION_TOOL_NAMES.join('|');
