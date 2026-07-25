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
  const mounts: ExtraMount[] = [
    { path: resolve(config.worktreePath), mode: 'rw' },
    { path: resolve(config.repoPath, '.git'), mode: 'ro' },
    ...SYSTEM_RO_BINDS.map(path => ({ path, mode: 'ro' as const })),
    { path: bunInstall, mode: 'ro' },
    { path: join(bunInstall, 'install', 'cache'), mode: 'rw' },
    { path: join(home, '.npm'), mode: 'rw' },
  ];

  if (config.executablePath) mounts.push({ path: resolve(config.executablePath), mode: 'ro' });
  if (config.isCodexTask) {
    if (config.codexHome) mounts.push({ path: resolve(config.codexHome), mode: 'rw' });
  } else if (config.claudeConfigDir) {
    mounts.push({ path: resolve(config.claudeConfigDir), mode: 'rw' });
  } else {
    mounts.push(
      { path: join(home, '.claude', '.credentials.json'), mode: 'ro' },
      { path: join(home, '.claude', 'settings.json'), mode: 'ro' },
    );
  }
  mounts.push(...parseExtraMounts(config.extraMounts, warn));

  const present = mounts.filter(mount => {
    if (pathExists(mount.path)) return true;
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
