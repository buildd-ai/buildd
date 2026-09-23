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

/**
 * The role's persona, delivered inline on the claim response.
 *
 * Mirrors `RoleInstructions` in packages/shared — declared here for the same
 * reason `RoleConfig` is, so the runner's role plumbing stands alone.
 *
 * Present whenever a role row resolved server-side, whether or not that role
 * was ever packaged to object storage. `RoleConfig` below is the packaged
 * bundle and is absent for every seeded default role.
 */
export interface RoleInstructions {
  slug: string;
  name: string;
  content: string;
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
 *
 * `BUILDD_HOME` overrides the root, matching every other runner module that
 * resolves a path under `~/.buildd` (doctor, history-store, worker-store, …).
 * Without it an isolated runner home — the updater's probe, or a test process —
 * still wrote role bundles into the operator's real one.
 */
export function getRoleDir(slug: string): string {
  const root = process.env.BUILDD_HOME || join(homedir(), '.buildd');
  return join(root, 'roles', slug);
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
    // Auto-add type: "http" to any server that has a url field (defensive)
    const servers = (bundle.mcpConfig as { mcpServers?: Record<string, Record<string, unknown>> }).mcpServers;
    if (servers) {
      for (const config of Object.values(servers)) {
        if (config && typeof config === 'object' && 'url' in config && !config.type) {
          config.type = 'http';
        }
      }
    }
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

export interface ResolveRoleEnvResult {
  /** Successfully resolved key → value pairs, ready to merge into the session env. */
  resolved: Record<string, string>;
  /**
   * Role-declared keys whose secret label had no match in processEnv. Non-empty
   * means the role's declared requirement was NOT met — the caller must not
   * treat this the same as "role declared nothing" (see workers.ts, which
   * records a degraded milestone rather than starting silently).
   */
  missing: string[];
}

/**
 * Resolve env var labels from env-mapping.json against actual environment values.
 *
 * A label not found in processEnv is reported via `missing`, not just a
 * console warning — a missing declared var used to vanish into runner logs
 * while the session started as if nothing had been requested at all.
 */
export async function resolveRoleEnv(
  roleDir: string,
  processEnv: Record<string, string>,
): Promise<ResolveRoleEnvResult> {
  let mapping: Record<string, string>;
  try {
    const raw = await readFile(join(roleDir, 'env-mapping.json'), 'utf-8');
    mapping = JSON.parse(raw);
  } catch {
    return { resolved: {}, missing: [] };
  }

  const resolved: Record<string, string> = {};
  const missing: string[] = [];
  for (const [key, secretLabel] of Object.entries(mapping)) {
    if (secretLabel in processEnv) {
      resolved[key] = processEnv[secretLabel];
    } else {
      missing.push(key);
      console.warn(`[roles] env label "${secretLabel}" for ${key} not found in process env — skipping`);
    }
  }
  return { resolved, missing };
}

/**
 * Render the role persona as a system-prompt section.
 *
 * Pure — no disk, no network — and returns `''` when there is nothing to say,
 * so callers can append unconditionally.
 *
 * This is the ONLY channel that carries the persona to a Claude session.
 * `settingSources: ['project']` loads the repo's own CLAUDE.md, never the
 * role's, and `overlayRoleFiles` deliberately does not overlay one.
 */
export function buildRoleSystemPromptSection(
  roleInstructions: RoleInstructions | null | undefined,
): string {
  const content = roleInstructions?.content?.trim();
  if (!content) return '';
  const name = roleInstructions!.name?.trim() || roleInstructions!.slug;
  return `\n\n## Role: ${name}\n${content}`;
}

/** Where a role-assigned session should run, and what to overlay into it. */
export interface RoleCwdResolution {
  /** The directory to hand the session (before worktree isolation is applied). */
  cwd: string;
  /**
   * Local role directory whose skills/.mcp.json must be overlaid into the
   * session cwd — set only when the session runs in a repo, where the role's
   * own directory is not the cwd. The overlay must happen AFTER worktree setup,
   * against the worktree: `git worktree add` only checks out tracked content,
   * so anything written into the base clone first never arrives.
   */
  overlayFrom?: string;
}

/**
 * Decide the session cwd for a task that resolved a role.
 *
 * The rule is the WORKSPACE, not the role's packaged `type`: a task whose
 * workspace has a repo runs in that repo, always. `type` is derived from the
 * role row's `repoUrl`, which the dashboard role editor never sets — so every
 * role saved from the UI packages as `'service'`, and keying cwd off it sent
 * repo tasks to `~/.buildd/roles/<slug>`, a directory that is not a git
 * checkout and has none of the task's code in it.
 *
 * Roles with no packaged bundle are handled the same way: the locally-synced
 * role dir (from an earlier packaged sync, if any) is still overlaid or used as
 * cwd on exactly the same condition.
 */
export async function resolveRoleCwd(
  roleConfig: RoleConfig | undefined | null,
  task: { roleSlug?: string | null; workspace?: { repo?: string | null } | null } | null | undefined,
  workspacePath: string,
): Promise<RoleCwdResolution> {
  const hasRepo = !!task?.workspace?.repo;

  let roleDir: string | undefined;
  if (roleConfig) {
    roleDir = (await syncRoleToLocal(roleConfig)).cwd;
  } else if (task?.roleSlug) {
    // No bundle on the claim (role never packaged to R2 — every seeded default
    // role, and anything created via register_skill). A previously-synced local
    // copy is still worth using.
    const local = getRoleDir(task.roleSlug);
    if (existsSync(local)) roleDir = local;
  }

  if (!roleDir) return { cwd: workspacePath };
  return hasRepo
    ? { cwd: workspacePath, overlayFrom: roleDir }
    : { cwd: roleDir };
}

/**
 * Overlay role files (skills, .mcp.json) into a repo directory.
 * Used whenever cwd is the repo rather than the role dir.
 *
 * CLAUDE.md is NOT overlaid: the repo's own CLAUDE.md is the project's and
 * must not be clobbered. The role persona reaches the agent through the system
 * prompt instead — see `buildRoleSystemPromptSection`.
 *
 * `repoDir` must be the session cwd (the worktree when worktree isolation is
 * on), not the base clone — see `RoleCwdResolution.overlayFrom`.
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
