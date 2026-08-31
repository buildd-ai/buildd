import { existsSync } from 'fs';
import { dirname, isAbsolute, join, resolve } from 'path';
import { homedir } from 'os';
import { spawn } from 'child_process';
import type { SpawnOptions, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';

export type MountMode = 'ro' | 'rw';

export interface ExtraMount {
  path: string;
  mode: MountMode;
}

/**
 * A mount as planned by the builder.
 *
 * `required` marks a bind the session cannot function without. An absent
 * optional mount is dropped with a warning (the historical behaviour, which is
 * right for e.g. a missing ~/.npm); an absent required mount is an error,
 * because dropping it silently redirects the consumer somewhere harmless-looking
 * but wrong — a dropped CBM cache bind leaves the agent indexing into the
 * sandbox's own `--tmpfs /tmp`, which is discarded when the session ends.
 */
interface PlannedMount extends ExtraMount {
  required?: boolean;
}

export const CBM_BINARY_PATH = '/opt/buildd/bin/codebase-memory-mcp';

export interface WorkerBwrapConfig {
  worktreePath: string;
  repoPath: string;
  homePath?: string;
  bunInstallPath?: string;
  claudeConfigDir?: string;
  codexHome?: string;
  isCodexTask: boolean;
  executablePath?: string;
  extraMounts?: string;
  /** ro-bind the codebase-memory-mcp binary (pre-baked in the worker image). */
  cbmBinaryPath?: string;
  /** rw-bind the per-worker CBM cache dir (must be pre-created by the caller). */
  cbmCacheDir?: string;
  /**
   * rw-bind the CBM daemon runtime dir when it is NOT nested inside cbmCacheDir.
   * In shared-cache mode the cache is host-wide and the runtime dir is per-worker
   * at /tmp/cbm-rt-<id>, so it needs its own mount or the daemon cannot bind its
   * socket and CBM refuses to start.
   */
  cbmRuntimeDir?: string;
  pathExists?: (path: string) => boolean;
  warn?: (message: string) => void;
}

const SYSTEM_RO_BINDS = [
  '/usr',
  '/bin',
  '/lib',
  '/lib64',
  '/usr/local',
  '/etc/ssl',
  '/etc/resolv.conf',
  '/etc/nsswitch.conf',
] as const;

export function isMountAllowlistEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.BUILDD_SANDBOX_MOUNT_ALLOWLIST === '1' && env.BUILDD_DISABLE_SANDBOX !== '1';
}

/**
 * Should this worker's agent process be wrapped in the outer bwrap namespace?
 *
 * Codex is excluded: the outer argv is delivered through the Claude Agent SDK's
 * `spawnClaudeCodeProcess` hook, and the Codex backend spawns its own process
 * with no equivalent seam. Building the argv for a Codex task produced a value
 * that was then discarded — wasted work that also read as coverage. Codex tasks
 * therefore run without the outer mount allowlist; that downgrade is a known gap,
 * not an accident.
 */
export function shouldWrapWorkerInBwrap(opts: {
  isCodexTask: boolean;
  mountAllowlistEnabled: boolean;
  bwrapSupported: boolean;
}): boolean {
  return !opts.isCodexTask && opts.mountAllowlistEnabled && opts.bwrapSupported;
}

export function parseExtraMounts(
  value: string | undefined,
  warn: (message: string) => void = message => console.warn(`[runner] ${message}`),
): ExtraMount[] {
  if (!value?.trim()) return [];

  const mounts: ExtraMount[] = [];
  for (const rawEntry of value.split(',')) {
    const entry = rawEntry.trim();
    if (!entry) continue;

    const modeMatch = entry.match(/:(ro|rw)$/);
    const path = modeMatch ? entry.slice(0, -modeMatch[0].length) : entry;
    const trailingSegment = entry.slice(entry.lastIndexOf(':') + 1);
    if (!modeMatch && entry.includes(':') && (trailingSegment === 'ro' || trailingSegment === 'rw') === false) {
      warn(`Skipping invalid BUILDD_MOUNT_ALLOWLIST_EXTRA entry "${entry}": mode must be ro or rw`);
      continue;
    }
    if (!isAbsolute(path)) {
      warn(`Skipping invalid BUILDD_MOUNT_ALLOWLIST_EXTRA entry "${entry}": path must be absolute`);
      continue;
    }
    mounts.push({ path: resolve(path), mode: modeMatch?.[1] as MountMode | undefined ?? 'ro' });
  }
  return mounts;
}

function parentDirs(path: string): string[] {
  const dirs: string[] = [];
  let current = dirname(path);
  while (current !== '/') {
    dirs.push(current);
    current = dirname(current);
  }
  return dirs.reverse();
}

export function buildWorkerBwrapArgv(config: WorkerBwrapConfig): string[] {
  const pathExists = config.pathExists ?? existsSync;
  const warn = config.warn ?? (message => console.warn(`[runner] ${message}`));
  const home = resolve(config.homePath ?? homedir());
  const bunInstall = resolve(config.bunInstallPath ?? join(home, '.bun'));
  // Built-in binds. These are decided by the runner, not by operator input, and
  // must be assembled in full before any operator entry is considered — see the
  // collision filter below.
  const builtins: PlannedMount[] = [
    { path: resolve(config.worktreePath), mode: 'rw' },
    // Linked worktrees store refs, index state, and newly-created objects under
    // the parent clone's .git/worktrees/<id> and .git/objects directories.
    // Commit and push therefore require this project-scoped store to be writable.
    { path: resolve(config.repoPath, '.git'), mode: 'rw' },
    ...SYSTEM_RO_BINDS.map(path => ({ path, mode: 'ro' as const })),
    { path: bunInstall, mode: 'ro' },
    { path: join(bunInstall, 'install', 'cache'), mode: 'rw' },
    { path: join(home, '.npm'), mode: 'rw' },
  ];

  if (config.executablePath) builtins.push({ path: resolve(config.executablePath), mode: 'ro' });
  if (config.isCodexTask) {
    if (config.codexHome) builtins.push({ path: resolve(config.codexHome), mode: 'rw' });
  } else if (config.claudeConfigDir) {
    builtins.push({ path: resolve(config.claudeConfigDir), mode: 'rw' });
  } else {
    builtins.push(
      { path: join(home, '.claude', '.credentials.json'), mode: 'ro' },
      { path: join(home, '.claude', 'settings.json'), mode: 'ro' },
    );
  }
  // CBM cannot degrade gracefully around any of these: without the binary the
  // MCP server never starts, and without the cache or runtime dir the index and
  // the daemon state land in the throwaway tmpfs. All are required, so an absent
  // one throws below.
  if (config.cbmBinaryPath) builtins.push({ path: resolve(config.cbmBinaryPath), mode: 'ro', required: true });
  if (config.cbmCacheDir) builtins.push({ path: resolve(config.cbmCacheDir), mode: 'rw', required: true });
  if (config.cbmRuntimeDir) builtins.push({ path: resolve(config.cbmRuntimeDir), mode: 'rw', required: true });

  // Operator entries are additive only. Deduping by path with a Map keeps the
  // LAST value for a path, so appending operator input after the built-ins let a
  // colliding entry silently *replace* a system bind — including upgrading it to
  // rw. Built-in binds are the sandbox's contract: reject the collision instead.
  const builtinPaths = new Set(builtins.map(mount => mount.path));
  const operatorMounts = parseExtraMounts(config.extraMounts, warn).filter(mount => {
    if (!builtinPaths.has(mount.path)) return true;
    warn(
      `Rejecting BUILDD_MOUNT_ALLOWLIST_EXTRA entry "${mount.path}:${mount.mode}": `
      + 'it collides with a built-in sandbox bind, and operator input may not override one',
    );
    return false;
  });
  const mounts: PlannedMount[] = [...builtins, ...operatorMounts];

  const present = mounts.filter(mount => {
    if (pathExists(mount.path)) return true;
    if (mount.required) {
      throw new Error(
        `Required sandbox mount is missing: "${mount.path}". Refusing to build a bwrap argv that `
        + 'silently drops it — the consumer would fall through to the sandbox tmpfs instead.',
      );
    }
    warn(`Skipping unavailable sandbox mount "${mount.path}"`);
    return false;
  });
  const deduped = [...new Map(present.map(mount => [mount.path, mount])).values()];
  const dirs = [...new Set(deduped.flatMap(mount => parentDirs(mount.path)))];

  const argv = ['--die-with-parent', '--new-session', '--unshare-user', '--unshare-pid', '--uid', '0', '--gid', '0', '--tmpfs', '/'];
  for (const dir of dirs) argv.push('--dir', dir);
  argv.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/dev/shm', '--tmpfs', '/tmp', '--ro-bind', '/sys', '/sys');
  for (const mount of deduped) {
    argv.push(mount.mode === 'rw' ? '--bind' : '--ro-bind', mount.path, mount.path);
  }
  return argv;
}

export function createBwrapSpawn(
  bwrapArgv: readonly string[],
  onNamespaceDenied?: () => void,
): (options: SpawnOptions) => SpawnedProcess {
  return options => {
    const child = spawn('bwrap', [...bwrapArgv, '--', options.command, ...options.args], {
      cwd: options.cwd,
      env: options.env,
      signal: options.signal,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (onNamespaceDenied) {
      let reported = false;
      child.stderr.on('data', chunk => {
        if (
          !reported
          && /bwrap: (?:No permissions to create a new namespace|Creating new namespace failed)/i.test(String(chunk))
        ) {
          reported = true;
          onNamespaceDenied();
        }
      });
    }
    return child;
  };
}
