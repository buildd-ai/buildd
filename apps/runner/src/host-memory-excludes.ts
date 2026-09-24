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
