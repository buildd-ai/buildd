/**
 * Codex's own Windows sandbox, probed the way probeSeatbelt probes macOS
 * (Living Spec "Runner isolation", R-1, R-6).
 *
 * On Windows `codex exec --sandbox workspace-write` without `windows.sandbox`
 * set silently runs read-only, so the runner names the mode on every Codex run
 * and the probe checks that mode actually confines. buildd prefers explicit
 * MXC, then the unelevated restricted token for the runner's own user. Neither
 * requires administrator provisioning. Codex may ACL its disposable writable
 * roots. The worker's network remains open. The `elevated` mode
 * can restrict the network, but sets itself up per CODEX_HOME by creating local
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

export type WindowsSandboxImplementation = 'mxc' | 'unelevated';
export type WindowsSandboxMode = 'read-only' | 'workspace-write';
export type WindowsSandboxModes = Record<WindowsSandboxMode, WindowsSandboxImplementation | null>;

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
  /** True only when cmd exited 0 and its success marker proves the command ran. */
  (codexBin: string, cwd: string, codexHome: string, command: string, implementation?: WindowsSandboxImplementation, mode?: WindowsSandboxMode): boolean;
}

// The temp dirs stay out of the probe's writable roots: in a fresh CODEX_HOME,
// Codex first grants its sandbox ACLs on every writable root, and on %TEMP%
// that took about a minute on a real host. The spawn's cwd is the workspace.
export const runInCodexSandbox: CodexSandboxRun = (codexBin, cwd, codexHome, command, implementation = 'unelevated', mode = 'workspace-write') => {
  const r = childProcess.spawnSync(
    codexBin,
    [
      'sandbox',
      '--include-managed-config',
      '--permission-profile', mode === 'read-only' ? ':read-only' : ':workspace',
      '-c', `windows.sandbox="${implementation}"`,
      '-c', 'features.prefer_mxc=false',
      '-c', `sandbox_mode="${mode}"`,
      '-c', 'sandbox_workspace_write.network_access=true',
      '-c', 'sandbox_workspace_write.exclude_tmpdir_env_var=true',
      '-c', 'sandbox_workspace_write.exclude_slash_tmp=true',
      '--', 'cmd.exe', '/d', '/c', command,
    ],
    { cwd, env: { ...process.env, CODEX_HOME: codexHome }, timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  );
  return r.status === 0 && r.stdout?.toString().includes('BUILDD_SANDBOX_CONTROL_OK') === true;
};

export interface CodexWindowsProbeDeps {
  codexBin(): string | null;
  run: CodexSandboxRun;
  /** Where the probe's workspace and its outside target go: not under the temp dir. */
  probeRoot(): string;
  /** Startup rechecks the actual worker home, including managed requirements. */
  codexHome?: string;
}

const realDeps: CodexWindowsProbeDeps = {
  codexBin: () => resolveCodexBinary(),
  run: runInCodexSandbox,
  probeRoot: () => resolveBuilddHome(),
};

/**
 * Does the selected implementation enforce this permission mode? Workspace
 * writes succeed only in workspace-write; outside writes never succeed. Both
 * commands must actually run. The supplied worker home is never removed.
 */
export function probeCodexWindowsSandbox(deps: CodexWindowsProbeDeps = realDeps, implementation: WindowsSandboxImplementation = 'unelevated', mode: WindowsSandboxMode = 'workspace-write'): boolean {
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
    home = deps.codexHome ?? fs.mkdtempSync(join(tmpdir(), 'buildd-codex-sbx-home-'));
    // Positive host control: absence is meaningful only for a writable target.
    const escaped = join(outside, 'escaped.txt');
    const inside = join(ws, 'inside.txt');
    fs.writeFileSync(inside, 'host-control');
    fs.unlinkSync(inside);
    fs.writeFileSync(escaped, 'host-control');
    fs.unlinkSync(escaped);
    // Relative targets: the names are ours and carry no spaces, so cmd needs no quoting.
    // Always finish successfully when cmd actually ran, even if the write was
    // denied. A launch failure/timeout is not evidence of confinement.
    const insideRan = deps.run(bin, ws, home, '(echo ok> inside.txt) 2>nul & echo BUILDD_SANDBOX_CONTROL_OK', implementation, mode);
    if (!insideRan || fs.existsSync(join(ws, 'inside.txt')) !== (mode === 'workspace-write')) return false;
    const outsideRan = deps.run(bin, ws, home, `(echo x> ..\\${basename(outside)}\\escaped.txt) 2>nul & echo BUILDD_SANDBOX_CONTROL_OK`, implementation, mode);
    return outsideRan && !fs.existsSync(join(outside, 'escaped.txt'));
  } catch {
    return false;
  } finally {
    for (const dir of [ws, deps.codexHome ? null : home, outside]) {
      if (dir) try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
}

/** Explicit MXC fails closed; never use prefer_mxc's implicit legacy fallback.
 * Elevated setup can provision accounts/firewall per home, so it is deliberately
 * not a candidate. Both implementations remain write-only in buildd: the worker
 * requires network_access=true for git/MCP. No network scope is inferred here.
 */
export function probeCodexWindowsModes(deps: CodexWindowsProbeDeps = realDeps): WindowsSandboxModes {
  const result: WindowsSandboxModes = { 'read-only': null, 'workspace-write': null };
  for (const mode of ['read-only', 'workspace-write'] as const) {
    for (const implementation of ['mxc', 'unelevated'] as const) {
      if (probeCodexWindowsSandbox(deps, implementation, mode)) {
        result[mode] = implementation;
        break;
      }
    }
  }
  return result;
}

/** No fallback on startup failure, even for an opted-in run: its advertised
 * confinement is no longer verified. The caller must report the failed attempt.
 */
export function verifiedWindowsSandboxConfig(
  binary: string, home: string, mode: WindowsSandboxMode, implementation: WindowsSandboxImplementation,
  deps: Pick<CodexWindowsProbeDeps, 'run' | 'probeRoot'> = realDeps,
) {
  if (!binary || !home || !probeCodexWindowsSandbox({ ...deps, codexBin: () => binary, codexHome: home }, implementation, mode)) {
    throw new Error(`Windows sandbox startup probe failed (${implementation}, ${mode}); not running with less confinement.`);
  }
  return { windows: { sandbox: implementation }, features: { prefer_mxc: false }, sandbox_workspace_write: { network_access: true } };
}
