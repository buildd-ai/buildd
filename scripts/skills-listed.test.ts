import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';

/**
 * CLAUDE.md's Skills list must name every **git-tracked** skill, and only those.
 *
 * Why this gate exists: the list had drifted in both directions at once — it
 * named skills the repo does not ship while omitting two that it does. A skill
 * nobody can find is a skill nobody uses, so the index is the whole delivery
 * mechanism, and prose indexes rot silently.
 *
 * **Why `git ls-files` and not the filesystem.** `.claude/` is gitignored, so a
 * checkout legitimately holds skills that are not in the repo — a machine-local
 * one, or a platform skill the runner materialised. The first version of this
 * gate read the directory, which meant it passed in CI and in a fresh worktree
 * and FAILED for anyone with a local skill: it punished untracked state instead
 * of checking the claim. `git ls-files` is what the repo actually ships, which is
 * what the list is documenting.
 */

const repoRoot = join(__dirname, '..');
const skillsDir = join(repoRoot, '.claude', 'skills');

/**
 * Skill slugs the repo ships: a tracked `.claude/skills/<slug>/SKILL.md`.
 *
 * `-z` and a NUL split rather than newlines, because git quotes paths
 * containing unusual characters when it prints them line-wise, and a quoted
 * path would silently not match the slug.
 */
function trackedSkills(): string[] {
  const out = execFileSync('git', ['ls-files', '-z', '--', '.claude/skills'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  const slugs = out
    .split('\0')
    .filter(Boolean)
    .map(p => /^\.claude\/skills\/([^/]+)\/SKILL\.md$/.exec(p)?.[1])
    .filter((s): s is string => !!s);
  return [...new Set(slugs)].sort();
}

/** Skill directory names referenced by the Skills section of CLAUDE.md. */
function skillsInClaudeMd(): string[] {
  const md = readFileSync(join(repoRoot, 'CLAUDE.md'), 'utf8');
  const start = md.indexOf('\n## Skills');
  expect(start).toBeGreaterThan(-1);
  const rest = md.slice(start + 1);
  const end = rest.indexOf('\n## ');
  const section = end === -1 ? rest : rest.slice(0, end);
  return [...section.matchAll(/`\.claude\/skills\/([^/`]+)\/`/g)]
    .map(m => m[1])
    .sort();
}

describe('CLAUDE.md Skills index', () => {
  // A gate over an empty set reports the same "0 problems" as a healthy one.
  it('found tracked skills and a Skills section to compare against', () => {
    expect(trackedSkills().length).toBeGreaterThan(0);
    expect(skillsInClaudeMd().length).toBeGreaterThan(0);
  });

  it('lists every skill the repo ships', () => {
    const missing = trackedSkills().filter(s => !skillsInClaudeMd().includes(s));
    expect(missing).toEqual([]);
  });

  it('lists no skill the repo does not ship', () => {
    // The half that had rotted: entries pointing at skills the repo does not
    // ship, so a reader would invoke something that never loads for them.
    const phantom = skillsInClaudeMd().filter(s => !trackedSkills().includes(s));
    expect(phantom).toEqual([]);
  });

  it('gives every skill YAML frontmatter with a name and a description', () => {
    // The runner writes skill bundles to ~/.claude/skills/<slug>/ for native SDK
    // discovery, and that discovery reads the frontmatter. A SKILL.md without it
    // is present but invisible.
    const broken: string[] = [];
    for (const s of trackedSkills()) {
      const body = readFileSync(join(skillsDir, s, 'SKILL.md'), 'utf8');
      const fm = /^---\n([\s\S]*?)\n---/.exec(body);
      if (!fm || !/\bname:\s*\S/.test(fm[1]) || !/\bdescription:\s*\S/.test(fm[1])) {
        broken.push(s);
      }
    }
    expect(broken).toEqual([]);
  });

  it('gives every skill a frontmatter name matching its directory', () => {
    // `/skill-name` resolves by the frontmatter name; a mismatch means the doc
    // link and the invocation disagree.
    const mismatched: string[] = [];
    for (const s of trackedSkills()) {
      const body = readFileSync(join(skillsDir, s, 'SKILL.md'), 'utf8');
      const name = /^---\n[\s\S]*?\bname:\s*"?([^"\n]+?)"?\s*$/m.exec(body)?.[1];
      if (name !== s) mismatched.push(`${s} (frontmatter: ${name ?? 'none'})`);
    }
    expect(mismatched).toEqual([]);
  });
});
