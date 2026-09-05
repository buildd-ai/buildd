import { describe, it, expect } from 'bun:test';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';

/**
 * CLAUDE.md's Skills list must name every skill that exists, and only those.
 *
 * Why this gate exists: the list had drifted in both directions at once. It named
 * `ui-audit`, `competitive-landscape` and `sdk-changelog-monitor`, none of which
 * exist in the tree, while omitting `ralph-loop` and `spec-sync`, which do. An
 * agent reading CLAUDE.md would invoke three skills that cannot load and never
 * learn about two that would have helped.
 *
 * A skill nobody can find is a skill nobody uses, so the index is the whole
 * delivery mechanism — and prose indexes rot silently. This one cannot.
 */

const repoRoot = join(__dirname, '..');
const skillsDir = join(repoRoot, '.claude', 'skills');

/** Directory names under `.claude/skills/` that contain a SKILL.md. */
function skillsOnDisk(): string[] {
  return readdirSync(skillsDir, { withFileTypes: true })
    .filter(e => e.isDirectory() && existsSync(join(skillsDir, e.name, 'SKILL.md')))
    .map(e => e.name)
    .sort();
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
  it('found skills on disk and a Skills section to compare against', () => {
    expect(skillsOnDisk().length).toBeGreaterThan(0);
    expect(skillsInClaudeMd().length).toBeGreaterThan(0);
  });

  it('lists every skill that exists on disk', () => {
    const missing = skillsOnDisk().filter(s => !skillsInClaudeMd().includes(s));
    expect(missing).toEqual([]);
  });

  it('lists no skill that does not exist on disk', () => {
    // The half that had rotted: three entries pointed at directories that were
    // never there, so `/ui-audit` and friends simply failed to load.
    const phantom = skillsInClaudeMd().filter(s => !skillsOnDisk().includes(s));
    expect(phantom).toEqual([]);
  });

  it('gives every skill YAML frontmatter with a name and a description', () => {
    // The runner writes skill bundles to ~/.claude/skills/<slug>/ for native SDK
    // discovery, and that discovery reads the frontmatter. A SKILL.md without it
    // is present but invisible.
    const broken: string[] = [];
    for (const s of skillsOnDisk()) {
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
    for (const s of skillsOnDisk()) {
      const body = readFileSync(join(skillsDir, s, 'SKILL.md'), 'utf8');
      const name = /^---\n[\s\S]*?\bname:\s*"?([^"\n]+?)"?\s*$/m.exec(body)?.[1];
      if (name !== s) mismatched.push(`${s} (frontmatter: ${name ?? 'none'})`);
    }
    expect(mismatched).toEqual([]);
  });
});
