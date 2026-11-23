/**
 * Every workspace this runner can claim, as a T3 Code project.
 *
 * T3 keeps its own project list; a repo the runner cloned (or one already on
 * disk) did not appear in it until someone added it by hand, so a workspace
 * was not findable in T3 before its first task. On a machine with T3
 * installed, the runner now lists the key's workspaces on start and every
 * SYNC_INTERVAL_MS, clones the ones it has no clone of, and adds each clone
 * through `t3 project add`, T3's own CLI (never its database).
 *
 * Why clone rather than register lazily: T3 refuses a project whose folder does
 * not exist, and opening a project tells the runner nothing, so there is no
 * "first open" to clone on. The clone is the same full host clone the claim's
 * auto-clone makes (git-clone.ts explains why not a partial clone), so the
 * first task on that workspace finds it and clones nothing.
 *
 * Finding the clone goes through the resolver (resolveExisting), the lookup a
 * claim makes, so T3 shows the folder tasks will run in. A miss clones to
 * `<first project root>/<repo name>`, the auto-clone path, by way of a hidden
 * sibling renamed into place: the repo scan skips dot folders, and a claim that
 * auto-clones the same repo meanwhile wins (the rename then fails and the temp
 * is dropped). A folder already at that path that is not this repo is left
 * alone. Async throughout: a sync clone froze the runner (index.ts clone API).
 *
 * Off: BUILDD_T3_PROJECTS=off, and wherever it does not apply (see index.ts):
 * no T3 binary, Windows, a cloud executor, --once, serverless, or per-workspace
 * isolation (whose clones are the agents', not the person's).
 */
import { execFile } from 'child_process';
import { existsSync, renameSync, rmSync } from 'fs';
import { basename, dirname, join } from 'path';
import { homedir } from 'os';
import { gitArgsAsync } from './git-async';
import { cloneArgs, normalizeCloneUrl } from './git-clone';
import { CLONE_URL_RE, normalizeGitUrl } from './workspace';

export const SYNC_INTERVAL_MS = 30 * 60_000;
/** First pass after start: after the startup claims, not competing with them. */
export const SYNC_FIRST_DELAY_MS = 30_000;
/** A clone that failed (a private repo this machine cannot read, say) is not tried again sooner. */
export const CLONE_RETRY_AFTER_MS = 6 * 60 * 60_000;
const CLONE_TIMEOUT_MS = 10 * 60_000;
const T3_TIMEOUT_MS = 30_000;

export interface T3Workspace {
  id: string;
  name: string;
  repo?: string | null;
}

export interface T3SyncDeps {
  listWorkspaces(): Promise<T3Workspace[]>;
  /** The workspace's local clone as a claim would find it, without cloning; null on a miss. */
  findLocal(ws: T3Workspace): Promise<string | null>;
  /** Clone `cloneUrl` to `path`; throws on failure. */
  cloneInto(cloneUrl: string, path: string): Promise<void>;
  addProject(path: string, title: string): Promise<'added' | 'exists'>;
  pathExists(path: string): boolean;
  /** Tell the resolver about new clones. */
  rescan(): Promise<void>;
  log(message: string): void;
  now(): number;
}

export interface T3SyncResult {
  added: string[];
  cloned: string[];
  skipped: { repo: string; reason: string }[];
  failed: { repo: string; error: string }[];
}

export function createT3ProjectSync(deps: T3SyncDeps, opts: { root: string }) {
  /** Paths T3 has (we added them, or it already had them): never asked about again. */
  const known = new Set<string>();
  /** Normalized repo -> when its last clone failed. */
  const cloneFailedAt = new Map<string, number>();
  let running: Promise<T3SyncResult> | null = null;

  const pass = async (): Promise<T3SyncResult> => {
    const result: T3SyncResult = { added: [], cloned: [], skipped: [], failed: [] };
    const seenRepos = new Set<string>();
    const paths: string[] = [];

    for (const ws of await deps.listWorkspaces()) {
      if (!ws.repo) continue;
      const key = normalizeGitUrl(ws.repo) ?? ws.repo;
      if (seenRepos.has(key)) continue;
      seenRepos.add(key);

      const local = await deps.findLocal(ws);
      if (local) { paths.push(local); continue; }

      const cloneUrl = normalizeCloneUrl(ws.repo);
      if (!CLONE_URL_RE.test(cloneUrl)) {
        result.skipped.push({ repo: ws.repo, reason: 'invalid repo URL' });
        continue;
      }
      const repoName = cloneUrl.split('/').pop()?.replace(/\.git$/, '');
      if (!repoName) continue;
      const target = join(opts.root, repoName);
      if (deps.pathExists(target)) {
        result.skipped.push({ repo: ws.repo, reason: `${target} already exists and is not a clone of it` });
        continue;
      }
      const failedAt = cloneFailedAt.get(key);
      if (failedAt !== undefined && deps.now() - failedAt < CLONE_RETRY_AFTER_MS) continue;

      try {
        deps.log(`[t3-projects] cloning ${cloneUrl} into ${target} for workspace "${ws.name}"`);
        await deps.cloneInto(cloneUrl, target);
        cloneFailedAt.delete(key);
        result.cloned.push(target);
        paths.push(target);
      } catch (err) {
        cloneFailedAt.set(key, deps.now());
        result.failed.push({ repo: ws.repo, error: errorText(err) });
      }
    }

    if (result.cloned.length > 0) await deps.rescan().catch(() => {});

    for (const path of new Set(paths)) {
      if (known.has(path)) continue;
      try {
        if (await deps.addProject(path, basename(path)) === 'added') result.added.push(path);
        known.add(path);
      } catch (err) {
        result.failed.push({ repo: path, error: errorText(err) });
      }
    }

    if (result.added.length || result.cloned.length || result.failed.length) {
      deps.log(`[t3-projects] added ${result.added.length} project(s), cloned ${result.cloned.length}` +
        (result.failed.length ? `; failed: ${result.failed.map(f => `${f.repo} (${f.error})`).join(', ')}` : ''));
    }
    return result;
  };

  return {
    /** One pass; a call while one runs gets that pass. */
    run(): Promise<T3SyncResult> {
      running ??= pass().finally(() => { running = null; });
      return running;
    },
  };
}

function errorText(err: unknown): string {
  const e = err as { stderr?: string; message?: string };
  const text = (e?.stderr || e?.message || String(err)).trim();
  return text.split('\n').find(l => /error|fatal/i.test(l))?.trim() ?? text.split('\n')[0];
}

/**
 * `git clone` into a hidden sibling of `target`, then rename it into place.
 * Throws when the clone fails or `target` appeared meanwhile; either way the
 * temp is gone and `target` untouched.
 */
export async function cloneIntoPlace(cloneUrl: string, target: string, env: Record<string, string | undefined> = process.env): Promise<void> {
  const parent = dirname(target);
  const temp = join(parent, `.${basename(target)}.buildd-clone-${process.pid}`);
  rmSync(temp, { recursive: true, force: true });
  try {
    await gitArgsAsync(cloneArgs(cloneUrl, temp, env), { cwd: parent, timeoutMs: CLONE_TIMEOUT_MS });
    if (existsSync(target)) throw new Error(`${target} appeared during the clone`);
    renameSync(temp, target);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

/** `t3 project add <path> --title <title>`. */
export function t3AddProject(t3Bin: string, path: string, title: string): Promise<'added' | 'exists'> {
  return new Promise((resolve, reject) => {
    execFile(t3Bin, ['project', 'add', path, '--title', title], { timeout: T3_TIMEOUT_MS }, (err, stdout, stderr) => {
      if (!err) return resolve('added');
      // T3 0.1.x logs its errors on stdout.
      const text = `${stdout ?? ''}\n${stderr ?? ''}\n${err.message}`;
      if (/ProjectAlreadyExistsError/.test(text)) return resolve('exists');
      reject(new Error(text.split('\n').find(l => /Error/.test(l))?.trim() ?? err.message));
    });
  });
}

/** The T3 CLI: its installer's `~/.local/bin/t3`, else `t3` on the PATH; null when T3 is not installed. */
export function findT3Binary(opts: { home?: string; which?: (cmd: string) => string | null } = {}): string | null {
  const local = join(opts.home ?? homedir(), '.local', 'bin', 't3');
  if (existsSync(local)) return local;
  return (opts.which ?? ((c) => Bun.which(c)))('t3');
}
