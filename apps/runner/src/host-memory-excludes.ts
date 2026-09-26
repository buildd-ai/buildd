/**
 * `claudeMdExcludes` patterns that keep the runner host's personal memory out
 * of worker sessions.
 *
 * Worker sessions need the `user` setting source: buildd skills are synced into
 * `~/.claude/skills` (see skills.ts) and discovered through it. But that source
 * also loads the host operator's `~/.claude/CLAUDE.md` and `~/.claude/rules/`,
 * which carry instructions meant for the operator's own sessions — workers
 * followed them. Excluding the memory files keeps skills and settings intact.
 *
 * The CLI reads user memory from `CLAUDE_CONFIG_DIR` when set, so an inherited
 * config dir is excluded too. Patterns are absolute paths with forward slashes
 * (the CLI normalizes candidate paths the same way before matching).
 */
export function hostUserMemoryExcludes(homeDir: string, claudeConfigDir: string | undefined): string[] {
  const dirs = [`${homeDir}/.claude`];
  if (claudeConfigDir) dirs.push(claudeConfigDir);
  const out = new Set<string>();
  for (const raw of dirs) {
    const dir = raw.replaceAll('\\', '/').replace(/\/+$/, '');
    out.add(`${dir}/CLAUDE.md`);
    out.add(`${dir}/rules/**`);
  }
  return [...out];
}

/**
 * `claudeMdExcludes` patterns for project memory in the directories between a
 * worktree and the primary clone that contains it.
 *
 * Worktrees are nested at `<primary>/.buildd-worktrees/<slug>`, and the CLI
 * loads CLAUDE.md from the cwd AND every ancestor. So every worker session got
 * the primary clone's CLAUDE.md in its system prompt, headed
 * `Contents of <primary>/CLAUDE.md (project instructions…)` — the primary path,
 * presented as the project, carrying whatever stale copy that checkout had on
 * disk. Agents followed it there (`cd <primary> && …`). The worktree's own
 * CLAUDE.md is the same file at the task's base, so nothing is lost.
 *
 * Returns [] when the session is not in a nested worktree.
 */
export function primaryCloneMemoryExcludes(cwd: string, primaryPath: string): string[] {
  const norm = (p: string) => p.replaceAll('\\', '/').replace(/\/+$/, '');
  const wt = norm(cwd);
  const primary = norm(primaryPath);
  if (!primary || wt === primary || !wt.startsWith(primary + '/')) return [];
  const out: string[] = [];
  let dir = wt.slice(0, wt.lastIndexOf('/'));
  while (dir.length >= primary.length) {
    out.push(`${dir}/CLAUDE.md`, `${dir}/CLAUDE.local.md`, `${dir}/.claude/CLAUDE.md`, `${dir}/.claude/rules/**`);
    if (dir === primary) break;
    dir = dir.slice(0, dir.lastIndexOf('/'));
  }
  return out;
}
