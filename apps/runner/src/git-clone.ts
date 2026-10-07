/**
 * The workspace clone, and what to do when GitHub throttles it.
 *
 * Shape. A host runner clones in full, as it always has. A cloud container
 * (BUILDD_EXECUTOR=cloud, one task per container, nothing kept afterwards
 * except the warm snapshot) clones the least it can: `--depth 1
 * --single-branch --branch <workspace default branch>` (plain
 * `--single-branch`, the remote HEAD, when the default branch is not known).
 * On a big repo with thousands of branches and tags, every-branch-at-depth
 * downloads gigabytes and takes minutes; one branch at depth 1 takes seconds.
 *  - a depth, not a partial clone (`--filter`): the warm snapshot and park
 *    bundles are `git bundle`s, which cannot be made from a repo with missing
 *    blobs without fetching them, and lazy blob fetches turn ordinary
 *    `git log -p` / `diff` into a stream of GitHub requests.
 *  - single-branch also narrows `remote.origin.fetch` to that branch, so a
 *    later plain `git fetch origin` brings only it, incrementally. Widening the
 *    refspec would be worse: a shallow repo then fetches every other branch's
 *    history down to its root.
 *  - every other branch the runner needs (a mission integration branch, a
 *    resume branch, the task's own pushed branch, a PR base) is fetched on
 *    demand, by name, at CLOUD_BRANCH_FETCH_DEPTH: ensureRemoteBranch below.
 *    Its callers: setupWorktree (base and resume candidates, the
 *    stale-local-branch check), the PR base after setup (workers.ts), the
 *    path-claim base refresh (path-claim-enforcement.ts refreshBaseRef), PR
 *    stats (collectGitStats) and a resumed park (park.ts applyParkRepo).
 * A worktree cut from `origin/<branch>`, a push of a new branch, PR stats
 * (merge-base against the ref the worktree was cut from) and later fetches all
 * work on it unchanged. The warm snapshot carries the shallow boundary
 * (warm-repo.ts) and a park bundle fetches a missing prerequisite by id
 * (park.ts).
 *
 * Throttling. GitHub answers a clone or fetch it is throttling with HTTP 429
 * (or a 403 that says "rate limit"). That is retried after Retry-After, read
 * through the same egress as git (park.ts probeRetryAfter), with exponential
 * backoff when there is none, within a total wait budget. An answer that will
 * not change (401, a plain 403, 404) is not retried. A clone that is still
 * throttled at the end throws a GitCloneError marked `throttled`, and the repo
 * is remembered for a short window so the resolver's fallback paths do not
 * send the same request again at once; the claim path reports the task as an
 * infrastructure failure (workers.ts), which buildd requeues with backoff.
 *
 * Synchronous, like the resolver that calls it.
 */
import { spawnSync } from 'child_process';
import { rmSync } from 'fs';

export const CLOUD_CLONE_DEPTH = 1;
/**
 * How much of a branch an on-demand fetch brings into a shallow clone: enough
 * recent history for the agent to read, and for a branch cut a few commits
 * back to find its merge base.
 */
export const CLOUD_BRANCH_FETCH_DEPTH = 50;
/** Most a clone waits, in total, for GitHub to stop throttling it. */
export const CLONE_RETRY_BUDGET_MS = 60_000;
const BACKOFF_BASE_MS = 2_000;
const HOST_CLONE_TIMEOUT_MS = 120_000;
/** A cloud container has one task and a big repo can take minutes even shallow. */
const CLOUD_CLONE_TIMEOUT_MS = 10 * 60_000;
/** How long a throttled repo is not cloned again in this process (at least). */
const THROTTLE_MEMORY_MS = 60_000;

type Env = Record<string, string | undefined>;

export function isCloudExecutor(env: Env): boolean {
  return env.BUILDD_EXECUTOR === 'cloud';
}

/** `owner/repo` slugs become GitHub HTTPS URLs; anything else is returned as is. */
export function normalizeCloneUrl(repo: string): string {
  return /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repo) ? `https://github.com/${repo}.git` : repo;
}

/**
 * A branch name safe to hand git as an argument: a refname shape, never
 * something git would read as an option.
 */
export function isSafeBranchName(branch: string | null | undefined): branch is string {
  return typeof branch === 'string'
    && /^(?![-/.])(?!.*(\.\.|\/\/|@\{|\.lock$|\/$|\.$))[A-Za-z0-9._/-]{1,200}$/.test(branch);
}

export function cloneArgs(cloneUrl: string, clonePath: string, env: Env, branch?: string | null): string[] {
  if (!isCloudExecutor(env)) return ['clone', cloneUrl, clonePath];
  return [
    'clone', '--depth', String(CLOUD_CLONE_DEPTH), '--single-branch',
    ...(isSafeBranchName(branch) ? ['--branch', branch] : []),
    cloneUrl, clonePath,
  ];
}

/** git's answer to `clone --branch X` when the remote has no X. */
function remoteBranchNotFound(stderr: string): boolean {
  return /remote branch .* not found in upstream/i.test(stderr);
}

/** GitHub throttling, from git's stderr: an HTTP 429, or rate-limit wording (a secondary limit arrives as a 403). */
export function isGithubThrottle(stderr: string): boolean {
  return /\b429\b/.test(stderr) || /rate limit|too many requests/i.test(stderr);
}

/** A Retry-After value (seconds, or an HTTP date) as whole seconds from now, or null. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | null {
  const v = (value ?? '').trim();
  if (/^\d+$/.test(v)) return Number(v);
  if (!/[a-z]/i.test(v)) return null;
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, Math.ceil((at - now) / 1000)) : null;
}

/**
 * How long to wait before running a git network command again, or null to
 * stop. Shared by the clone (here) and the park resume fetch (park.ts).
 *
 * A throttled answer waits for Retry-After when there is one; anything else
 * that may be transient backs off exponentially; an answer that will not
 * change (401, a 403 that is not a rate limit, 404, repository not found, bad
 * credentials) is not retried. Never past `budgetMs` of waiting in total.
 * `beyondBudget`: what to do with a Retry-After longer than what is left:
 * `stop` (retrying early only spends another request), or `remaining` (wait
 * out the budget and try once more).
 */
export function gitRetryDelayMs(o: {
  attempt: number;
  stderr: string;
  retryAfterS: number | null;
  waitedMs: number;
  budgetMs: number;
  beyondBudget: 'stop' | 'remaining';
}): number | null {
  const remaining = o.budgetMs - o.waitedMs;
  if (remaining <= 0) return null;
  const throttled = isGithubThrottle(o.stderr);
  const code = /returned error: (\d{3})/.exec(o.stderr)?.[1];
  if (code && code.startsWith('4') && code !== '408' && code !== '429' && !throttled) return null;
  if (/repository not found|authentication failed|could not read username/i.test(o.stderr)) return null;
  if (o.retryAfterS !== null && throttled) {
    const wait = o.retryAfterS * 1000;
    if (wait > remaining) return o.beyondBudget === 'stop' ? null : remaining;
    return wait;
  }
  return Math.min(BACKOFF_BASE_MS * 2 ** o.attempt, remaining);
}

/** A clone failure that another try may fix: throttling, a 5xx/408, or the network dropping. */
function transientCloneFailure(stderr: string): boolean {
  // A missing local path is permanent; its name must not trip the keyword matches below.
  if (/^fatal: repository '.*' does not exist$/m.test(stderr)) return false;
  if (isGithubThrottle(stderr)) return true;
  const code = /returned error: (\d{3})/.exec(stderr)?.[1] ?? /\bHTTP (\d{3})\b/.exec(stderr)?.[1];
  if (code) return code.startsWith('5') || code === '408';
  return /RPC failed|early EOF|unexpected disconnect|could not resolve host|connection (reset|refused|timed out)|operation timed out|gnutls|openssl|\bssl[_ ]/i.test(stderr);
}

/**
 * The clone's retry policy: only failures another try may fix (a missing
 * repo, a bad URL or a full disk are not), CLONE_RETRY_BUDGET_MS in total, and
 * never earlier than Retry-After.
 */
export function cloneRetryDelayMs(o: { attempt: number; stderr: string; retryAfterS: number | null; waitedMs: number }): number | null {
  if (!transientCloneFailure(o.stderr)) return null;
  return gitRetryDelayMs({ ...o, budgetMs: CLONE_RETRY_BUDGET_MS, beyondBudget: 'stop' });
}

/** Block this thread for `ms` (the resolver and restore are synchronous). */
export function sleepSync(ms: number): void {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Retry-After from origin's smart-HTTP endpoint, for an https remote: one
 * header read through the same egress as git (so it carries the same
 * credential). Null on anything unexpected.
 */
export function probeRetryAfter(remoteUrl: string): number | null {
  if (!/^https:\/\//i.test(remoteUrl)) return null;
  const url = `${remoteUrl.replace(/\/+$/, '')}/info/refs?service=git-upload-pack`;
  const r = spawnSync('curl', ['-s', '-o', '/dev/null', '-D', '-', '--max-time', '10', url], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
  const header = /^retry-after:\s*(.+)$/im.exec(r.stdout ?? '')?.[1];
  return header ? parseRetryAfter(header) : null;
}

/** git's reason for a failure, from stderr: its fatal/error lines, else the last line, else how it ended. */
function failureText(r: { status: number | null; stderr: string; signal: NodeJS.Signals | null }): string {
  const lines = r.stderr.split('\n').map(l => l.trim()).filter(Boolean);
  const causes = lines.filter(l => /^(fatal|error|remote):/i.test(l));
  if (causes.length) return causes.slice(0, 4).join('; ').slice(0, 500);
  if (lines.length) return lines.at(-1)!.slice(0, 500);
  return r.signal ? `killed by ${r.signal}` : `exit ${r.status ?? 'unknown'}`;
}

export class GitCloneError extends Error {
  constructor(message: string, readonly throttled: boolean) {
    super(message);
    this.name = 'GitCloneError';
  }
}

// ── Throttle memory ───────────────────────────────────────────────────────────

const throttledUntil = new Map<string, number>();

function throttleKey(cloneUrl: string): string {
  return normalizeCloneUrl(cloneUrl).replace(/\.git$/, '').replace(/\/+$/, '').toLowerCase();
}

/** Set when a clone of this repo ended throttled, until GitHub is likely to answer again. */
export function cloneThrottledRecently(repo: string, now = Date.now()): { until: number } | null {
  const until = throttledUntil.get(throttleKey(repo));
  return until !== undefined && until > now ? { until } : null;
}

export function noteCloneThrottled(repo: string, retryAfterS: number | null, now = Date.now()): void {
  throttledUntil.set(throttleKey(repo), now + Math.max(THROTTLE_MEMORY_MS, (retryAfterS ?? 0) * 1000));
}

/** Tests only. */
export function clearCloneThrottles(): void {
  throttledUntil.clear();
}

// ── Clone ─────────────────────────────────────────────────────────────────────

export type GitRun = (args: string[], timeoutMs: number) => { status: number | null; stderr: string; signal: NodeJS.Signals | null };

const realGit: GitRun = (args, timeoutMs) => {
  const r = spawnSync('git', args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs });
  // Keep git's progress/errors visible in the runner log, as execSync did.
  if (r.stderr) process.stderr.write(r.stderr);
  return { status: r.status, stderr: r.stderr ?? '', signal: r.signal };
};

/** Most a fetch of an existing clone waits for GitHub in total (the resume fetch's budget, park.ts). */
export const FETCH_RETRY_BUDGET_MS = 30_000;

/**
 * `git fetch -q origin` in `clonePath`, retried on the shared policy within
 * FETCH_RETRY_BUDGET_MS. git's reason on final failure, null on success.
 */
export function fetchOriginWithRetry(clonePath: string, opts: Omit<CloneOptions, 'env'> & { timeoutMs?: number } = {}): string | null {
  const run = opts.run ?? ((args: string[], timeoutMs: number) => {
    const r = spawnSync('git', args, { cwd: clonePath, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs });
    return { status: r.status, stderr: r.stderr ?? '', signal: r.signal };
  });
  const sleep = opts.sleep ?? sleepSync;
  const retryAfter = opts.retryAfter ?? probeRetryAfter;
  const log = opts.log ?? ((m: string) => console.warn(m));
  let waited = 0;
  for (let attempt = 0; ; attempt++) {
    const r = run(['fetch', '-q', 'origin'], opts.timeoutMs ?? CLOUD_CLONE_TIMEOUT_MS);
    if (r.status === 0) return null;
    const reason = failureText(r);
    let retryAfterS: number | null = null;
    if (/\b429\b/.test(r.stderr)) {
      const remote = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: clonePath, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
      const url = (remote.stdout ?? '').trim();
      retryAfterS = url ? retryAfter(url) : null;
    }
    const delay = r.signal ? null : gitRetryDelayMs({ attempt, stderr: r.stderr, retryAfterS, waitedMs: waited, budgetMs: FETCH_RETRY_BUDGET_MS, beyondBudget: 'remaining' });
    if (delay === null) return reason;
    log(`[fetch] ${isGithubThrottle(r.stderr) ? 'rate limited by GitHub' : 'failed'} (${reason}); retrying in ${Math.round(delay / 1000)}s`);
    sleep(delay);
    waited += delay;
  }
}

export interface CloneOptions {
  env?: Env;
  /** The workspace default branch (gitConfig.defaultBranch). Cloud only: the one branch cloned. */
  branch?: string | null;
  run?: GitRun;
  sleep?(ms: number): void;
  /** Retry-After (seconds) for the repo after a 429, or null. */
  retryAfter?(cloneUrl: string): number | null;
  log?(message: string): void;
  now?(): number;
}

/**
 * `git clone` with the shape above, retried while GitHub throttles it. Throws
 * GitCloneError (`throttled` when GitHub was still throttling at the end, or
 * when this repo was throttled moments ago and no request was sent).
 */
export function cloneRepo(cloneUrl: string, clonePath: string, opts: CloneOptions = {}): void {
  const env = opts.env ?? process.env;
  const run = opts.run ?? realGit;
  const sleep = opts.sleep ?? sleepSync;
  const retryAfter = opts.retryAfter ?? probeRetryAfter;
  const log = opts.log ?? ((m: string) => console.warn(m));
  const now = opts.now ?? Date.now;

  const recent = cloneThrottledRecently(cloneUrl, now());
  if (recent) {
    throw new GitCloneError(`GitHub is rate limiting clones of this repo; not retrying until ${new Date(recent.until).toISOString()}`, true);
  }

  const cloud = isCloudExecutor(env);
  let branch = cloud && isSafeBranchName(opts.branch) ? opts.branch : null;
  let args = cloneArgs(cloneUrl, clonePath, env, branch);
  const timeout = cloud ? CLOUD_CLONE_TIMEOUT_MS : HOST_CLONE_TIMEOUT_MS;
  let waited = 0;
  let lastRetryAfter: number | null = null;
  for (let attempt = 0; ; attempt++) {
    const r = run(args, timeout);
    if (r.status === 0) {
      // `--single-branch --branch X` leaves refs/remotes/origin/HEAD unset;
      // the park and warm paths read the default branch from it. Local only.
      if (branch) run(['-C', clonePath, 'remote', 'set-head', 'origin', branch], 30_000);
      return;
    }
    const reason = failureText(r);
    const throttled = isGithubThrottle(r.stderr);
    // git removes a failed clone's directory itself; make sure, so the retry
    // (or the next resolver) does not find a half-written one.
    rmSync(clonePath, { recursive: true, force: true });
    if (branch && remoteBranchNotFound(r.stderr)) {
      // The workspace's configured default branch is not on the remote (a
      // rename, a typo): take the remote HEAD rather than fail the clone.
      log(`[clone] the remote has no branch "${branch}"; cloning its default branch instead`);
      branch = null;
      args = cloneArgs(cloneUrl, clonePath, env, null);
      attempt--;
      continue;
    }
    // Killed by the timeout: another try would take as long again.
    const delay = r.signal ? null : cloneRetryDelayMs({
      attempt,
      stderr: r.stderr,
      retryAfterS: (lastRetryAfter = /\b429\b/.test(r.stderr) ? retryAfter(cloneUrl) : null),
      waitedMs: waited,
    });
    if (delay === null) {
      if (throttled) noteCloneThrottled(cloneUrl, lastRetryAfter, now());
      const tries = attempt + 1;
      throw new GitCloneError(
        throttled
          ? `git clone was rate limited by GitHub (${tries} attempt${tries === 1 ? '' : 's'}, waited ${Math.round(waited / 1000)}s): ${reason}`
          : `git clone failed: ${reason}`,
        throttled,
      );
    }
    log(`[clone] ${throttled ? 'rate limited by GitHub' : 'failed'} (${reason}); retrying in ${Math.round(delay / 1000)}s`);
    sleep(delay);
    waited += delay;
  }
}

// ── Branches on demand ────────────────────────────────────────────────────────

/** Like GitRun, in a given repo, with stdout. */
export type GitCwdRun = (args: string[], timeoutMs: number) => { status: number | null; stdout: string; stderr: string; signal: NodeJS.Signals | null };

export function gitIn(repoPath: string): GitCwdRun {
  return (args, timeoutMs) => {
    const r = spawnSync('git', args, { cwd: repoPath, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? (r.error ? r.error.message : ''), signal: r.signal };
  };
}

const LOCAL_GIT_TIMEOUT_MS = 10_000;

/**
 * Whether `git fetch origin` in this clone leaves branches out: a shallow
 * clone, or one whose fetch refspec does not cover `refs/heads/*` (a
 * single-branch clone). A full host clone is neither, so nothing on demand
 * ever runs there. An unreadable answer reads as a full clone.
 */
export function cloneShape(run: GitCwdRun): { shallow: boolean; narrow: boolean } {
  const shallow = run(['rev-parse', '--is-shallow-repository'], LOCAL_GIT_TIMEOUT_MS);
  const isShallow = shallow.status === 0 && String(shallow.stdout ?? '').trim() === 'true';
  const refspec = run(['config', '--get-all', 'remote.origin.fetch'], LOCAL_GIT_TIMEOUT_MS);
  const wildcard = /\brefs\/heads\/\*/.test(String(refspec.stdout ?? ''));
  return { shallow: isShallow, narrow: isShallow || (refspec.status === 0 && !wildcard) };
}

function remoteRefPresent(run: GitCwdRun, branch: string): boolean {
  return run(['rev-parse', '--verify', '-q', `refs/remotes/origin/${branch}^{commit}`], LOCAL_GIT_TIMEOUT_MS).status === 0;
}

function branchRefspec(branch: string): string {
  return `+refs/heads/${branch}:refs/remotes/origin/${branch}`;
}

/**
 * The fetch that brings one branch into `origin/<branch>`. A depth only for a
 * branch a shallow clone does not have yet: an undeepened fetch of a new ref
 * there walks its history to the root, and a depth on a ref it already has
 * could cut off the commit a worktree was cut from (an existing ref is updated
 * incrementally instead).
 */
export function remoteBranchFetchArgs(repoPath: string, branch: string, run: GitCwdRun = gitIn(repoPath)): string[] {
  const depth = !remoteRefPresent(run, branch) && cloneShape(run).shallow ? ['--depth', String(CLOUD_BRANCH_FETCH_DEPTH)] : [];
  return ['fetch', '--no-tags', '--quiet', ...depth, 'origin', branchRefspec(branch)];
}

export type RemoteBranchResult =
  /** origin/<branch> was already here. */
  | 'present'
  /** Fetched just now. */
  | 'fetched'
  /** The remote has no such branch (or the name is not one git may be given). */
  | 'missing'
  /** A full clone: its `git fetch origin` already brought every branch, so absent means absent. */
  | 'not_needed'
  /** The fetch failed (after retries); the reason was logged. */
  | 'failed';

export interface EnsureRemoteBranchOptions {
  run?: GitCwdRun;
  sleep?(ms: number): void;
  retryAfter?(remoteUrl: string): number | null;
  log?(message: string): void;
  timeoutMs?: number;
}

/**
 * Make `origin/<branch>` present in a narrow (cloud) clone: fetch that one
 * branch by name, at CLOUD_BRANCH_FETCH_DEPTH when the clone is shallow,
 * retried on the clone's policy within FETCH_RETRY_BUDGET_MS. Never throws.
 * A full clone is left alone (`not_needed`), so a host runner behaves exactly
 * as before.
 */
export function ensureRemoteBranch(repoPath: string, branch: string, opts: EnsureRemoteBranchOptions = {}): RemoteBranchResult {
  if (!isSafeBranchName(branch)) return 'missing';
  const run = opts.run ?? gitIn(repoPath);
  const log = opts.log ?? ((m: string) => console.warn(m));
  try {
    if (remoteRefPresent(run, branch)) return 'present';
    const shape = cloneShape(run);
    if (!shape.narrow) return 'not_needed';
    const sleep = opts.sleep ?? sleepSync;
    const retryAfter = opts.retryAfter ?? probeRetryAfter;
    const args = ['fetch', '-q', '--no-tags', ...(shape.shallow ? ['--depth', String(CLOUD_BRANCH_FETCH_DEPTH)] : []), 'origin', branchRefspec(branch)];
    let waited = 0;
    for (let attempt = 0; ; attempt++) {
      const r = run(args, opts.timeoutMs ?? CLOUD_CLONE_TIMEOUT_MS);
      if (r.status === 0) {
        log(`[fetch] origin/${branch} fetched on demand${shape.shallow ? ` (depth ${CLOUD_BRANCH_FETCH_DEPTH})` : ''}`);
        return 'fetched';
      }
      const stderr = String(r.stderr ?? '');
      if (/couldn't find remote ref/i.test(stderr)) return 'missing';
      const reason = failureText({ status: r.status, stderr, signal: r.signal });
      let retryAfterS: number | null = null;
      if (/\b429\b/.test(stderr)) {
        const url = String(run(['remote', 'get-url', 'origin'], LOCAL_GIT_TIMEOUT_MS).stdout ?? '').trim();
        retryAfterS = url ? retryAfter(url) : null;
      }
      const delay = r.signal || !transientCloneFailure(stderr)
        ? null
        : gitRetryDelayMs({ attempt, stderr, retryAfterS, waitedMs: waited, budgetMs: FETCH_RETRY_BUDGET_MS, beyondBudget: 'stop' });
      if (delay === null) {
        log(`[fetch] could not fetch origin/${branch}: ${reason}`);
        return 'failed';
      }
      log(`[fetch] origin/${branch} ${isGithubThrottle(stderr) ? 'rate limited by GitHub' : 'failed'} (${reason}); retrying in ${Math.round(delay / 1000)}s`);
      sleep(delay);
      waited += delay;
    }
  } catch (err) {
    log(`[fetch] could not fetch origin/${branch}: ${err instanceof Error ? err.message : String(err)}`);
    return 'failed';
  }
}

/** `origin/<branch>` (or `refs/remotes/origin/<branch>`) → `<branch>`; anything else → null. */
export function branchOfRemoteRef(ref: string | null | undefined): string | null {
  if (!ref) return null;
  const m = /^(?:refs\/remotes\/)?origin\/(.+)$/.exec(ref);
  return m && m[1] !== 'HEAD' && isSafeBranchName(m[1]) ? m[1] : null;
}
