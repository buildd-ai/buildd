/**
 * `~/.local/bin/buildd-acp`: a one-line launcher for the ACP bridge, kept up to
 * date by the runner itself.
 *
 * Why not `buildd acp`: the `buildd` launcher writes itself at install time
 * only, and one written before `acp` existed runs it through the restart loop,
 * which cannot carry the protocol (cli-args.ts `acpLauncherRefusal`). So an ACP
 * client such as T3 Code would need the long `bun run …/acp/main.ts` form typed
 * in by hand. The runner already runs on every machine that can serve the
 * bridge, so it writes this shim at startup and every existing install gets a
 * short command on its next update: in T3 (WSL backend, an SSH host, or Linux
 * and macOS) the Local ACP command is just `buildd-acp`.
 *
 * Rules: rewrite only a file carrying our marker, never one someone else put
 * there; write nothing on Windows, where ACP clients launch without a shell and
 * cannot run a script (use bun.exe with the main.ts path there); and write only
 * from the installed runner, whose code lives inside its install dir. Any other
 * copy (CI's integration job checks buildd out to /tmp/buildd-ci on a machine
 * that has a real install and starts a runner from it; a dev clone) would
 * repoint the shim at code that may be gone minutes later. The installed runner
 * repairs a shim such a copy left behind on its next start.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join, posix, resolve } from 'path';
import type { RunnerAcpCapability } from '@buildd/shared';

export const ACP_SHIM_MARKER = '# buildd-acp: written by the buildd runner';

const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export function acpShimScript(bunPath: string, mainPath: string): string {
  return [
    '#!/bin/sh',
    ACP_SHIM_MARKER + ' on every start; edits are overwritten.',
    '# Serves this machine\'s buildd runner over the Agent Client Protocol on stdio.',
    `exec ${sq(bunPath)} run ${sq(mainPath)} "$@"`,
    '',
  ].join('\n');
}

export interface EnsureAcpShimOptions {
  home?: string;
  bunPath?: string;
  mainPath?: string;
  /** The runner install dir (BUILDD_HOME). The shim is written only when mainPath is inside it. */
  installDir: string;
  platform?: string;
}

export type AcpShimResult = 'written' | 'unchanged' | 'foreign' | 'skipped';

export function ensureAcpShim(opts: EnsureAcpShimOptions): AcpShimResult {
  if ((opts.platform ?? process.platform) === 'win32') return 'skipped';
  // POSIX paths: the shim only exists off Windows (and tests pass POSIX fixtures on a Windows host).
  const mainPath = posix.resolve(opts.mainPath ?? resolve(import.meta.dir, 'main.ts'));
  const install = posix.resolve(opts.installDir);
  if (!mainPath.startsWith(install.endsWith('/') ? install : install + '/')) return 'skipped';
  const dir = join(opts.home ?? homedir(), '.local', 'bin');
  const path = join(dir, 'buildd-acp');
  const script = acpShimScript(opts.bunPath ?? process.execPath, mainPath);
  if (existsSync(path)) {
    const current = readFileSync(path, 'utf8');
    if (!current.includes(ACP_SHIM_MARKER)) return 'foreign';
    if (current === script) return 'unchanged';
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return 'written';
}

export interface AcpCapabilityOptions {
  home?: string;
  /** The runner install dir (BUILDD_HOME). */
  installDir: string;
  version: string;
  bunPath?: string;
  mainPath?: string;
  platform?: string;
}

/**
 * What this runner reports about ACP in its environment scan (`environment.acp`).
 * buildd cannot see T3, so the runner is the only one who can say the bridge
 * works: where the shim is, whether it launches THIS install, and which build.
 * `shimPath` is null when no shim exists (Windows, or not yet written);
 * `target` is the main.ts the shim execs, null for a foreign file.
 */
export function acpCapability(opts: AcpCapabilityOptions): RunnerAcpCapability {
  const platform = opts.platform ?? process.platform;
  const bunPath = opts.bunPath ?? process.execPath;
  const mainPath = platform === 'win32' ? (opts.mainPath ?? resolve(import.meta.dir, 'main.ts')) : posix.resolve(opts.mainPath ?? resolve(import.meta.dir, 'main.ts'));
  const base = { version: opts.version, platform, bunPath, mainPath };
  if (platform === 'win32') return { ...base, shimPath: null, target: null, pointsHere: true };
  const path = join(opts.home ?? homedir(), '.local', 'bin', 'buildd-acp');
  if (!existsSync(path)) return { ...base, shimPath: null, target: null, pointsHere: false };
  let text = '';
  try { text = readFileSync(path, 'utf8'); } catch { /* unreadable: treated as foreign */ }
  const m = text.includes(ACP_SHIM_MARKER) ? text.match(/ run '((?:[^']|'\\'')*)'/) : null;
  const target = m ? m[1].replace(/'\\''/g, "'") : null;
  const install = posix.resolve(opts.installDir);
  const pointsHere = !!target && posix.resolve(target).startsWith(install.endsWith('/') ? install : install + '/');
  return { ...base, shimPath: path, target, pointsHere };
}
