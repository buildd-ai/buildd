import { mkdir, writeFile, readFile, rm, copyFile, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// Role config bundle as returned by the claim route
export interface RoleConfig {
  slug: string;
  configHash: string;
  configUrl: string; // R2 presigned download URL
  type: 'builder' | 'service';
  repoUrl?: string;
  // DB-level config (runner uses directly, not stored in files)
  model: string;
  allowedTools: string[];
  canDelegateTo: string[];
  background: boolean;
  maxTurns: number | null;
}

// The JSON config bundle stored in R2
interface RoleConfigBundle {
  slug: string;
  type: 'builder' | 'service';
  claudeMd: string;
  mcpConfig: Record<string, unknown>;
  envMapping: Record<string, string>;
  skills: Array<{ slug: string; name: string; content: string }>;
  repoUrl?: string;
}

/**
 * Returns the local directory for a role: ~/.buildd/roles/<slug>/
 */
export function getRoleDir(slug: string): string {
  return join(homedir(), '.buildd', 'roles', slug);
}

/**
 * Sync a role's config bundle from the server to local disk.
 * Idempotent — skips if hash matches what's already on disk.
 */
export async function syncRoleToLocal(roleConfig: RoleConfig): Promise<{ cwd: string }> {
  const roleDir = getRoleDir(roleConfig.slug);
  const hashFile = join(roleDir, '.buildd-hash');

  // Skip if already up to date
  try {
    const currentHash = await readFile(hashFile, 'utf-8');
    if (currentHash.trim() === roleConfig.configHash) {
      return { cwd: roleDir };
    }
  } catch {
    // Hash file doesn't exist — proceed with sync
  }

  // Download config bundle from R2
  const res = await fetch(roleConfig.configUrl);
  if (!res.ok) {
    throw new Error(`Failed to download role config for ${roleConfig.slug}: ${res.status} ${res.statusText}`);
  }
  const bundle: RoleConfigBundle = await res.json();

  // Ensure role directory
  await mkdir(roleDir, { recursive: true });

  // Write CLAUDE.md
  await writeFile(join(roleDir, 'CLAUDE.md'), bundle.claudeMd);

  // Write .mcp.json only if it contains valid server configs (not empty)
  if (bundle.mcpConfig && typeof bundle.mcpConfig === 'object' && Object.keys(bundle.mcpConfig).length > 0) {
    await writeFile(join(roleDir, '.mcp.json'), JSON.stringify(bundle.mcpConfig, null, 2));
  }

  // Write env-mapping.json
  await writeFile(join(roleDir, 'env-mapping.json'), JSON.stringify(bundle.envMapping, null, 2));

  // Clean old skills before writing new ones
  const skillsBase = join(roleDir, '.claude', 'skills');
  await rm(skillsBase, { recursive: true, force: true });

  // Write skills
  for (const skill of bundle.skills) {
    const skillDir = join(roleDir, '.claude', 'skills', skill.slug);
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), skill.content);
  }

  // Store hash
  await writeFile(hashFile, roleConfig.configHash);

  return { cwd: roleDir };
}

/**
 * Resolve env var labels from env-mapping.json against actual environment values.
 * Labels not found in processEnv are skipped with a warning.
 */
export async function resolveRoleEnv(
  roleDir: string,
  processEnv: Record<string, string>,
): Promise<Record<string, string>> {
  let mapping: Record<string, string>;
  try {
    const raw = await readFile(join(roleDir, 'env-mapping.json'), 'utf-8');
    mapping = JSON.parse(raw);
  } catch {
    return {};
  }

  const resolved: Record<string, string> = {};
  for (const [key, secretLabel] of Object.entries(mapping)) {
    if (secretLabel in processEnv) {
      resolved[key] = processEnv[secretLabel];
    } else {
      console.warn(`[roles] env label "${secretLabel}" for ${key} not found in process env — skipping`);
    }
  }
  return resolved;
}

/**
 * Overlay role files (skills, .mcp.json) into a repo directory.
 * Used for builder roles where cwd is the repo, not the role dir.
 * CLAUDE.md is NOT overlaid — the repo's own CLAUDE.md takes precedence,
 * and role instructions come via the system prompt / skill bundles.
 */
export async function overlayRoleFiles(roleDir: string, repoDir: string): Promise<void> {
  // Copy .mcp.json if it exists and has content
  const mcpSrc = join(roleDir, '.mcp.json');
  if (existsSync(mcpSrc)) {
    const content = await readFile(mcpSrc, 'utf-8');
    const parsed = JSON.parse(content);
    // Only overlay if there's actual MCP config
    if (parsed && Object.keys(parsed).length > 0) {
      // Merge with existing .mcp.json if present
      const mcpDest = join(repoDir, '.mcp.json');
      let existing: Record<string, unknown> = {};
      try {
        existing = JSON.parse(await readFile(mcpDest, 'utf-8'));
      } catch { /* no existing file */ }
      const merged = {
        ...existing,
        mcpServers: { ...(existing.mcpServers as Record<string, unknown> || {}), ...(parsed.mcpServers || {}) },
      };
      await writeFile(mcpDest, JSON.stringify(merged, null, 2));
    }
  }

  // Copy skills into repo's .claude/skills/
  const skillsDir = join(roleDir, '.claude', 'skills');
  if (existsSync(skillsDir)) {
    const slugs = await readdir(skillsDir);
    for (const slug of slugs) {
      const srcSkillDir = join(skillsDir, slug);
      const destSkillDir = join(repoDir, '.claude', 'skills', slug);
      await mkdir(destSkillDir, { recursive: true });
      const files = await readdir(srcSkillDir);
      for (const file of files) {
        await copyFile(join(srcSkillDir, file), join(destSkillDir, file));
      }
    }
  }
}
