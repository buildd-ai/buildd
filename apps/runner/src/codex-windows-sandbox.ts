/**
 * Codex's own Windows sandbox, probed the way probeSeatbelt probes macOS
 * (Living Spec "Runner isolation", R-1, R-6).
 *
 * On Windows `codex exec --sandbox workspace-write` without `windows.sandbox`
 * set silently runs read-only, so the runner names the mode on every Codex run
 * and the probe checks that mode actually confines. buildd uses the
 * `unelevated` mode only: a restricted token for the runner's own user, which
 * needs no admin rights and changes nothing on the host. It confines writes to
 * the workspace and temp dirs but leaves the network open. The `elevated` mode
 * also blocks the network, but sets itself up per CODEX_HOME by creating local
 * accounts and firewall rules: a host security change buildd does not make.
 *
 * Namespace imports, not named ones: tests across the suite mock
 * child_process and fs with only the functions they use, and a named import
 * of anything else would fail to link.
 */
import * as childProcess from 'child_process';
import * as fs from 'fs';
import { createRequire } from 'module';
import { tmpdir } from 'os';
import { basename, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { resolveBuilddHome } from './buildd-home';

/** The `windows.sandbox` mode the runner probes and passes to Codex. */
export const CODEX_WINDOWS_SANDBOX_MODE = 'unelevated';

/** The Codex config override that selects it, for the SDK's `config` option. */
export const CODEX_WINDOWS_SANDBOX_CONFIG = { windows: { sandbox: CODEX_WINDOWS_SANDBOX_MODE } } as const;

const WINDOWS_TRIPLE: Record<string, string> = { x64: 'x86_64-pc-windows-msvc', arm64: 'aarch64-pc-windows-msvc' };

/**
 * The codex binary the Codex backend spawns: CODEX_PATH_OVERRIDE, else the one
 * @openai/codex-sdk bundles (resolved as the SDK's own findCodexPath does).
 * Null when neither can be found.
 */
export function resolveCodexBinary(env: Record<string, string | undefined> = process.env, arch: string = process.arch): string | null {
  if (env.CODEX_PATH_OVERRIDE) return env.CODEX_PATH_OVERRIDE;
  const triple = WINDOWS_TRIPLE[arch];
  if (!triple) return null;
  try {
    const sdk = fileURLToPath(import.meta.resolve('@openai/codex-sdk'));
    const codexPkg = createRequire(sdk).resolve('@openai/codex/package.json');
    const platformPkg = createRequire(codexPkg).resolve(`@openai/codex-win32-${arch}/package.json`);
    const bin = join(dirname(platformPkg), 'vendor', triple, 'bin', 'codex.exe');
    return fs.existsSync(bin) ? bin : null;
  } catch {
    return null;
  }
}

export interface CodexSandboxRun {
  /** Runs `codex sandbox ... -- cmd.exe /d /c <command>` in `cwd`; true when it exited 0. */
  (codexBin: string, cwd: string, codexHome: string, command: string): boolean;
}

// The temp dirs stay out of the probe's writable roots: in a fresh CODEX_HOME,
// Codex first grants its sandbox ACLs on every writable root, and on %TEMP%
// that took about a minute on a real host. (`-C` is not used: it requires a
// permissions profile; the spawn's cwd is the workspace.)
const runInCodexSandbox: CodexSandboxRun = (codexBin, cwd, codexHome, command) => {
  const r = childProcess.spawnSync(
    codexBin,
    [
      'sandbox',
      '-c', `windows.sandbox="${CODEX_WINDOWS_SANDBOX_MODE}"`,
      '-c', 'sandbox_mode="workspace-write"',
      '-c', 'sandbox_workspace_write.exclude_tmpdir_env_var=true',
      '-c', 'sandbox_workspace_write.exclude_slash_tmp=true',
      '--', 'cmd.exe', '/d', '/c', command,
    ],
    { cwd, env: { ...process.env, CODEX_HOME: codexHome }, timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  );
  return r.status === 0;
};

export interface CodexWindowsProbeDeps {
  codexBin(): string | null;
  run: CodexSandboxRun;
  /** Where the probe's workspace and its outside target go: not under the temp dir. */
  probeRoot(): string;
}

const realDeps: CodexWindowsProbeDeps = {
  codexBin: () => resolveCodexBinary(),
  run: runInCodexSandbox,
  probeRoot: () => resolveBuilddHome(),
};

/**
 * Does Codex's unelevated Windows sandbox confine here? Functional, not "it
 * started": a write inside the workspace must succeed and a write outside it
 * must be refused. Throwaway CODEX_HOME and dirs, removed afterwards.
 */
export function probeCodexWindowsSandbox(deps: CodexWindowsProbeDeps = realDeps): boolean {
  const bin = deps.codexBin();
  if (!bin) return false;
  let ws: string | null = null;
  let home: string | null = null;
  let outside: string | null = null;
  try {
    const root = deps.probeRoot();
    fs.mkdirSync(root, { recursive: true });
    ws = fs.mkdtempSync(join(root, 'codex-sbx-ws-'));
    outside = fs.mkdtempSync(join(root, 'codex-sbx-out-'));
    home = fs.mkdtempSync(join(tmpdir(), 'buildd-codex-sbx-home-'));
    // Relative targets: the names are ours and carry no spaces, so cmd needs no quoting.
    const wroteInside = deps.run(bin, ws, home, 'echo ok> inside.txt') && fs.existsSync(join(ws, 'inside.txt'));
    if (!wroteInside) return false;
    deps.run(bin, ws, home, `echo x> ..\\${basename(outside)}\\escaped.txt`);
    return !fs.existsSync(join(outside, 'escaped.txt'));
  } catch {
    return false;
  } finally {
    for (const dir of [ws, home, outside]) {
      if (dir) try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
}
