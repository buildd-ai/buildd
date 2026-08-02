/**
 * MCP env token substitution for worker-scoped values.
 *
 * Role-level MCP server configs (stored in the skill record's mcpServers field) are
 * authored once and shared across all workers. Some values must be unique per worker
 * (e.g. a cache directory keyed to the worker ID so concurrent workers don't share
 * state). Placeholder tokens in the env values are resolved at worker launch time.
 *
 * ## Supported tokens
 *
 * | Token | Resolved to |
 * |-------|-------------|
 * | `__WORKER_ID__` | The worker's UUID |
 * | `__WORKTREE_PATH__` | Absolute path of the worker's git worktree (sessionCwd) |
 * | `__WORKSPACE_DIR__` | Alias for `__WORKTREE_PATH__` (spec convention) |
 *
 * ## Error behaviour
 *
 * An unresolved token (a `__TOKEN__` pattern with no matching entry) is a hard
 * error at launch — the runner throws before starting the SDK session. Passing a
 * literal unresolved token to the MCP subprocess silently reintroduces the shared-
 * state failure the per-worker cache design was built to prevent.
 */

export interface McpEnvContext {
  workerId: string;
  worktreePath: string;
}

const KNOWN_TOKENS: Record<string, (ctx: McpEnvContext) => string> = {
  __WORKER_ID__: (ctx) => ctx.workerId,
  __WORKTREE_PATH__: (ctx) => ctx.worktreePath,
  __WORKSPACE_DIR__: (ctx) => ctx.worktreePath,
};

/**
 * Resolve per-worker placeholder tokens in an MCP server's `env` record.
 *
 * Replaces all `__TOKEN__` occurrences (case-sensitive, uppercase) with
 * worker-specific values. Throws on any unrecognised token so misconfigurations
 * surface at launch rather than silently poisoning the worker's environment.
 */
export function resolveMcpEnvTokens(
  env: Record<string, string>,
  context: McpEnvContext,
): Record<string, string> {
  const resolved: Record<string, string> = {};

  for (const [key, raw] of Object.entries(env)) {
    let value = raw;
    for (const [token, resolver] of Object.entries(KNOWN_TOKENS)) {
      value = value.split(token).join(resolver(context));
    }

    const unresolved = [...value.matchAll(/__[A-Z][A-Z0-9_]*__/g)].map(m => m[0]);
    if (unresolved.length > 0) {
      throw new Error(
        `Unresolved MCP env token(s) in "${key}": ${unresolved.join(', ')}. ` +
        `Supported tokens: __WORKER_ID__, __WORKTREE_PATH__, __WORKSPACE_DIR__`,
      );
    }

    resolved[key] = value;
  }

  return resolved;
}
