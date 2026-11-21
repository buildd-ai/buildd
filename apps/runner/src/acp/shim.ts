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
 * cannot run a script (use bun.exe with the main.ts path there).
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';

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
  platform?: string;
}

export type AcpShimResult = 'written' | 'unchanged' | 'foreign' | 'skipped';

export function ensureAcpShim(opts: EnsureAcpShimOptions = {}): AcpShimResult {
  if ((opts.platform ?? process.platform) === 'win32') return 'skipped';
  const dir = join(opts.home ?? homedir(), '.local', 'bin');
  const path = join(dir, 'buildd-acp');
  const script = acpShimScript(opts.bunPath ?? process.execPath, opts.mainPath ?? resolve(import.meta.dir, 'main.ts'));
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
