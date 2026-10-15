/**
 * Boot preflight: make sure the runner's packages resolve BEFORE the runner's
 * own imports run (task c08b35ae).
 *
 * A missing package fails during module loading, before `index.ts` executes a
 * line, so nothing inside the runner can repair it. This runs from the Bun
 * preload (`scripts/stub-server-only.ts`), which every launcher passes
 * (`--preload .../scripts/stub-server-only.ts`) and which auto-update keeps
 * current. That is how installs whose launcher script was written long ago get
 * the repair: the launcher is written once by install.sh, this file is not.
 *
 * Node built-ins only (see package-tree.ts).
 */
import * as nodeFs from 'fs';
import { spawnSync as nodeSpawnSync } from 'child_process';
import { dirname, join } from 'path';
import { findMissingPackages, recoverInterruptedSwap } from './package-tree';

/** Bound on the repair install. */
export const PREFLIGHT_INSTALL_TIMEOUT_MS = 10 * 60_000;
/** A repair that already ran this recently and did not help is not repeated on every restart. */
export const PREFLIGHT_RETRY_COOLDOWN_MS = 10 * 60_000;
/** Exit code for "packages missing, repair did not work" (EX_CONFIG). */
export const PREFLIGHT_EXIT_CODE = 78;

const ATTEMPT_FILE = '.buildd-package-repair';

export interface PreflightDeps {
  fs: Pick<typeof nodeFs, 'existsSync' | 'renameSync' | 'rmSync' | 'readdirSync' | 'readFileSync' | 'writeFileSync'>;
  /** Runs `bun install`; returns the exit status (null on timeout or spawn failure). */
  install: (cwd: string, timeoutMs: number) => { status: number | null; error?: string };
  now: () => number;
  log: (line: string) => void;
}

export interface PreflightResult {
  ok: boolean;
  healed: boolean;
  missing: string[];
  /** The single plain line to show when `ok` is false. */
  message?: string;
}

function defaultInstall(cwd: string, timeoutMs: number): { status: number | null; error?: string } {
  const r = nodeSpawnSync(process.execPath, ['install', '--frozen-lockfile'], {
    cwd, timeout: timeoutMs, stdio: ['ignore', 'inherit', 'inherit'], killSignal: 'SIGKILL',
  });
  return { status: r.status, error: r.error ? String(r.error.message ?? r.error) : undefined };
}

export function fixLine(installDir: string): string {
  return `buildd: packages are missing from ${installDir}. Fix: cd ${installDir} && bun install`;
}

export function runPreflight(installDir: string, overrides: Partial<PreflightDeps> = {}): PreflightResult {
  const deps: PreflightDeps = {
    fs: nodeFs, install: defaultInstall, now: Date.now, log: (l) => console.error(l), ...overrides,
  };
  const { fs, log } = deps;

  // An update killed between "move the old packages aside" and its outcome.
  const restored = recoverInterruptedSwap(installDir, fs);
  if (restored.length > 0) log(`buildd: restored the previous packages after an interrupted update (${restored.length} folder(s))`);

  let missing = findMissingPackages(installDir, fs);
  if (missing.length === 0) return { ok: true, healed: restored.length > 0, missing: [] };

  const attemptFile = join(installDir, ATTEMPT_FILE);
  let lastAttempt = 0;
  try { lastAttempt = Number(String(fs.readFileSync(attemptFile, 'utf-8')).trim()) || 0; } catch { /* never tried */ }
  if (lastAttempt && deps.now() - lastAttempt < PREFLIGHT_RETRY_COOLDOWN_MS) {
    log('buildd: an automatic package repair already ran a few minutes ago and did not fix this; not retrying yet.');
    return { ok: false, healed: false, missing, message: fixLine(installDir) };
  }

  try { fs.writeFileSync(attemptFile, String(deps.now())); } catch { /* read-only home: still try */ }
  log(`buildd: packages are missing (${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ', ...' : ''}); running bun install in ${installDir}`);
  const r = deps.install(installDir, PREFLIGHT_INSTALL_TIMEOUT_MS);
  missing = findMissingPackages(installDir, fs);
  if (missing.length === 0) {
    try { fs.rmSync(attemptFile, { force: true }); } catch { /* marker only */ }
    log('buildd: packages repaired');
    return { ok: true, healed: true, missing: [] };
  }
  log(`buildd: bun install ${r.status === null ? `did not finish (${r.error ?? 'timed out'})` : `exited ${r.status}`}`);
  return { ok: false, healed: false, missing, message: fixLine(installDir) };
}

/** Entries the preflight guards. login/logout/install run on built-ins only. */
const GUARDED_ENTRY = /[\\/]apps[\\/]runner[\\/]src[\\/](index|service)\.ts$/;

/**
 * Called from the preload with the entry script's path. Exits with one plain
 * line when the packages cannot be repaired; otherwise returns.
 */
export function preflightForEntry(entry: string, env: Record<string, string | undefined> = process.env): void {
  if (!GUARDED_ENTRY.test(entry) || env.BUILDD_SKIP_PREFLIGHT === '1') return;
  const installDir = dirname(dirname(dirname(dirname(entry)))); // .../apps/runner/src/index.ts -> install root
  if (nodeFs.existsSync(join(installDir, '.client-only'))) return;
  const result = runPreflight(installDir);
  if (!result.ok) {
    console.error(result.message);
    process.exit(PREFLIGHT_EXIT_CODE);
  }
}
