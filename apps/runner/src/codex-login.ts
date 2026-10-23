/**
 * `buildd codex login` (spec a0b82b5d R-11): Codex's own login, run through the
 * native Codex binary the runner's @openai/codex-sdk already installed.
 *
 * A separately installed `codex` command is the npm package's `bin/codex.js`,
 * a Node script: on a fresh Ubuntu (WSL included) it fails with
 * "env: 'node': No such file or directory". The SDK never uses that script; it
 * spawns the platform package's binary under vendor/<triple>/bin. This does the
 * same, so the runner's machine needs Bun and nothing else. The terminal is
 * passed straight through (device login included); Codex writes its login where
 * it keeps it for this user, and buildd stores nothing.
 */
import { spawnSync } from 'child_process';
import { createRequire } from 'module';
import { statSync } from 'fs';
import { delimiter, dirname, join } from 'path';
import { fileURLToPath } from 'url';

// The same table @openai/codex-sdk's findCodexPath uses.
const TARGETS: Record<string, string> = {
  'linux-x64': 'x86_64-unknown-linux-musl',
  'linux-arm64': 'aarch64-unknown-linux-musl',
  'android-x64': 'x86_64-unknown-linux-musl',
  'android-arm64': 'aarch64-unknown-linux-musl',
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin',
  'win32-x64': 'x86_64-pc-windows-msvc',
  'win32-arm64': 'aarch64-pc-windows-msvc',
};
const PLATFORM_PACKAGE: Record<string, string> = {
  'x86_64-unknown-linux-musl': '@openai/codex-linux-x64',
  'aarch64-unknown-linux-musl': '@openai/codex-linux-arm64',
  'x86_64-apple-darwin': '@openai/codex-darwin-x64',
  'aarch64-apple-darwin': '@openai/codex-darwin-arm64',
  'x86_64-pc-windows-msvc': '@openai/codex-win32-x64',
  'aarch64-pc-windows-msvc': '@openai/codex-win32-arm64',
};

export interface BundledCodex { executablePath: string; pathDirs: string[] }

export interface CodexLocateDeps {
  platform: string;
  arch: string;
  /** Resolves a package specifier from `fromFile`, as require.resolve would; throws when absent. */
  resolve: (specifier: string, fromFile: string) => string;
  /** The SDK's entry file, the place resolution starts from. */
  sdkEntry: () => string;
  isFile: (path: string) => boolean;
  isDir: (path: string) => boolean;
}

const isFile = (p: string) => { try { return statSync(p).isFile(); } catch { return false; } };
const isDir = (p: string) => { try { return statSync(p).isDirectory(); } catch { return false; } };

export const realCodexLocateDeps = (): CodexLocateDeps => ({
  platform: process.platform,
  arch: process.arch,
  resolve: (specifier, fromFile) => createRequire(fromFile).resolve(specifier),
  sdkEntry: () => fileURLToPath(import.meta.resolve('@openai/codex-sdk')),
  isFile,
  isDir,
});

/**
 * The native Codex binary the SDK would spawn, or null. Never `bin/codex.js`:
 * that is a Node script, and this command exists so Codex needs no Node.
 */
export function locateBundledCodex(deps: CodexLocateDeps = realCodexLocateDeps()): BundledCodex | null {
  const triple = TARGETS[`${deps.platform}-${deps.arch}`];
  if (!triple) return null;
  try {
    const codexPkg = deps.resolve('@openai/codex/package.json', deps.sdkEntry());
    const platformPkg = deps.resolve(`${PLATFORM_PACKAGE[triple]}/package.json`, codexPkg);
    const root = join(dirname(platformPkg), 'vendor', triple);
    const name = deps.platform === 'win32' ? 'codex.exe' : 'codex';
    const bin = join(root, 'bin', name);
    if (deps.isFile(bin) && deps.isFile(join(root, 'codex-package.json'))) {
      return { executablePath: bin, pathDirs: [join(root, 'codex-path')].filter(deps.isDir) };
    }
    const legacy = join(root, 'codex', name);
    if (deps.isFile(legacy)) return { executablePath: legacy, pathDirs: [join(root, 'path')].filter(deps.isDir) };
  } catch { /* not installed */ }
  return null;
}

export type CodexLoginPlan =
  | { ok: true; file: string; args: string[]; env: Record<string, string | undefined> }
  | { ok: false; code: number; message: string };

const USAGE = 'Usage: buildd codex login [--device-auth | --with-api-key | status]  |  buildd codex logout';

/** What `buildd codex <args>` runs. Only Codex's own login and logout pass through. */
export function planCodexCommand(args: string[], bundled: BundledCodex | null, env: Record<string, string | undefined>): CodexLoginPlan {
  if (args[0] !== 'login' && args[0] !== 'logout') return { ok: false, code: 64, message: USAGE };
  if (!bundled) {
    return {
      ok: false,
      code: 1,
      message: "The runner's Codex binary was not found in ~/.buildd. Reinstall the runner (curl -fsSL https://buildd.dev/install.sh | bash), then run buildd codex login again.",
    };
  }
  const pathKey = Object.keys(env).find(k => k.toLowerCase() === 'path') ?? 'PATH';
  const rest = (env[pathKey] ?? '').split(delimiter).filter(e => e && !bundled.pathDirs.includes(e));
  return { ok: true, file: bundled.executablePath, args, env: { ...env, [pathKey]: [...bundled.pathDirs, ...rest].join(delimiter) } };
}

if (import.meta.main) {
  const plan = planCodexCommand(process.argv.slice(2), locateBundledCodex(), process.env);
  if (!plan.ok) {
    console.error(plan.message);
    process.exit(plan.code);
  }
  const r = spawnSync(plan.file, plan.args, { stdio: 'inherit', env: plan.env });
  if (r.error) {
    console.error(`Could not start ${plan.file}: ${r.error.message}`);
    process.exit(1);
  }
  process.exit(r.status ?? 1);
}
