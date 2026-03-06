import { createHash } from 'crypto';
import { mkdir, writeFile, readFile, chmod } from 'fs/promises';
import { join, dirname } from 'path';
import { homedir } from 'os';
import type { SkillBundleFile } from '@buildd/shared';

/**
 * Write a skill bundle to ~/.claude/skills/<slug>/ for native SDK discovery.
 * Idempotent — skips if hash matches what's already on disk.
 */
export async function syncSkillToLocal(bundle: {
  slug: string;
  name: string;
  content: string;
  contentHash?: string;
  files?: SkillBundleFile[];
}): Promise<void> {
  const skillDir = join(homedir(), '.claude', 'skills', bundle.slug);
  const hashFile = join(skillDir, '.buildd-hash');
  const contentHash = bundle.contentHash || createHash('sha256').update(bundle.content).digest('hex');

  // Skip if already up to date
  try {
    const currentHash = await readFile(hashFile, 'utf-8');
    if (currentHash.trim() === contentHash) return;
  } catch {
    // Hash file doesn't exist — proceed with sync
  }

  // Ensure directory
  await mkdir(skillDir, { recursive: true });

  // Ensure SKILL.md has proper frontmatter for SDK discovery
  const content = ensureFrontmatter(bundle.content, bundle.slug, bundle.name);
  await writeFile(join(skillDir, 'SKILL.md'), content);

  // Write supporting files
  if (bundle.files) {
    for (const file of bundle.files) {
      const filePath = join(skillDir, file.path);
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

  // Store hash
  await writeFile(hashFile, contentHash);
}

/**
 * Ensure SKILL.md has YAML frontmatter with name and description.
 * The SDK requires frontmatter for skill discovery.
 * name must match slug for Skill(slug) allowedTools scoping.
 */
function ensureFrontmatter(content: string, slug: string, displayName: string): string {
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
