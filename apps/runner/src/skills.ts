import { mkdir, writeFile, chmod } from 'fs/promises';
import { join, dirname, resolve, sep } from 'path';
import type { SkillBundleFile } from '@buildd/shared';
import { claimPromptDir, isForeignDir } from './session-prompt-files.js';

export interface SyncSkillTarget {
  /** The session cwd. The skill lands in `<sessionCwd>/.claude/skills/<slug>/`. */
  sessionCwd: string;
  /** Owner recorded in the session manifest; cleanup removes only its own dirs. */
  workerId: string;
}

export interface SyncSkillResult {
  path: string;
  /** Set when the repo already ships a skill at that path; it is left untouched. */
  skipped?: 'exists';
}

/**
 * Write a skill bundle into the session cwd's `.claude/skills/<slug>/`, where
 * the SDK discovers it through the `project` setting source.
 *
 * Per session, never cached: the directory is recorded in the worker's session
 * manifest and removed when the session ends (see session-prompt-files.ts). It
 * is never written to the user's own `~/.claude/skills`. A `.gitignore` of `*`
 * keeps it out of the agent's commits.
 */
export async function syncSkillToLocal(bundle: {
  slug: string;
  name: string;
  content: string;
  contentHash?: string;
  files?: SkillBundleFile[];
}, target: SyncSkillTarget): Promise<SyncSkillResult> {
  const skillsRoot = join(target.sessionCwd, '.claude', 'skills');
  const skillDir = join(skillsRoot, bundle.slug);
  if (resolve(skillDir) === resolve(skillsRoot) || !resolve(skillDir).startsWith(resolve(skillsRoot) + sep)) {
    throw new Error(`Invalid skill slug: ${bundle.slug}`);
  }

  // The repo already carries a skill of this name (tracked content): keep it.
  // Overwriting would put a modification into the agent's diff.
  if (isForeignDir(target.workerId, skillDir)) return { path: skillDir, skipped: 'exists' };

  // Record + mark BEFORE the text lands, so a crash mid-write still leaves a
  // path the next start's sweep removes.
  claimPromptDir(target.workerId, skillDir);

  // Ensure SKILL.md has proper frontmatter for SDK discovery
  const content = ensureFrontmatter(bundle.content, bundle.slug, bundle.name);
  await writeFile(join(skillDir, 'SKILL.md'), content);

  // Write supporting files
  if (bundle.files) {
    for (const file of bundle.files) {
      const filePath = resolve(skillDir, file.path);
      if (!filePath.startsWith(resolve(skillDir) + sep)) continue;
      await mkdir(dirname(filePath), { recursive: true });
      const data = file.encoding === 'base64'
        ? Buffer.from(file.content, 'base64')
        : file.content;
      await writeFile(filePath, data);
      if (file.executable) {
        await chmod(filePath, 0o755);
      }
    }
  }

  return { path: skillDir };
}

/**
 * Ensure SKILL.md has YAML frontmatter with name and description.
 * The SDK requires frontmatter for skill discovery.
 * name must match slug for Skill(slug) allowedTools scoping.
 */
export function ensureFrontmatter(content: string, slug: string, displayName: string): string {
  if (content.startsWith('---')) {
    // Has frontmatter — verify name matches slug
    const endIdx = content.indexOf('---', 3);
    if (endIdx === -1) return content;
    const frontmatter = content.slice(3, endIdx);
    const afterFrontmatter = content.slice(endIdx);
    // Check if name field exists
    if (/^name\s*:/m.test(frontmatter)) {
      // Replace name with slug to ensure Skill(slug) scoping works
      const updated = frontmatter.replace(/^name\s*:.*/m, `name: ${slug}`);
      return '---' + updated + afterFrontmatter;
    }
    // Add name field to existing frontmatter
    return '---\nname: ' + slug + frontmatter + afterFrontmatter;
  }

  // No frontmatter — add minimal required fields
  const fm = [
    '---',
    `name: ${slug}`,
    `description: ${displayName}`,
    '---',
    '',
  ].join('\n');
  return fm + content;
}
