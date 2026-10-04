/**
 * Per-session prompt files: role and skill text the runner writes to disk so a
 * session can discover it, and removes again when the session ends.
 *
 * Invariant: role and skill text is never left on the runner's disk between
 * sessions. Every file of it the runner writes lands either under
 * `<BUILDD_HOME>/session-prompts/<workerId>/` or in a directory recorded in that
 * worker's manifest, and `cleanupSessionPromptFiles` removes both when the
 * session ends. A runner that crashed mid-session leaves a manifest behind;
 * `sweepStaleSessionPromptFiles` at the next start removes what it lists.
 *
 * Only what the runner wrote is ever removed. Each directory it creates carries
 * a marker file naming the worker; cleanup removes a recorded directory only
 * when that marker is present and names the same worker, so a directory the
 * user (or a repo) put there is never touched. The user's own `~/.claude/skills`
 * is never written to.
 *
 * Every directory written inside a checkout also gets a `.gitignore` of `*`, so
 * an agent's `git add -A` cannot commit prompt text into a PR.
 */
// Namespace import on purpose: several runner test files mock.module('node:fs')
// with a partial surface, and a named import of a missing export is a load-time
// SyntaxError for every file that imports workers.ts.
import * as fs from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { resolveBuilddHome } from './buildd-home.js';

/** Marker file inside each runner-written prompt directory. Contents: the worker id. */
export const PROMPT_DIR_MARKER = '.buildd-session';

/** Legacy marker the old persistent skill cache left in `~/.claude/skills/<slug>/`. */
const LEGACY_SKILL_HASH_FILE = '.buildd-hash';

const MANIFEST = 'manifest.json';

interface Manifest {
  pid: number;
  workerId: string;
  /** Absolute directories the runner created outside the session dir. */
  paths: string[];
}

function builddHome(): string {
  return resolveBuilddHome();
}

/** `<BUILDD_HOME>/session-prompts` — the root every per-session dir lives under. */
export function sessionPromptRoot(): string {
  return join(builddHome(), 'session-prompts');
}

/** `<BUILDD_HOME>/session-prompts/<workerId>` — removed whole at session end. */
export function sessionPromptDir(workerId: string): string {
  return join(sessionPromptRoot(), safeSegment(workerId));
}

/** Where a role bundle is materialized for one session. */
export function sessionRoleDir(workerId: string): string {
  return join(sessionPromptDir(workerId), 'role');
}

function safeSegment(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, '_') || '_';
}

function readManifest(dir: string): Manifest | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(join(dir, MANIFEST), 'utf-8'));
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      pid: typeof parsed.pid === 'number' ? parsed.pid : 0,
      workerId: typeof parsed.workerId === 'string' ? parsed.workerId : '',
      paths: Array.isArray(parsed.paths) ? parsed.paths.filter((p: unknown): p is string => typeof p === 'string') : [],
    };
  } catch {
    return null;
  }
}

function writeManifest(dir: string, manifest: Manifest): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `${MANIFEST}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(manifest));
  fs.renameSync(tmp, join(dir, MANIFEST));
}

/** Ensure this worker's session dir and manifest exist (records the owning pid). */
export function ensureSessionPromptDir(workerId: string): string {
  const dir = sessionPromptDir(workerId);
  const existing = readManifest(dir);
  if (!existing || existing.pid !== process.pid) {
    writeManifest(dir, { pid: process.pid, workerId, paths: existing?.paths ?? [] });
  }
  return dir;
}

/**
 * Mark `dir` as runner-written for `workerId` and record it in the manifest so
 * cleanup (or the next start's sweep) removes it. Call BEFORE writing prompt
 * text into it: a crash between the two then still leaves a recorded path.
 */
export function claimPromptDir(workerId: string, dir: string, opts: { gitignore?: boolean } = {}): void {
  const sessionDir = ensureSessionPromptDir(workerId);
  if (!dir.startsWith(sessionDir + '/')) {
    const manifest = readManifest(sessionDir) ?? { pid: process.pid, workerId, paths: [] };
    if (!manifest.paths.includes(dir)) {
      manifest.paths.push(dir);
      writeManifest(sessionDir, manifest);
    }
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(join(dir, PROMPT_DIR_MARKER), workerId);
  if (opts.gitignore !== false) fs.writeFileSync(join(dir, '.gitignore'), '*\n');
}

/**
 * True when `dir` exists and was not written by this runner for `workerId` —
 * a skill the repo (or the user) already ships at that path. Callers leave it
 * alone rather than overwrite a tracked file.
 */
export function isForeignDir(workerId: string, dir: string): boolean {
  if (!fs.existsSync(dir)) return false;
  try {
    return fs.readFileSync(join(dir, PROMPT_DIR_MARKER), 'utf-8').trim() !== workerId;
  } catch {
    return true;
  }
}

function removeIfOwned(dir: string, workerId: string): boolean {
  try {
    if (fs.readFileSync(join(dir, PROMPT_DIR_MARKER), 'utf-8').trim() !== workerId) return false;
  } catch {
    return false; // no marker: not ours (or already gone)
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

/**
 * Remove every prompt file this worker's session wrote. Never throws.
 * Returns the recorded directories it removed.
 */
export function cleanupSessionPromptFiles(workerId: string): string[] {
  const removed: string[] = [];
  try {
    const dir = sessionPromptDir(workerId);
    const manifest = readManifest(dir);
    for (const p of manifest?.paths ?? []) {
      try {
        if (removeIfOwned(p, manifest?.workerId || workerId)) removed.push(p);
      } catch (err) {
        console.warn(`[Worker ${workerId}] Failed to remove session prompt dir ${p}:`, err);
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    console.warn(`[Worker ${workerId}] Session prompt cleanup failed:`, err);
  }
  return removed;
}

function defaultIsAlive(pid: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

export interface SweepResult {
  /** Session dirs removed (left by a runner that is no longer running). */
  sessions: string[];
  /** Legacy persistent-cache dirs removed. */
  legacy: string[];
}

/**
 * Crash recovery, run once at runner start: remove session prompt dirs (and
 * the paths their manifests list) whose owning process is gone, plus the
 * persistent caches older runners kept — `<BUILDD_HOME>/roles/` and the
 * runner-written `~/.claude/skills/<slug>/` dirs (identified by the
 * `.buildd-hash` file only the runner wrote; the user's own skills have none).
 *
 * A session dir owned by another live process (a second runner sharing this
 * BUILDD_HOME) is left alone. Never throws.
 */
export function sweepStaleSessionPromptFiles(opts: {
  isAlive?: (pid: number) => boolean;
  homeDir?: string;
} = {}): SweepResult {
  const isAlive = opts.isAlive ?? defaultIsAlive;
  const result: SweepResult = { sessions: [], legacy: [] };
  const root = sessionPromptRoot();
  try {
    for (const entry of fs.existsSync(root) ? fs.readdirSync(root) : []) {
      const dir = join(root, entry);
      const manifest = readManifest(dir);
      if (manifest && manifest.pid !== process.pid && isAlive(manifest.pid)) continue;
      cleanupSessionPromptFiles(manifest?.workerId || entry);
      // cleanupSessionPromptFiles keys on the worker id; a dir whose name does
      // not match it (hand-made, corrupt manifest) still goes.
      fs.rmSync(dir, { recursive: true, force: true });
      result.sessions.push(dir);
    }
  } catch (err) {
    console.warn('[session-prompts] Stale session sweep failed:', err);
  }

  try {
    const legacyRoles = join(builddHome(), 'roles');
    if (fs.existsSync(legacyRoles)) {
      fs.rmSync(legacyRoles, { recursive: true, force: true });
      result.legacy.push(legacyRoles);
    }
  } catch (err) {
    console.warn('[session-prompts] Legacy role cache sweep failed:', err);
  }

  try {
    const userSkills = join(opts.homeDir ?? homedir(), '.claude', 'skills');
    for (const slug of fs.existsSync(userSkills) ? fs.readdirSync(userSkills) : []) {
      const dir = join(userSkills, slug);
      if (fs.existsSync(join(dir, LEGACY_SKILL_HASH_FILE))) {
        fs.rmSync(dir, { recursive: true, force: true });
        result.legacy.push(dir);
      }
    }
  } catch (err) {
    console.warn('[session-prompts] Legacy skill cache sweep failed:', err);
  }
  return result;
}

/**
 * `claudeMdExcludes` patterns for the project memory files at `cwd` and every
 * ancestor. Used when a workspace opted out of CLAUDE.md (`useClaudeMd: false`)
 * but the session still needs the `project` setting source to discover the
 * skills written into `<cwd>/.claude/skills`.
 */
export function projectMemoryExcludes(cwd: string): string[] {
  const parts = cwd.replaceAll('\\', '/').split('/').filter(Boolean);
  const out: string[] = [];
  for (let i = parts.length; i >= 0; i--) {
    const base = i === 0 ? '' : '/' + parts.slice(0, i).join('/');
    out.push(`${base}/CLAUDE.md`, `${base}/CLAUDE.local.md`, `${base}/.claude/CLAUDE.md`, `${base}/.claude/rules/**`);
  }
  return [...new Set(out)];
}
