import { writeFile, readFile } from 'fs/promises';
import { join } from 'path';
import { claimPromptDir, isForeignDir, sessionRoleDir } from './session-prompt-files.js';

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

// The JSON config bundle stored in R2. Held in memory on the worker for the
// life of the task; written to disk only for the duration of a session.
export interface RoleBundle {
  slug: string;
  type: 'builder' | 'service';
  claudeMd: string;
  mcpConfig: Record<string, unknown>;
  envMapping: Record<string, string>;
  skills: Array<{ slug: string; name: string; content: string }>;
  repoUrl?: string;
}

/**
 * Download a role's config bundle from its presigned URL. Fetched per claim —
 * there is no disk cache to reuse across tasks.
 */
export async function fetchRoleBundle(roleConfig: RoleConfig): Promise<RoleBundle> {
  const res = await fetch(roleConfig.configUrl);
  if (!res.ok) {
    throw new Error(`Failed to download role config for ${roleConfig.slug}: ${res.status} ${res.statusText}`);
  }
  const bundle = await res.json() as RoleBundle;
  return {
    ...bundle,
    slug: bundle.slug || roleConfig.slug,
    envMapping: bundle.envMapping ?? {},
    skills: Array.isArray(bundle.skills) ? bundle.skills : [],
  };
}

/** `.mcp.json` content for a bundle, or null when it declares no servers. */
function bundleMcpConfig(bundle: RoleBundle): Record<string, unknown> | null {
  if (!bundle.mcpConfig || typeof bundle.mcpConfig !== 'object' || Object.keys(bundle.mcpConfig).length === 0) return null;
  // Auto-add type: "http" to any server that has a url field (defensive)
  const servers = (bundle.mcpConfig as { mcpServers?: Record<string, Record<string, unknown>> }).mcpServers;
  if (servers) {
    for (const config of Object.values(servers)) {
      if (config && typeof config === 'object' && 'url' in config && !config.type) {
        config.type = 'http';
      }
    }
  }
  return bundle.mcpConfig;
}

/**
 * Write a role bundle into this worker's session role dir
 * (`<BUILDD_HOME>/session-prompts/<workerId>/role`) — used as the session cwd
 * when the workspace has no repo. Removed with the rest of the session's
 * prompt files when the session ends.
 */
export async function materializeRoleBundle(bundle: RoleBundle, workerId: string): Promise<string> {
  const roleDir = sessionRoleDir(workerId);
  claimPromptDir(workerId, roleDir, { gitignore: false });
  await writeFile(join(roleDir, 'CLAUDE.md'), bundle.claudeMd ?? '');
  const mcp = bundleMcpConfig(bundle);
  if (mcp) await writeFile(join(roleDir, '.mcp.json'), JSON.stringify(mcp, null, 2));
  await writeRoleSkills(bundle, roleDir, workerId);
  return roleDir;
}

async function writeRoleSkills(bundle: RoleBundle, cwd: string, workerId: string): Promise<void> {
  for (const skill of bundle.skills) {
    if (!skill?.slug || /[\\/]|^\.\.?$/.test(skill.slug)) continue;
    const skillDir = join(cwd, '.claude', 'skills', skill.slug);
    // The repo's own skill of the same name wins; never overwrite tracked content.
    if (isForeignDir(workerId, skillDir)) continue;
    claimPromptDir(workerId, skillDir);
    await writeFile(join(skillDir, 'SKILL.md'), skill.content);
  }
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
  return resolveRoleEnvMapping(mapping, processEnv);
}

/** `resolveRoleEnv` over an in-memory mapping (the bundle's `envMapping`). */
export function resolveRoleEnvMapping(
  mapping: Record<string, string> | null | undefined,
  processEnv: Record<string, string>,
): ResolveRoleEnvResult {
  const resolved: Record<string, string> = {};
  const missing: string[] = [];
  for (const [key, secretLabel] of Object.entries(mapping ?? {})) {
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
 * The declared role env vars still unmet once everything THIS runner supplies
 * is counted: the agent env, the runner's own BUILDD_API_KEY and the
 * claim-delivered mcpSecrets (header expansion). The server's `roleEnvMissing`
 * only knows the secrets table, so it cannot see the runner-held key; without
 * this, every default role (they all declare BUILDD_API_KEY) read as degraded.
 */
export function unmetRoleEnv(
  missing: readonly string[],
  available: Record<string, string | undefined>,
): string[] {
  return [...new Set(missing)].filter(name => !available[name]);
}

/**
 * One entry per distinct (role, missing vars) gap this runner has seen, so the
 * warning is logged once per gap rather than once per worker, and the gap stays
 * visible in /api/debug/internals after the log line scrolls away.
 */
export class RoleEnvGapLog {
  private gaps = new Map<string, { role: string; missing: string[]; workers: number; firstSeen: number; lastSeen: number }>();

  /** Records a sighting; true when this exact gap is new (i.e. worth a warning). */
  record(role: string, missing: readonly string[], now = Date.now()): boolean {
    const sorted = [...new Set(missing)].sort();
    const key = `${role}|${sorted.join(',')}`;
    const cur = this.gaps.get(key);
    if (cur) {
      cur.workers++;
      cur.lastSeen = now;
      return false;
    }
    this.gaps.set(key, { role, missing: sorted, workers: 1, firstSeen: now, lastSeen: now });
    return true;
  }

  snapshot() {
    return [...this.gaps.values()].map(g => ({ ...g, missing: [...g.missing] }));
  }
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

/** Where a role-assigned session should run, and what it carries. */
export interface RoleCwdResolution {
  /** The directory to hand the session (before worktree isolation is applied). */
  cwd: string;
  /**
   * The role's bundle, held in memory for the task. Present only when the
   * claim carried a packaged role. Its files are written per session —
   * `materializeRoleBundle` for a repo-less cwd, `overlayRoleFiles` into a repo
   * cwd — and removed when the session ends.
   */
  roleBundle?: RoleBundle;
  /**
   * True when the session runs in a repo and the bundle must be overlaid into
   * it. The overlay must happen AFTER worktree setup, against the worktree:
   * `git worktree add` only checks out tracked content, so anything written into
   * the base clone first never arrives.
   */
  overlay?: boolean;
}

/**
 * Decide the session cwd for a task that resolved a role.
 *
 * The rule is the WORKSPACE, not the role's packaged `type`: a task whose
 * workspace has a repo runs in that repo, always. `type` is derived from the
 * role row's `repoUrl`, which the dashboard role editor never sets — so every
 * role saved from the UI packages as `'service'`, and keying cwd off it sent
 * repo tasks to a directory that is not a git checkout and has none of the
 * task's code in it.
 *
 * The bundle is fetched per claim. Nothing from an earlier task is reused from
 * disk: a role that was never packaged (every seeded default role) has no
 * files, only the persona the claim delivers inline.
 */
export async function resolveRoleCwd(
  roleConfig: RoleConfig | undefined | null,
  task: { roleSlug?: string | null; workspace?: { repo?: string | null } | null } | null | undefined,
  workspacePath: string,
  workerId: string,
): Promise<RoleCwdResolution> {
  if (!roleConfig) return { cwd: workspacePath };
  const roleBundle = await fetchRoleBundle(roleConfig);
  if (task?.workspace?.repo) return { cwd: workspacePath, roleBundle, overlay: true };
  // The role dir is the cwd. Created empty here so the path exists; its files
  // are written at session start (writeSessionRoleFiles) and removed at end.
  const roleDir = sessionRoleDir(workerId);
  claimPromptDir(workerId, roleDir, { gitignore: false });
  return { cwd: roleDir, roleBundle };
}

/**
 * Overlay a role bundle's `.mcp.json` into a repo directory, once per claim.
 * Used whenever cwd is the repo rather than the role dir.
 *
 * Role SKILLS are not written here: they are prompt text, written per session
 * by `writeSessionRoleFiles` and removed when the session ends. CLAUDE.md is
 * never overlaid: the repo's own CLAUDE.md is the project's. The role persona
 * reaches the agent through the system prompt — see
 * `buildRoleSystemPromptSection`.
 *
 * `repoDir` must be the session cwd (the worktree when worktree isolation is
 * on), not the base clone.
 */
export async function overlayRoleFiles(bundle: RoleBundle, repoDir: string): Promise<void> {
  const mcp = bundleMcpConfig(bundle);
  if (mcp) {
    // Merge with existing .mcp.json if present
    const mcpDest = join(repoDir, '.mcp.json');
    let existing: Record<string, unknown> = {};
    try {
      existing = JSON.parse(await readFile(mcpDest, 'utf-8'));
    } catch { /* no existing file */ }
    const merged = {
      ...existing,
      mcpServers: { ...(existing.mcpServers as Record<string, unknown> || {}), ...((mcp as any).mcpServers || {}) },
    };
    await writeFile(mcpDest, JSON.stringify(merged, null, 2));
  }
}

/**
 * Write a role bundle's files for one session: the session role dir when the
 * session runs in it, else an overlay into the session cwd. Called at the start
 * of every session (a resumed session re-writes what the previous one removed).
 */
export async function writeSessionRoleFiles(bundle: RoleBundle, sessionCwd: string, workerId: string): Promise<void> {
  if (sessionCwd === sessionRoleDir(workerId)) {
    await materializeRoleBundle(bundle, workerId);
  } else {
    await writeRoleSkills(bundle, sessionCwd, workerId);
  }
}
