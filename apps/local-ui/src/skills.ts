import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, resolve } from 'path';

export interface DiscoveredSkill {
  slug: string;
  name: string;
  description: string;
  content: string;
  path: string;
  referenceFiles: Record<string, string>;
}

/** Parse simple YAML frontmatter between --- delimiters */
function parseFrontmatter(content: string): { name?: string; description?: string } {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return {};

  const yaml = match[1];
  const result: Record<string, string> = {};

  for (const line of yaml.split('\n')) {
    const kvMatch = line.match(/^(\w+)\s*:\s*(.+)$/);
    if (kvMatch) {
      const key = kvMatch[1].trim();
      let value = kvMatch[2].trim();
      // Strip surrounding quotes
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      result[key] = value;
    }
  }

  return {
    name: result.name,
    description: result.description,
  };
}

/**
 * Scan a project directory for .claude/skills/[slug]/SKILL.md files.
 * Returns an array of discovered skills with their content and metadata.
 */
export function scanSkills(projectPath: string): DiscoveredSkill[] {
  const skillsDir = join(projectPath, '.claude', 'skills');

  if (!existsSync(skillsDir)) {
    return [];
  }

  const discovered: DiscoveredSkill[] = [];

  let entries: string[];
  try {
    entries = readdirSync(skillsDir);
  } catch {
    return [];
  }

  for (const entry of entries) {
    const entryPath = join(skillsDir, entry);

    // Skip non-directories and hidden dirs
    try {
      if (!statSync(entryPath).isDirectory() || entry.startsWith('.')) continue;
    } catch {
      continue;
    }

    const skillMdPath = join(entryPath, 'SKILL.md');
    if (!existsSync(skillMdPath)) continue;

    let content: string;
    try {
      content = readFileSync(skillMdPath, 'utf-8');
    } catch {
      continue;
    }

    const frontmatter = parseFrontmatter(content);

    // Collect other .md files in the directory as reference files
    const referenceFiles: Record<string, string> = {};
    try {
      for (const file of readdirSync(entryPath)) {
        if (file.endsWith('.md') && file !== 'SKILL.md') {
          try {
            referenceFiles[file] = readFileSync(join(entryPath, file), 'utf-8');
          } catch {
            // Skip unreadable files
          }
        }
      }
    } catch {
      // Skip if directory listing fails
    }

    discovered.push({
      slug: entry,
      name: frontmatter.name || entry,
      description: frontmatter.description || '',
      content,
      path: resolve(skillMdPath),
      referenceFiles,
    });
  }

  return discovered;
}
