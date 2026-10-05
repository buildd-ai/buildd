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
