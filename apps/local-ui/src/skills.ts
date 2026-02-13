import { createHash } from 'crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, basename } from 'path';

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
