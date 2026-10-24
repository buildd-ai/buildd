/**
 * The host part of this runner's identity (spec a0b82b5d "Windows runner
 * through WSL2", part 4).
 *
 * WSL2 reports the Windows computer name as its hostname, so a runner inside
 * WSL and a native Windows runner on the same machine would share the headless
 * key `headless://<hostname>` and overwrite one heartbeat row. Inside WSL the
 * runner goes by `<hostname>-wsl` instead (R-22): its headless key, the broker's
 * runner id and its default display name (R-23). Every other host keeps its
 * hostname, so a native Windows runner's key never changes.
 */
import { mkdirSync, writeFileSync, existsSync } from 'fs';
import { hostname as osHostname } from 'os';
import { join } from 'path';
import type { RunnerHostPlatform } from '@buildd/shared';
import { detectHostPlatform } from './isolation-probe';

export interface RunnerHostDeps {
  hostname?: string;
  platform?: RunnerHostPlatform;
}

const WSL_SUFFIX = '-wsl';

let _platform: RunnerHostPlatform | null = null;
function hostPlatform(): RunnerHostPlatform {
  return (_platform ??= detectHostPlatform().platform);
}

export function isWslHost(deps: RunnerHostDeps = {}): boolean {
  return (deps.platform ?? hostPlatform()) === 'linux-wsl';
}

/** The hostname, with `-wsl` added inside WSL (R-22). */
export function runnerHostName(deps: RunnerHostDeps = {}): string {
  const host = deps.hostname ?? osHostname();
  if (!isWslHost(deps)) return host;
  return host.toLowerCase().endsWith(WSL_SUFFIX) ? host : `${host}${WSL_SUFFIX}`;
}

/** A headless runner's heartbeat key: the identity the claim route matches pins against. */
export function headlessRunnerKey(deps: RunnerHostDeps = {}): string {
  return `headless://${runnerHostName(deps)}`;
}

const NOTICE_MARKER = '.wsl-identity';

/**
 * R-26: inside WSL, say once that this runner heartbeats under its own key, not
 * the `headless://<hostname>` a WSL runner used before (and a Windows runner on
 * this machine uses). Null when there is nothing to say: a native host, or the
 * notice was already given. Never throws: a start must not fail over a notice.
 */
export function wslIdentityNotice(deps: RunnerHostDeps & { builddHome: string }): string | null {
  const shared = `headless://${deps.hostname ?? osHostname()}`;
  const own = headlessRunnerKey(deps);
  if (own === shared) return null;
  const marker = join(deps.builddHome, NOTICE_MARKER);
  try {
    if (existsSync(marker)) return null;
    mkdirSync(deps.builddHome, { recursive: true });
    writeFileSync(marker, `${new Date().toISOString()}\n`);
  } catch {
    // Unwritable home: say it this time; it may be said again next start.
  }
  return `This runner is inside WSL, so it runs as ${own}, apart from a Windows runner on this machine (${shared}). ` +
    `Earlier versions used ${shared} here too: that row ages out as offline, and tasks pinned to it wait for the Windows runner.`;
}
