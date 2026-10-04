/**
 * The workspace clone, and what to do when GitHub throttles it.
 *
 * Shape. A host runner clones in full, as it always has. A cloud container
 * (BUILDD_EXECUTOR=cloud, one task per container, nothing kept afterwards
 * except the warm snapshot) clones shallow: `--depth CLOUD_CLONE_DEPTH
 * --no-single-branch`. Why that and not less:
 *  - every branch tip, not just the default one: setupWorktree resolves
 *    mission and resume branches as `origin/<branch>`, and a single-branch
 *    clone also narrows `remote.origin.fetch`, so a later plain `git fetch`
 *    would never bring them in. Widening the refspec afterwards is worse: a
 *    shallow repo then fetches each other branch's history down to its root.
 *  - a depth, not a partial clone (`--filter`): the warm snapshot and park
 *    bundles are `git bundle`s, which cannot be made from a repo with missing
 *    blobs without fetching them, and lazy blob fetches turn ordinary
 *    `git log -p` / `diff` into a stream of GitHub requests.
 *  - a depth of some commits, not 1: the agent reads recent history, and a
 *    branch cut a few commits back still finds its merge base locally.
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

export const CLOUD_CLONE_DEPTH = 50;
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

export function cloneArgs(cloneUrl: string, clonePath: string, env: Env): string[] {
  if (!isCloudExecutor(env)) return ['clone', cloneUrl, clonePath];
  return ['clone', '--depth', String(CLOUD_CLONE_DEPTH), '--no-single-branch', cloneUrl, clonePath];
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
  if (isGithubThrottle(stderr)) return true;
  const code = /returned error: (\d{3})/.exec(stderr)?.[1] ?? /\bHTTP (\d{3})\b/.exec(stderr)?.[1];
  if (code) return code.startsWith('5') || code === '408';
  return /RPC failed|early EOF|unexpected disconnect|could not resolve host|connection (reset|refused|timed out)|operation timed out|gnutls|ssl/i.test(stderr);
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

  const args = cloneArgs(cloneUrl, clonePath, env);
  const timeout = isCloudExecutor(env) ? CLOUD_CLONE_TIMEOUT_MS : HOST_CLONE_TIMEOUT_MS;
  let waited = 0;
  let lastRetryAfter: number | null = null;
  for (let attempt = 0; ; attempt++) {
    const r = run(args, timeout);
    if (r.status === 0) return;
    const reason = failureText(r);
    const throttled = isGithubThrottle(r.stderr);
    // git removes a failed clone's directory itself; make sure, so the retry
    // (or the next resolver) does not find a half-written one.
    rmSync(clonePath, { recursive: true, force: true });
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
