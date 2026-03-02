#!/usr/bin/env bun

import { parseArgs } from 'util';
import { createHash } from 'crypto';
import {
  readFileSync, writeFileSync, existsSync, mkdirSync,
  readdirSync, statSync, lstatSync, copyFileSync, rmSync,
  symlinkSync, readlinkSync,
} from 'fs';
import { join, basename, resolve } from 'path';
import { homedir } from 'os';

// ============================================================================
// Config
// ============================================================================

const CONFIG_FILE = join(homedir(), '.buildd', 'config.json');
const SKILLS_DIR = join(homedir(), '.buildd', 'skills');
const CLAUDE_SKILLS_DIR = join(homedir(), '.claude', 'skills');

const RED = '\x1b[0;31m';
const GREEN = '\x1b[0;32m';
const YELLOW = '\x1b[1;33m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const NC = '\x1b[0m';

/**
 * Ensure ~/.claude/skills/<slug> symlinks to ~/.buildd/skills/<slug>
 * so Claude Code native discovery still works.
 */
function ensureClaudeSymlink(slug: string) {
  const builddSkillDir = join(SKILLS_DIR, slug);
  const claudeSkillDir = join(CLAUDE_SKILLS_DIR, slug);

  mkdirSync(CLAUDE_SKILLS_DIR, { recursive: true });

  // Remove existing entry (symlink or directory)
  try {
    if (lstatSync(claudeSkillDir)) {
      rmSync(claudeSkillDir, { recursive: true, force: true });
    }
  } catch {
    // Doesn't exist — fine
  }

  symlinkSync(builddSkillDir, claudeSkillDir);
}

function removeClaudeSymlink(slug: string) {
  const claudeSkillDir = join(CLAUDE_SKILLS_DIR, slug);
  try {
    if (lstatSync(claudeSkillDir)?.isSymbolicLink()) {
      rmSync(claudeSkillDir);
    }
  } catch {
    // Doesn't exist — fine
  }
}

function loadConfig(): { apiKey?: string; builddServer?: string } {
  try {
    if (existsSync(CONFIG_FILE)) {
      return JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
    }
  } catch { /* ignore */ }
  return {};
}

// ============================================================================
// Frontmatter parsing
// ============================================================================

interface SkillMeta {
  name?: string;
  description?: string;
  [key: string]: unknown;
}

function parseFrontmatter(content: string): { meta: SkillMeta; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: content };

  const meta: SkillMeta = {};
  for (const line of match[1].split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim();
      const value = line.slice(colonIdx + 1).trim();
      meta[key] = value;
    }
  }
  return { meta, body: match[2] };
}

// ============================================================================
// SHA-256 hash
// ============================================================================

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

// ============================================================================
// Server registration (no-op: team-level skills have been removed)
// ============================================================================

async function registerWithServer(
  _config: { apiKey?: string; builddServer?: string },
  _skill: { slug: string; name: string; description?: string; contentHash: string; source?: string; sourceVersion?: string },
): Promise<boolean> {
  // Team-level skills API has been removed. Skills are now workspace-scoped
  // and registered via the sync endpoint or dashboard.
  return false;
}

async function lookupSkillSource(
  _config: { apiKey?: string; builddServer?: string },
  _slug: string,
): Promise<{ source?: string; sourceVersion?: string; contentHash?: string } | null> {
  // Team-level skills API has been removed. Skills are now workspace-scoped.
  return null;
}

// ============================================================================
// GitHub download
// ============================================================================

interface GitHubSource {
  owner: string;
  repo: string;
  path: string; // '' for root
  ref: string;  // '' for default branch
}

function parseGitHubSource(source: string): GitHubSource {
  // github:owner/repo@ref
  // github:owner/repo/path@ref
  // github:owner/repo/path
  let rest = source.replace(/^github:/, '');

  let ref = '';
  const atIdx = rest.indexOf('@');
  if (atIdx > 0) {
    ref = rest.slice(atIdx + 1);
    rest = rest.slice(0, atIdx);
  }

  const parts = rest.split('/');
  const owner = parts[0];
  const repo = parts[1];
  const path = parts.slice(2).join('/');

  return { owner, repo, path, ref };
}

async function downloadGitHubDirectory(
  gh: GitHubSource,
  destDir: string,
): Promise<void> {
  const contentsUrl = `https://api.github.com/repos/${gh.owner}/${gh.repo}/contents/${gh.path}${gh.ref ? `?ref=${gh.ref}` : ''}`;

  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'buildd-skill-installer',
  };
  // Use GitHub token if available
  const ghToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (ghToken) {
    headers['Authorization'] = `token ${ghToken}`;
  }

  const res = await fetch(contentsUrl, { headers });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub API error (${res.status}): ${body}`);
  }

  const items = await res.json() as Array<{
    name: string;
    type: 'file' | 'dir';
    download_url: string | null;
    path: string;
  }>;

  mkdirSync(destDir, { recursive: true });

  for (const item of items) {
    if (item.type === 'file' && item.download_url) {
      const fileRes = await fetch(item.download_url, { headers });
      if (fileRes.ok) {
        const content = await fileRes.text();
        writeFileSync(join(destDir, item.name), content);
      }
    } else if (item.type === 'dir') {
      // Recurse into subdirectories
      const subGh: GitHubSource = {
        ...gh,
        path: item.path,
      };
      await downloadGitHubDirectory(subGh, join(destDir, item.name));
    }
  }
}

// ============================================================================
// Local copy
// ============================================================================

function copyDirectory(src: string, dest: string) {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    const srcPath = join(src, entry);
    const destPath = join(dest, entry);
    if (statSync(srcPath).isDirectory()) {
      copyDirectory(srcPath, destPath);
    } else {
      copyFileSync(srcPath, destPath);
    }
  }
}

// ============================================================================
// Slug derivation
// ============================================================================

function deriveSlug(source: string, meta: SkillMeta): string {
  // From frontmatter name
  if (meta.name && typeof meta.name === 'string') {
    return meta.name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  }

  // From source
  if (source.startsWith('github:')) {
    const gh = parseGitHubSource(source);
    // Use path basename if present, otherwise repo name
    return gh.path ? basename(gh.path) : gh.repo;
  }

  // From directory name
  return basename(resolve(source));
}

// ============================================================================
// Commands
// ============================================================================

async function installSkill(source: string) {
  const config = loadConfig();

  // Determine source type
  let resolvedSource = source;
  let sourceType: 'github' | 'local' | 'slug';

  if (source.startsWith('github:')) {
    sourceType = 'github';
  } else if (source.startsWith('./') || source.startsWith('/') || source.startsWith('..')) {
    sourceType = 'local';
  } else if (source.includes('/')) {
    // Bare owner/repo — treat as GitHub shorthand
    resolvedSource = `github:${source}`;
    sourceType = 'github';
  } else {
    // Bare slug — look up in server registry
    sourceType = 'slug';
  }

  // For slug lookups, resolve the source from the server
  if (sourceType === 'slug') {
    console.log(`Looking up "${source}" in server registry...`);
    const registered = await lookupSkillSource(config, source);
    if (!registered?.source) {
      // Check if already installed locally
      const localPath = join(SKILLS_DIR, source, 'SKILL.md');
      if (existsSync(localPath)) {
        console.log(`${YELLOW}Skill "${source}" is installed locally but has no remote source registered.${NC}`);
        console.log(`Use ${BOLD}buildd skill register ${source}${NC} to register it.`);
        return;
      }
      console.error(`${RED}Skill "${source}" not found in registry and not installed locally.${NC}`);
      console.error(`Install from a source: ${DIM}buildd skill install github:owner/${source}${NC}`);
      process.exit(1);
    }
    resolvedSource = registered.source;
    sourceType = resolvedSource.startsWith('github:') ? 'github' : 'local';
    console.log(`Found source: ${DIM}${resolvedSource}${NC}`);
  }

  // Download / copy to temp location first
  const tmpDir = join(homedir(), '.buildd', '.skill-tmp');
  rmSync(tmpDir, { recursive: true, force: true });

  if (sourceType === 'github') {
    const gh = parseGitHubSource(resolvedSource);
    console.log(`Downloading from GitHub: ${gh.owner}/${gh.repo}${gh.path ? `/${gh.path}` : ''}${gh.ref ? `@${gh.ref}` : ''}...`);
    await downloadGitHubDirectory(gh, tmpDir);
  } else {
    const srcPath = resolve(source);
    if (!existsSync(srcPath)) {
      console.error(`${RED}Directory not found: ${srcPath}${NC}`);
      process.exit(1);
    }
    if (!existsSync(join(srcPath, 'SKILL.md'))) {
      console.error(`${RED}No SKILL.md found in ${srcPath}${NC}`);
      process.exit(1);
    }
    copyDirectory(srcPath, tmpDir);
  }

  // Validate SKILL.md exists
  const skillMdPath = join(tmpDir, 'SKILL.md');
  if (!existsSync(skillMdPath)) {
    console.error(`${RED}No SKILL.md found in downloaded skill.${NC}`);
    rmSync(tmpDir, { recursive: true, force: true });
    process.exit(1);
  }

  // Parse frontmatter and derive slug
  const skillContent = readFileSync(skillMdPath, 'utf-8');
  const { meta } = parseFrontmatter(skillContent);
  const slug = deriveSlug(resolvedSource, meta);
  const name = (meta.name as string) || slug;
  const description = (meta.description as string) || undefined;

  // Compute hash
  const contentHash = hashContent(skillContent);

  // Move to final location
  const destDir = join(SKILLS_DIR, slug);
  if (existsSync(destDir)) {
    // Check if content actually changed
    const existingSkillMd = join(destDir, 'SKILL.md');
    if (existsSync(existingSkillMd)) {
      const existingHash = hashContent(readFileSync(existingSkillMd, 'utf-8'));
      if (existingHash === contentHash) {
        console.log(`${GREEN}Skill "${slug}" is already up to date.${NC} ${DIM}(${contentHash.slice(0, 12)})${NC}`);
        rmSync(tmpDir, { recursive: true, force: true });
        return;
      }
    }
    rmSync(destDir, { recursive: true, force: true });
  }

  mkdirSync(join(SKILLS_DIR), { recursive: true });
  copyDirectory(tmpDir, destDir);
  rmSync(tmpDir, { recursive: true, force: true });

  // Symlink into ~/.claude/skills/ for native Claude Code discovery
  ensureClaudeSymlink(slug);

  // Count files
  const fileCount = countFiles(destDir);

  console.log(`${GREEN}Installed "${slug}" → ~/.buildd/skills/${slug}/${NC}`);
  console.log(`  ${DIM}${fileCount} file${fileCount !== 1 ? 's' : ''} · hash: ${contentHash.slice(0, 12)}${NC}`);
}

async function registerSkill(slug: string) {
  const skillMdPath = join(SKILLS_DIR, slug, 'SKILL.md');
  if (!existsSync(skillMdPath)) {
    console.error(`${RED}Skill "${slug}" not found at ~/.buildd/skills/${slug}/SKILL.md${NC}`);
    process.exit(1);
  }

  console.log(`${YELLOW}Team-level skill registration has been removed.${NC}`);
  console.log(`Skills are now workspace-scoped. Use the workspace skill sync endpoint or dashboard to register skills.`);
  console.log(`${DIM}The skill is already installed locally at ~/.buildd/skills/${slug}/${NC}`);
}

async function listSkills() {
  const config = loadConfig();

  // Local skills
  const localSkills = new Map<string, { hash: string; name: string; description?: string; linked?: string }>();
  if (existsSync(SKILLS_DIR)) {
    for (const entry of readdirSync(SKILLS_DIR)) {
      const entryPath = join(SKILLS_DIR, entry);
      const skillMd = join(entryPath, 'SKILL.md');
      if (existsSync(skillMd)) {
        const content = readFileSync(skillMd, 'utf-8');
        const { meta } = parseFrontmatter(content);
        localSkills.set(entry, {
          hash: hashContent(content),
          name: (meta.name as string) || entry,
          description: (meta.description as string) || undefined,
          linked: isSymlink(entryPath) ? (getSymlinkTarget(entryPath) || 'linked') : undefined,
        });
      }
    }
  }

  if (localSkills.size === 0) {
    console.log('No skills installed.');
    console.log(`${DIM}Install one: buildd skill install github:owner/repo${NC}`);
    return;
  }

  console.log(`${BOLD}Skills${NC}\n`);

  for (const slug of [...localSkills.keys()].sort()) {
    const local = localSkills.get(slug)!;
    const hashDisplay = `${DIM}${local.hash.slice(0, 12)}${NC}`;

    console.log(`  ${BOLD}${local.name}${NC} ${hashDisplay}`);
    if (local.linked) {
      console.log(`    ${DIM}→ ${local.linked}${NC}`);
    }
    if (local.description) {
      console.log(`    ${DIM}${local.description}${NC}`);
    }
  }
}

async function linkSkill(source: string) {
  const srcPath = resolve(source);

  if (!existsSync(srcPath)) {
    console.error(`${RED}Directory not found: ${srcPath}${NC}`);
    process.exit(1);
  }
  if (!existsSync(join(srcPath, 'SKILL.md'))) {
    console.error(`${RED}No SKILL.md found in ${srcPath}${NC}`);
    process.exit(1);
  }

  // Parse frontmatter to derive slug
  const content = readFileSync(join(srcPath, 'SKILL.md'), 'utf-8');
  const { meta } = parseFrontmatter(content);
  const slug = deriveSlug(source, meta);

  const destDir = join(SKILLS_DIR, slug);

  // Remove existing (copy or symlink)
  try {
    if (lstatSync(destDir)) {
      rmSync(destDir, { recursive: true, force: true });
    }
  } catch {
    // Doesn't exist — fine
  }

  mkdirSync(SKILLS_DIR, { recursive: true });
  symlinkSync(srcPath, destDir);

  // Symlink into ~/.claude/skills/ for native Claude Code discovery
  ensureClaudeSymlink(slug);

  const contentHash = hashContent(content);
  console.log(`${GREEN}Linked "${slug}" → ${srcPath}${NC}`);
  console.log(`  ${DIM}hash: ${contentHash.slice(0, 12)} (current snapshot)${NC}`);
  console.log(`  ${DIM}Edits to ${srcPath} are immediately visible to Claude Code.${NC}`);
  console.log(`  ${DIM}Run "buildd skill register ${slug}" when ready to push hash to server.${NC}`);
}

async function unlinkSkill(slug: string) {
  const destDir = join(SKILLS_DIR, slug);

  if (!existsSync(destDir)) {
    console.error(`${RED}Skill "${slug}" not found.${NC}`);
    process.exit(1);
  }

  try {
    const stat = lstatSync(destDir);
    if (!stat.isSymbolicLink()) {
      console.error(`${RED}Skill "${slug}" is not a symlink. Use a different method to remove it.${NC}`);
      process.exit(1);
    }
  } catch {
    console.error(`${RED}Skill "${slug}" not found.${NC}`);
    process.exit(1);
  }

  rmSync(destDir);
  removeClaudeSymlink(slug);
  console.log(`${GREEN}Unlinked "${slug}"${NC}`);
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function getSymlinkTarget(path: string): string | null {
  try {
    return readlinkSync(path);
  } catch {
    return null;
  }
}

function countFiles(dir: string): number {
  let count = 0;
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    if (statSync(fullPath).isDirectory()) {
      count += countFiles(fullPath);
    } else {
      count++;
    }
  }
  return count;
}

// ============================================================================
// CLI entry point
// ============================================================================

const args = Bun.argv.slice(2);
const subcommand = args[0];

switch (subcommand) {
  case 'install': {
    const source = args[1];
    if (!source) {
      console.error('Usage: buildd skill install <source>');
      console.error('');
      console.error('Sources:');
      console.error('  github:owner/repo          GitHub repo (SKILL.md at root)');
      console.error('  github:owner/repo@v1.0     Pinned to ref/tag');
      console.error('  github:owner/repo/subdir   Subdirectory within repo');
      console.error('  owner/repo                 GitHub shorthand');
      console.error('  ./local-path               Local directory');
      console.error('  <slug>                     Look up source in server registry');
      process.exit(1);
    }
    await installSkill(source);
    break;
  }

  case 'link': {
    const source = args[1];
    if (!source) {
      console.error('Usage: buildd skill link <path>');
      console.error('');
      console.error('Symlinks a local skill directory for development.');
      console.error('Edits are immediately visible — no reinstall needed.');
      process.exit(1);
    }
    await linkSkill(source);
    break;
  }

  case 'unlink': {
    const slug = args[1];
    if (!slug) {
      console.error('Usage: buildd skill unlink <slug>');
      process.exit(1);
    }
    await unlinkSkill(slug);
    break;
  }

  case 'register': {
    const slug = args[1];
    if (!slug) {
      console.error('Usage: buildd skill register <slug>');
      console.error('');
      console.error('Pushes the current hash of an installed skill to the server.');
      console.error('Workers will verify against this hash on their next task.');
      process.exit(1);
    }
    await registerSkill(slug);
    break;
  }

  case 'list':
  case 'ls':
    await listSkills();
    break;

  default:
    console.log('Usage: buildd skill <command>');
    console.log('');
    console.log('Commands:');
    console.log('  install <source>    Download and register a skill');
    console.log('  link <path>         Symlink a local skill for development');
    console.log('  unlink <slug>       Remove a symlinked skill');
    console.log('  register <slug>     Push current hash to server');
    console.log('  list                Show installed and registered skills');
    console.log('');
    console.log('Examples:');
    console.log('  buildd skill install github:acme/ui-audit');
    console.log('  buildd skill install github:acme/skills/code-review@v2');
    console.log('  buildd skill install ./my-skill');
    console.log('  buildd skill install ui-audit          # from registry');
    console.log('  buildd skill link ./my-skill            # dev mode');
    console.log('  buildd skill register my-skill          # push hash');
    process.exit(args.length === 0 ? 0 : 1);
}
