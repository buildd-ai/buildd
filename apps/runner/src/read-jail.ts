/**
 * Read-jail confinement helpers for agent sessions (Tier 2 isolation).
 *
 * Restricts agent reads to the worker's worktree plus essential system paths.
 * Blocks:
 *   - Sibling worktrees under the same repo clone (other tenants' code)
 *   - ~/.buildd/ (runner's own API key and worker-state files)
 *   - $TMPDIR/buildd-codex-homes/ (per-worker Codex auth.json with OAuth/API key)
 *   - $TMPDIR/claude-cfg-XXXXXX/ (per-worker Claude credential dirs)
 *
 * Enforcement for the Claude backend is via the PreToolUse hook in hook-factory.ts,
 * covering Read, Glob, and Grep tool calls. Bash shell commands are not fully
 * intercepted at this layer — use bwrap or Landlock for kernel-level enforcement.
 */

import { homedir, tmpdir as ostmpdir } from 'os';
import { normalize, sep, resolve as resolvePath } from 'path';

/**
 * Build the list of absolute path prefixes an agent MUST NOT be able to read.
 *
 * @param repoPath  Absolute path to the repo root (parent of .buildd-worktrees/)
 */
export function buildReadJailDeniedPrefixes(repoPath: string): string[] {
  return [
    // Runner coordination key and worker-state files
    normalize(`${homedir()}/.buildd`),
    // All worktrees for this repo clone (sibling branches = other tenants)
    normalize(`${repoPath}/.buildd-worktrees`),
    // Codex per-worker credential homes: $TMPDIR/buildd-codex-homes/<workerId>/auth.json
    normalize(`${ostmpdir()}/buildd-codex-homes`),
  ];
}

/**
 * Prefix pattern that identifies per-worker Claude config dirs in $TMPDIR.
 * Created by claude-auth.ts via mkdtempSync(tmpdir(), 'claude-cfg-').
 */
export const CLAUDE_CFG_TMP_PREFIX = 'claude-cfg-';

/**
 * Return true if `filePath` is denied by the read-jail.
 *
 * The policy is:
 *   - Always ALLOW reads inside `worktreePath` (the worker's own checkout).
 *   - DENY reads matching any entry in `deniedPrefixes`.
 *   - DENY reads inside any $TMPDIR/claude-cfg-XXXXXX/ directory (other workers'
 *     ephemeral Claude credential dirs).
 *   - Allow everything else (system paths, toolchain, etc.).
 *
 * @param filePath       Absolute or ~-prefixed path the agent wants to read.
 * @param worktreePath   The agent's own worktree — reads here are always allowed.
 * @param deniedPrefixes Result of buildReadJailDeniedPrefixes().
 */
export function isPathDeniedByReadJail(
  filePath: string,
  worktreePath: string,
  deniedPrefixes: string[],
): boolean {
  // Expand ~ shorthand
  const expanded = filePath.startsWith('~/')
    ? `${homedir()}/${filePath.slice(2)}`
    : filePath;

  const abs = normalize(expanded);
  const wt = normalize(worktreePath);

  // Own worktree → always allowed (checked first for fast path)
  if (abs === wt || abs.startsWith(wt + sep)) {
    return false;
  }

  // Explicit deny-list prefixes
  for (const prefix of deniedPrefixes) {
    if (abs === prefix || abs.startsWith(prefix + sep)) {
      return true;
    }
  }

  // Per-worker Claude config dirs: $TMPDIR/claude-cfg-XXXXXX/
  const tmp = normalize(ostmpdir());
  if (abs.startsWith(tmp + sep)) {
    const rest = abs.slice(tmp.length + 1); // e.g. "claude-cfg-abc123/settings.json"
    const firstSegment = rest.split(sep)[0];
    if (firstSegment.startsWith(CLAUDE_CFG_TMP_PREFIX)) {
      return true;
    }
  }

  return false;
}

/**
 * Resolve a raw path from a tool call to an absolute path.
 * Relative paths are resolved against the worktree root.
 */
export function resolveToolPath(rawPath: string, worktreePath: string): string {
  if (rawPath.startsWith('/') || rawPath.startsWith('~')) {
    return rawPath;
  }
  return resolvePath(worktreePath, rawPath);
}
