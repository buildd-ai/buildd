import { createHash } from 'crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { mkdir, writeFile, readFile, chmod } from 'fs/promises';
import { join, basename, dirname } from 'path';
import { homedir } from 'os';
import type { SkillBundleFile } from '@buildd/shared';

export interface DiscoveredSkill {
  slug: string;
  name: string;
  description?: string;
  content: string;
  contentHash: string;
  path: string;
  referenceFiles: Record<string, string>;
}

// Parse YAML frontmatter from SKILL.md content (between --- markers)
function parseFrontmatter(content: string): { name?: string; description?: string } {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith('---')) return {};

  const endIdx = trimmed.indexOf('---', 3);
  if (endIdx === -1) return {};

  const frontmatter = trimmed.slice(3, endIdx).trim();
  const result: Record<string, string> = {};

  for (const line of frontmatter.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, '');
    if (key && value) {
      result[key] = value;
    }
  }

  return { name: result.name, description: result.description };
}

// Scan a project directory for skills defined in .claude/skills/*/SKILL.md
export function scanSkills(projectPath: string): DiscoveredSkill[] {
  const skillsDir = join(projectPath, '.claude', 'skills');
  if (!existsSync(skillsDir)) return [];

  const discovered: DiscoveredSkill[] = [];

  let entries: string[];
  try {
    entries = readdirSync(skillsDir);
  } catch {
    return [];
  }

  for (const entry of entries) {
    const entryPath = join(skillsDir, entry);

    // Must be a directory
    try {
      if (!statSync(entryPath).isDirectory()) continue;
    } catch {
      continue;
    }

    const skillPath = join(entryPath, 'SKILL.md');
    if (!existsSync(skillPath)) continue;

    let content: string;
    try {
      content = readFileSync(skillPath, 'utf-8');
    } catch {
      continue;
    }

    const frontmatter = parseFrontmatter(content);
    const slug = basename(entryPath);
    const contentHash = createHash('sha256').update(content).digest('hex');

    // Collect additional .md files in the same directory as reference files
    const referenceFiles: Record<string, string> = {};
    try {
      const files = readdirSync(entryPath);
      for (const file of files) {
        if (file === 'SKILL.md') continue;
        if (!file.endsWith('.md')) continue;
        const filePath = join(entryPath, file);
        try {
          if (statSync(filePath).isFile()) {
            referenceFiles[file] = readFileSync(filePath, 'utf-8');
          }
        } catch {
          // Skip unreadable files
        }
      }
    } catch {
      // Skip if directory listing fails
    }

    discovered.push({
      slug,
      name: frontmatter.name || slug,
      description: frontmatter.description,
      content,
      contentHash,
      path: skillPath,
      referenceFiles,
    });
  }

  return discovered;
}

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
