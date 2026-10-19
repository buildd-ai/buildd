/**
 * `buildd top --dev` / `buildd top-dev`: run `buildd top` from the newest
 * `dev` commit while the runner stays on production.
 *
 * The dev build lives in its own checkout (BUILDD_DEV_DIR, default
 * ~/.buildd-dev), never in ~/.buildd: the runner's auto-update resets that
 * tree, so a worktree of it or a branch switch in it would be undone or would
 * undo an update. Each run fetches `origin dev`, moves the checkout to it,
 * runs `bun install` only when bun.lock changed since the last install, then
 * runs top from it. Only top: the dev checkout never starts a runner
 * (cli-args.ts refuseInDevCheckout), so nothing from dev claims work.
 *
 * Reached from the production checkout's own CLI entry (index.ts), so every
 * existing launcher gets it on the next auto-update: install.sh writes the
 * launcher once and passes `top` / `top-dev` straight to index.ts.
 *
 * The production checkout is only ever read: its origin URL, whether it is
 * shallow or sparse, and (for a full clone) its objects through
 * `git clone --reference --dissociate`.
 *
 * Opt-in per machine, because it runs unreleased code and is for buildd
 * contributors: `buildd config set devChannel on` (config.json `devChannel`),
 * or BUILDD_DEV_CHANNEL=1 for one run. Without either it clones and fetches
 * nothing and says how to turn it on. `buildd config set devChannel off`
 * offers to delete the dev copy, but only one this command made.
 */
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { dirname, join, resolve, sep } from 'path';
import { widenSparseCheckout } from './updater';
import { writeSecretJsonFile } from './secure-file';
import { UnreadableConfigError } from './runner-name';

export const DEV_BRANCH = 'dev';
const DEFAULT_REPO_URL = 'https://github.com/buildd-ai/buildd.git';
const NETWORK_TIMEOUT_MS = 120_000;
const LOCAL_TIMEOUT_MS = 30_000;
const INSTALL_TIMEOUT_MS = 10 * 60_000;
/** Inside .git, so it is never an untracked file: says this checkout is ours to reset. */
const OWNED_MARKER = 'buildd-dev-checkout';
/** The bun.lock blob the last successful install was for. */
const INSTALLED_MARKER = 'buildd-dev-installed-lock';
/** The launcher's restart code (install.sh): top must never hand it back. */
const LAUNCHER_RESTART = 75;

export interface CmdResult { code: number; stdout: string; stderr: string }

export interface TopDevDeps {
  git(args: string[], cwd: string, timeoutMs?: number): Promise<CmdResult>;
  install(dir: string): Promise<{ code: number; stderr: string }>;
  /** Run `index.ts top <args>` from `dir` with `env` added; resolves with its exit code. */
  runTop(dir: string, args: string[], env: Record<string, string>): Promise<number>;
  /** One line for the person, before top takes the screen. */
  log(line: string): void;
}

export interface TopDevOptions {
  prodDir: string;
  devDir: string;
  topArgs: string[];
  /** config.json, for the `devChannel` opt-in. */
  configFile: string;
  /** For BUILDD_DEV_CHANNEL; process.env by default. */
  env?: Record<string, string | undefined>;
  deps?: Partial<TopDevDeps>;
}

// ── opt-in ─────────────────────────────────────────────────────────────────

export const DEV_CHANNEL_ENV = 'BUILDD_DEV_CHANNEL';
/** The one line a run without opt-in prints. */
export const DEV_CHANNEL_OFF = 'buildd top --dev runs unreleased code from dev, for buildd contributors. Turn it on with: buildd config set devChannel on';
const FIRST_RUN_NOTE = 'buildd: this is unreleased code from dev and it may break; buildd top is the released one.';

function readConfigObject(file: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** On for this run: BUILDD_DEV_CHANNEL=1 (one run), or `devChannel` on in config.json. */
export function devChannelEnabled(configFile: string, env: Record<string, string | undefined> = process.env): boolean {
  if (/^(1|true|on|yes)$/i.test(env[DEV_CHANNEL_ENV]?.trim() ?? '')) return true;
  const saved = existsSync(configFile) ? readConfigObject(configFile)?.devChannel : undefined;
  return saved === true || saved === 'on';
}

/** True only for a checkout this command made (its marker inside .git). */
function isOwnedDevCheckout(devDir: string): boolean {
  return existsSync(join(devDir, '.git', OWNED_MARKER));
}

export interface DevChannelSetOptions {
  configFile: string;
  prodDir: string;
  devDir: string;
  /** Ask a yes/no question; null when there is no terminal (keeps the dev copy). */
  confirm: ((question: string) => Promise<boolean>) | null;
}

/** `buildd config set devChannel on|off`. */
export async function setDevChannel(on: boolean, opts: DevChannelSetOptions): Promise<CmdResult> {
  let cfg: Record<string, unknown> = {};
  if (existsSync(opts.configFile)) {
    const existing = readConfigObject(opts.configFile);
    if (!existing) return { code: 1, stdout: '', stderr: `buildd: ${new UnreadableConfigError(opts.configFile).message}` };
    cfg = existing;
  }
  cfg.devChannel = on;
  writeSecretJsonFile(opts.configFile, cfg);
  if (on) return { code: 0, stdout: 'buildd top --dev is on for this machine. It runs unreleased code from dev; buildd top stays on the release.', stderr: '' };

  const lines = ['buildd top --dev is off for this machine.'];
  const own = !isInside(opts.devDir, opts.prodDir) && !isInside(opts.prodDir, opts.devDir) && isOwnedDevCheckout(opts.devDir);
  if (own) {
    const yes = opts.confirm ? await opts.confirm(`Delete ${opts.devDir}, the dev copy buildd top --dev made? [y/N] `) : false;
    if (yes) {
      rmSync(opts.devDir, { recursive: true, force: true });
      lines.push(`Deleted ${opts.devDir}.`);
    } else {
      lines.push(`Kept ${opts.devDir}; delete it whenever you like.`);
    }
  }
  return { code: 0, stdout: lines.join('\n'), stderr: '' };
}

export function defaultDevDir(env: Record<string, string | undefined> = process.env): string {
  return env.BUILDD_DEV_DIR || join(homedir(), '.buildd-dev');
}

/** An inherited GIT_DIR / GIT_WORK_TREE would point every call at another repo. */
function cleanGitEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete env[k];
  // Never stop for a credential prompt: top is about to take the terminal.
  env.GIT_TERMINAL_PROMPT = '0';
  return env;
}

async function spawnCapture(cmd: string[], cwd: string, timeoutMs: number, env: Record<string, string>): Promise<CmdResult> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(cmd, { cwd, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  } catch (err: any) {
    return { code: 127, stdout: '', stderr: err?.message ?? String(err) };
  }
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; try { proc.kill('SIGKILL'); } catch { /* gone */ } }, timeoutMs);
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return { code: timedOut ? 124 : code, stdout, stderr: timedOut ? `timed out after ${Math.round(timeoutMs / 1000)}s` : stderr };
}

const defaultDeps: TopDevDeps = {
  git: (args, cwd, timeoutMs = LOCAL_TIMEOUT_MS) => spawnCapture(['git', ...args], cwd, timeoutMs, cleanGitEnv()),
  install: (dir) => spawnCapture([process.execPath, 'install', '--frozen-lockfile'], dir, INSTALL_TIMEOUT_MS, cleanGitEnv()),
  runTop: async (dir, args, env) => {
    const proc = Bun.spawn([
      process.execPath, '--no-env-file', 'run',
      '--preload', join(dir, 'scripts', 'stub-server-only.ts'),
      join(dir, 'apps', 'runner', 'src', 'index.ts'), 'top', ...args,
    ], { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit', env: { ...process.env, ...env } });
    // A service-style stop reaches this process, not top: hand it on.
    const forward = (sig: NodeJS.Signals) => () => { try { proc.kill(sig); } catch { /* gone */ } };
    const handlers = (['SIGTERM', 'SIGHUP'] as const).map(sig => [sig, forward(sig)] as const);
    for (const [sig, h] of handlers) process.on(sig, h);
    const code = await proc.exited;
    for (const [sig, h] of handlers) process.off(sig, h);
    return code;
  },
  log: (line) => { process.stderr.write(line + '\n'); },
};

/** The last line git printed, for a one-line reason. */
function lastLine(text: string): string {
  const line = text.split('\n').map(l => l.trim()).filter(Boolean).pop() ?? '';
  return line.replace(/^(fatal|error):\s*/, '').slice(0, 160) || 'unknown error';
}

function isInside(child: string, parent: string): boolean {
  const c = resolve(child);
  const p = resolve(parent);
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

type Prepared =
  | { ok: true; sha: string; stale: string | null }
  | { ok: false; message: string };

export async function prepareDevCheckout(prodDir: string, devDir: string, deps: TopDevDeps): Promise<Prepared> {
  const { git } = deps;
  if (isInside(devDir, prodDir) || isInside(prodDir, devDir)) {
    return { ok: false, message: `BUILDD_DEV_DIR (${devDir}) must be a folder of its own, outside the production install (${prodDir}). Nothing changed.` };
  }

  let stale: string | null = null;
  let previous: string | null = null;
  const fresh = !existsSync(join(devDir, '.git'));

  if (fresh) {
    if (existsSync(devDir)) {
      return { ok: false, message: `${devDir} already exists and is not a buildd dev checkout. Move it, or set BUILDD_DEV_DIR to another folder. Nothing changed.` };
    }
    const origin = await git(['remote', 'get-url', 'origin'], prodDir);
    const url = origin.code === 0 && origin.stdout.trim() ? origin.stdout.trim() : DEFAULT_REPO_URL;
    // A shallow repo cannot lend its objects (git refuses it as a --reference),
    // and install.sh makes ~/.buildd shallow; a depth-1 fetch of one dev commit
    // is about as cheap, so that is what such an install gets.
    const shallow = await git(['rev-parse', '--is-shallow-repository'], prodDir);
    const canReference = shallow.code === 0 && shallow.stdout.trim() === 'false';
    mkdirSync(dirname(devDir), { recursive: true });
    const clone = await git([
      'clone', '--quiet', '--no-checkout', '--single-branch', '--branch', DEV_BRANCH,
      ...(canReference ? ['--reference', prodDir, '--dissociate'] : ['--depth', '1']),
      url, devDir,
    ], dirname(devDir), NETWORK_TIMEOUT_MS);
    if (clone.code !== 0) {
      rmSync(devDir, { recursive: true, force: true });
      return {
        ok: false,
        message: `Could not download the dev build (${lastLine(clone.stderr)}). The first buildd top --dev needs the network; buildd top still runs the production build.`,
      };
    }
    writeFileSync(join(devDir, '.git', OWNED_MARKER), 'Managed by buildd top --dev; it resets this checkout to origin/dev on every run.\n');
    // The same runner-only tree as the production install, when it is sparse.
    const sparse = await git(['config', '--get', 'core.sparseCheckout'], prodDir);
    const sparseFile = join(prodDir, '.git', 'info', 'sparse-checkout');
    if (sparse.stdout.trim() === 'true' && existsSync(sparseFile)) {
      await git(['config', 'core.sparseCheckout', 'true'], devDir);
      mkdirSync(join(devDir, '.git', 'info'), { recursive: true });
      writeFileSync(join(devDir, '.git', 'info', 'sparse-checkout'), readFileSync(sparseFile, 'utf-8'));
    }
    const reset = await git(['reset', '--quiet', '--hard', `origin/${DEV_BRANCH}`], devDir);
    if (reset.code !== 0) {
      rmSync(devDir, { recursive: true, force: true });
      return { ok: false, message: `Could not check out the dev build (${lastLine(reset.stderr)}). Nothing changed in the production install.` };
    }
  } else {
    if (!existsSync(join(devDir, '.git', OWNED_MARKER))) {
      return { ok: false, message: `${devDir} is a git checkout buildd did not make, so buildd top --dev will not reset it. Set BUILDD_DEV_DIR to another folder. Nothing changed.` };
    }
    const head = await git(['rev-parse', 'HEAD'], devDir);
    previous = head.code === 0 ? head.stdout.trim() : null;
    const shallow = (await git(['rev-parse', '--is-shallow-repository'], devDir)).stdout.trim() === 'true';
    const fetch = await git([
      'fetch', '--quiet', ...(shallow ? ['--depth', '1'] : []),
      'origin', `+refs/heads/${DEV_BRANCH}:refs/remotes/origin/${DEV_BRANCH}`,
    ], devDir, NETWORK_TIMEOUT_MS);
    if (fetch.code !== 0) {
      stale = `the fetch failed: ${lastLine(fetch.stderr)}`;
    } else {
      const reset = await git(['reset', '--quiet', '--hard', `origin/${DEV_BRANCH}`], devDir);
      if (reset.code !== 0) stale = `could not check out the newest dev commit: ${lastLine(reset.stderr)}`;
    }
  }

  // A release can add a workspace package the runner imports (updater.ts).
  if (!stale) {
    await widenSparseCheckout(devDir, async (args, cwd, timeoutMs) => {
      const r = await git(args, cwd, timeoutMs);
      if (r.code !== 0) throw new Error(lastLine(r.stderr));
      return r.stdout.trim();
    }).catch(() => []);
  }

  // Packages: only when the lockfile changed since the last install that worked.
  const lockId = async () => {
    const r = await git(['rev-parse', 'HEAD:bun.lock'], devDir);
    return r.code === 0 ? r.stdout.trim() : 'none';
  };
  const markerFile = join(devDir, '.git', INSTALLED_MARKER);
  const installedFor = existsSync(markerFile) ? readFileSync(markerFile, 'utf-8').trim() : null;
  const wanted = await lockId();
  if (wanted !== installedFor || !existsSync(join(devDir, 'node_modules'))) {
    deps.log(fresh ? 'buildd: installing packages for the dev build (first run)...' : 'buildd: the dev build changed its packages; running bun install...');
    const install = await deps.install(devDir);
    if (install.code === 0) {
      writeFileSync(markerFile, wanted + '\n');
    } else if (previous && installedFor && previous !== (await git(['rev-parse', 'HEAD'], devDir)).stdout.trim()) {
      // Back to the commit whose packages are installed: an older top beats none.
      await git(['reset', '--quiet', '--hard', previous], devDir);
      stale = `bun install failed for the newest dev commit: ${lastLine(install.stderr)}`;
    } else {
      return { ok: false, message: `bun install failed in the dev checkout (${lastLine(install.stderr)}). Fix: cd ${devDir} && bun install` };
    }
  }

  const sha = (await git(['rev-parse', '--short=7', 'HEAD'], devDir)).stdout.trim();
  if (stale) {
    const when = (await git(['log', '-1', '--format=%cr'], devDir)).stdout.trim();
    stale = `Could not update the dev build (${stale}); showing dev ${sha}${when ? ` from ${when}` : ''}.`;
  }
  return { ok: true, sha, stale };
}

/** Prepare the dev checkout and run top from it. Resolves with the exit code. */
export async function runTopDev(opts: TopDevOptions): Promise<number> {
  const deps: TopDevDeps = { ...defaultDeps, ...opts.deps };
  if (!devChannelEnabled(opts.configFile, opts.env ?? process.env)) {
    deps.log(DEV_CHANNEL_OFF);
    return 1;
  }
  if (!existsSync(join(opts.devDir, '.git'))) deps.log(FIRST_RUN_NOTE);
  const prepared = await prepareDevCheckout(opts.prodDir, opts.devDir, deps);
  if (!prepared.ok) {
    deps.log(`buildd: ${prepared.message}`);
    return 1;
  }
  if (prepared.stale) deps.log(`buildd: ${prepared.stale}`);
  const env: Record<string, string> = {
    BUILDD_TOP_CHANNEL: 'dev',
    BUILDD_TOP_BUILD: prepared.sha,
    ...(prepared.stale ? { BUILDD_TOP_NOTICE: prepared.stale, BUILDD_TOP_STALE: '1' } : {}),
  };
  const code = await deps.runTop(opts.devDir, opts.topArgs, env);
  return code === LAUNCHER_RESTART ? 1 : code;
}
