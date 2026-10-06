/**
 * The workspace clone (git-clone.ts): shallow in a cloud container, full on a
 * host runner; retried when GitHub throttles it (Retry-After honoured, bounded
 * total wait); never retried when the answer will not change; and a throttled
 * clone is remembered so the resolver's fallback does not immediately send the
 * same request again.
 *
 * Real git against a file:// origin for the clone shape; an injected git for
 * the retry policy (GitHub's 429 cannot be produced locally).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DEEP_ORIGIN_COMMITS, git, makeDeepOrigin, remoteBranches } from '../fixtures/deep-origin';
import {
  CLOUD_BRANCH_FETCH_DEPTH,
  ensureRemoteBranch,
  probeBranchBeyond,
  remoteBranchFetchArgs,
  type GitCwdRun,
  CLONE_RETRY_BUDGET_MS,
  FETCH_RETRY_BUDGET_MS,
  fetchOriginWithRetry,
  CLOUD_CLONE_DEPTH,
  GitCloneError,
  cloneArgs,
  cloneRepo,
  cloneRetryDelayMs,
  clearCloneThrottles,
  cloneThrottledRecently,
  isGithubThrottle,
  normalizeCloneUrl,
  type GitRun,
} from '../../src/git-clone';

const T429 = "error: RPC failed; HTTP 429 curl 22 The requested URL returned error: 429\nfatal: expected flush after ref listing";
const T403 = "fatal: unable to access 'https://github.com/acme/widget.git/': The requested URL returned error: 403";
const T404 = 'remote: Repository not found.\nfatal: repository \'https://github.com/acme/widget.git/\' not found';
const SECONDARY = 'remote: You have exceeded a secondary rate limit. Please wait a few minutes before you try again.\nfatal: unable to access \'https://github.com/acme/widget.git/\': The requested URL returned error: 403';

beforeEach(() => clearCloneThrottles());

describe('cloneArgs', () => {
  test('host runner: a full clone, exactly as before', () => {
    expect(cloneArgs('https://github.com/acme/widget.git', '/w/ws-1', {})).toEqual(['clone', 'https://github.com/acme/widget.git', '/w/ws-1']);
    expect(cloneArgs('https://github.com/acme/widget.git', '/w/ws-1', { BUILDD_EXECUTOR: 'host' })).toEqual(['clone', 'https://github.com/acme/widget.git', '/w/ws-1']);
  });

  test('cloud container: depth 1, one branch: the workspace default branch when known', () => {
    const args = cloneArgs('https://github.com/acme/widget.git', '/w/ws-1', { BUILDD_EXECUTOR: 'cloud' }, 'dev');
    expect(CLOUD_CLONE_DEPTH).toBe(1);
    expect(args).toEqual(['clone', '--depth', '1', '--single-branch', '--branch', 'dev', 'https://github.com/acme/widget.git', '/w/ws-1']);
    // Not a partial clone: bundles (warm, park) and lazy blob fetches do not mix.
    expect(args.some(a => a.startsWith('--filter'))).toBe(false);
    expect(args).not.toContain('--no-single-branch');
  });

  test('cloud container, default branch unknown: git picks the remote HEAD (plain --single-branch)', () => {
    expect(cloneArgs('https://github.com/acme/widget.git', '/w/ws-1', { BUILDD_EXECUTOR: 'cloud' })).toEqual(
      ['clone', '--depth', '1', '--single-branch', 'https://github.com/acme/widget.git', '/w/ws-1'],
    );
    // A name git would read as an option is never passed as a branch.
    expect(cloneArgs('https://github.com/acme/widget.git', '/w/ws-1', { BUILDD_EXECUTOR: 'cloud' }, '--upload-pack=x')).not.toContain('--branch');
  });

  test('host runner: the branch is ignored, a full clone as before', () => {
    expect(cloneArgs('https://github.com/acme/widget.git', '/w/ws-1', {}, 'dev')).toEqual(['clone', 'https://github.com/acme/widget.git', '/w/ws-1']);
  });

  test('normalizeCloneUrl expands an owner/repo slug', () => {
    expect(normalizeCloneUrl('acme/widget')).toBe('https://github.com/acme/widget.git');
    expect(normalizeCloneUrl('https://github.com/acme/widget')).toBe('https://github.com/acme/widget');
  });
});

describe('isGithubThrottle', () => {
  test('429 and rate-limit text are throttling; a bare 403 or 404 is not', () => {
    expect(isGithubThrottle(T429)).toBe(true);
    expect(isGithubThrottle(SECONDARY)).toBe(true);
    expect(isGithubThrottle('remote: API rate limit exceeded for installation')).toBe(true);
    expect(isGithubThrottle(T403)).toBe(false);
    expect(isGithubThrottle(T404)).toBe(false);
    expect(isGithubThrottle('')).toBe(false);
  });
});

describe('cloneRetryDelayMs', () => {
  const at = (o: Partial<Parameters<typeof cloneRetryDelayMs>[0]>) =>
    cloneRetryDelayMs({ attempt: 0, stderr: T429, retryAfterS: null, waitedMs: 0, ...o });

  test('a 429 waits for Retry-After', () => {
    expect(at({ retryAfterS: 7 })).toBe(7_000);
    expect(at({ retryAfterS: 0 })).toBe(0);
  });

  test('a Retry-After beyond the remaining budget stops instead of retrying early', () => {
    expect(at({ retryAfterS: 600 })).toBeNull();
    expect(at({ retryAfterS: 30, waitedMs: CLONE_RETRY_BUDGET_MS - 10_000 })).toBeNull();
  });

  test('no Retry-After: exponential backoff, capped by the budget', () => {
    expect(at({ attempt: 0 })).toBe(2_000);
    expect(at({ attempt: 1 })).toBe(4_000);
    expect(at({ attempt: 2 })).toBe(8_000);
    expect(at({ attempt: 5, waitedMs: CLONE_RETRY_BUDGET_MS - 1_000 })).toBe(1_000);
    expect(at({ waitedMs: CLONE_RETRY_BUDGET_MS })).toBeNull();
  });

  test('a secondary rate limit (403 with the text) is retried', () => {
    expect(at({ stderr: SECONDARY })).toBe(2_000);
  });

  test('not retried: 401, a plain 403, 404, repository not found, bad credentials', () => {
    expect(at({ stderr: "fatal: unable to access 'x': The requested URL returned error: 401" })).toBeNull();
    expect(at({ stderr: T403 })).toBeNull();
    expect(at({ stderr: "fatal: unable to access 'x': The requested URL returned error: 404" })).toBeNull();
    expect(at({ stderr: T404 })).toBeNull();
    expect(at({ stderr: 'fatal: Authentication failed for \'x\'' })).toBeNull();
  });
});

describe('cloneRepo retry', () => {
  const url = 'https://github.com/acme/widget.git';
  function fakeGit(results: Array<{ status: number; stderr?: string }>) {
    const calls: string[][] = [];
    const run: GitRun = (args) => {
      calls.push(args);
      // The last result repeats: a throttle that never lifts.
      const r = (results.length > 1 ? results.shift() : results[0]) ?? { status: 0 };
      return { status: r.status, stderr: r.stderr ?? '', signal: null };
    };
    return { calls, run };
  }

  test('a 429 then success: one wait of Retry-After seconds, then the clone', () => {
    const g = fakeGit([{ status: 128, stderr: T429 }, { status: 0 }]);
    const sleeps: number[] = [];
    const probes: string[] = [];
    cloneRepo(url, '/w/ws-1', { env: {}, run: g.run, sleep: (ms) => sleeps.push(ms), retryAfter: (u) => { probes.push(u); return 5; }, log: () => {} });
    expect(g.calls).toHaveLength(2);
    expect(g.calls[0]).toEqual(g.calls[1]!);
    expect(sleeps).toEqual([5_000]);
    expect(probes).toEqual([url]);
    expect(cloneThrottledRecently(url)).toBeNull();
  });

  test('throttled to the end: a GitCloneError marked throttled, total wait within the budget', () => {
    const g = fakeGit(Array.from({ length: 20 }, () => ({ status: 128, stderr: T429 })));
    const sleeps: number[] = [];
    let caught: unknown;
    try {
      cloneRepo(url, '/w/ws-1', { env: {}, run: g.run, sleep: (ms) => sleeps.push(ms), retryAfter: () => null, log: () => {} });
    } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(GitCloneError);
    expect((caught as GitCloneError).throttled).toBe(true);
    expect((caught as GitCloneError).message).toContain('429');
    expect(sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(CLONE_RETRY_BUDGET_MS);
    expect(g.calls.length).toBeGreaterThan(1);
  });

  test('after a throttled failure the same repo is not cloned again right away (no second identical request)', () => {
    const g = fakeGit(Array.from({ length: 20 }, () => ({ status: 128, stderr: T429 })));
    const opts = { env: {}, run: g.run, sleep: () => {}, retryAfter: () => 1, log: () => {} };
    expect(() => cloneRepo(url, '/w/ws-1', opts)).toThrow(GitCloneError);
    const sent = g.calls.length;
    expect(cloneThrottledRecently('https://github.com/acme/widget')).not.toBeNull();
    let second: unknown;
    try { cloneRepo(url, '/elsewhere/widget', opts); } catch (err) { second = err; }
    expect((second as GitCloneError).throttled).toBe(true);
    expect(g.calls.length).toBe(sent);
  });

  test('a 404 is not retried and is not a throttle', () => {
    const g = fakeGit([{ status: 128, stderr: T404 }, { status: 0 }]);
    let caught: unknown;
    try { cloneRepo(url, '/w/ws-1', { env: {}, run: g.run, sleep: () => { throw new Error('no sleep'); }, retryAfter: () => null, log: () => {} }); } catch (err) { caught = err; }
    expect((caught as GitCloneError).throttled).toBe(false);
    expect(g.calls).toHaveLength(1);
    expect(cloneThrottledRecently(url)).toBeNull();
  });

  test('a clone killed by its timeout is not retried', () => {
    const calls: string[][] = [];
    const run: GitRun = (args) => { calls.push(args); return { status: null, stderr: '', signal: 'SIGTERM' }; };
    expect(() => cloneRepo(url, '/w/ws-1', { env: {}, run, sleep: () => {}, retryAfter: () => null, log: () => {} })).toThrow(GitCloneError);
    expect(calls).toHaveLength(1);
  });
});

describe('fetchOriginWithRetry', () => {
  test('a 429 waits, then the fetch succeeds; a 404 stops at once with git\'s reason', () => {
    const seen: string[][] = [];
    const results = [{ status: 128, stderr: T429 }, { status: 0, stderr: '' }];
    const sleeps: number[] = [];
    const ok = fetchOriginWithRetry('/nonexistent', {
      run: (args) => { seen.push(args); return { ...results.shift()!, signal: null }; },
      sleep: (ms) => sleeps.push(ms),
      retryAfter: () => 3,
      log: () => {},
    });
    expect(ok).toBeNull();
    expect(seen).toEqual([['fetch', '-q', 'origin'], ['fetch', '-q', 'origin']]);
    expect(sleeps.length).toBe(1);

    let calls = 0;
    const err = fetchOriginWithRetry('/nonexistent', {
      run: () => { calls++; return { status: 128, stderr: T404, signal: null }; },
      sleep: () => { throw new Error('must not wait'); },
      retryAfter: () => null,
      log: () => {},
    });
    expect(err).toContain('not found');
    expect(calls).toBe(1);
  });

  test('a throttle that never lifts gives up within the fetch budget', () => {
    const sleeps: number[] = [];
    const err = fetchOriginWithRetry('/nonexistent', {
      run: () => ({ status: 128, stderr: T429, signal: null }),
      sleep: (ms) => sleeps.push(ms),
      retryAfter: () => null,
      log: () => {},
    });
    expect(err).toContain('429');
    expect(sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(FETCH_RETRY_BUDGET_MS);
  });
});

describe('cloneRepo against a real origin', () => {
  let dir: string;
  let origin: string;
  let url: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'git-clone-'));
    ({ origin, url } = makeDeepOrigin(dir));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test('cloud, default branch known: depth 1, that branch only, origin/HEAD names it', () => {
    const path = join(dir, 'cloud');
    cloneRepo(url, path, { env: { BUILDD_EXECUTOR: 'cloud' }, branch: 'dev', log: () => {} });
    expect(git(path, 'rev-parse', '--is-shallow-repository')).toBe('true');
    expect(Number(git(path, 'rev-list', '--count', 'origin/dev'))).toBe(1);
    expect(remoteBranches(path)).toEqual(['dev']);
    // A later plain `git fetch origin` brings this branch only, never every branch's history.
    expect(git(path, 'config', '--get-all', 'remote.origin.fetch')).toBe('+refs/heads/dev:refs/remotes/origin/dev');
    expect(git(path, 'symbolic-ref', 'refs/remotes/origin/HEAD')).toBe('refs/remotes/origin/dev');
    expect(git(path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('dev');
  });

  test('cloud, default branch unknown: the remote HEAD, at depth 1', () => {
    const path = join(dir, 'cloud');
    cloneRepo(url, path, { env: { BUILDD_EXECUTOR: 'cloud' }, log: () => {} });
    expect(remoteBranches(path)).toEqual(['main']);
    expect(Number(git(path, 'rev-list', '--count', 'origin/main'))).toBe(1);
    expect(git(path, 'symbolic-ref', 'refs/remotes/origin/HEAD')).toBe('refs/remotes/origin/main');
  });

  test('cloud, a configured default branch the remote does not have: falls back to the remote HEAD', () => {
    const path = join(dir, 'cloud');
    const logs: string[] = [];
    cloneRepo(url, path, { env: { BUILDD_EXECUTOR: 'cloud' }, branch: 'trunk', sleep: () => { throw new Error('not transient'); }, log: (m) => logs.push(m) });
    expect(remoteBranches(path)).toEqual(['main']);
    expect(logs.join('\n')).toContain('trunk');
  });

  test('host: a full clone with every branch, exactly as before', () => {
    const path = join(dir, 'host');
    cloneRepo(url, path, { env: {}, branch: 'dev', log: () => {} });
    expect(git(path, 'rev-parse', '--is-shallow-repository')).toBe('false');
    expect(Number(git(path, 'rev-list', '--count', 'origin/main'))).toBe(DEEP_ORIGIN_COMMITS);
    expect(remoteBranches(path)).toEqual(['buildd/old', 'dev', 'main', 'mission/x']);
  });
});

describe('ensureRemoteBranch: origin/<branch> on demand in a narrow clone', () => {
  let dir: string;
  let origin: string;
  let url: string;
  /** The real git, recording every command. */
  function recordingRun(cwd: string) {
    const calls: string[][] = [];
    const run: GitCwdRun = (args, timeoutMs) => {
      calls.push(args);
      const r = spawnSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs });
      return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', signal: r.signal };
    };
    return { calls, run, fetches: () => calls.filter(a => a[0] === 'fetch') };
  }
  function cloudClone(): string {
    const path = join(dir, 'cloud');
    cloneRepo(url, path, { env: { BUILDD_EXECUTOR: 'cloud' }, branch: 'dev', log: () => {} });
    return path;
  }
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ensure-branch-'));
    ({ origin, url } = makeDeepOrigin(dir));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test('a branch already there: no fetch', () => {
    const path = cloudClone();
    const r = recordingRun(path);
    expect(ensureRemoteBranch(path, 'dev', { run: r.run, log: () => {} })).toBe('present');
    expect(r.fetches()).toEqual([]);
  });

  test('a missing branch is fetched at CLOUD_BRANCH_FETCH_DEPTH, into origin/<branch> only; the clone stays shallow', () => {
    const path = cloudClone();
    const r = recordingRun(path);
    expect(ensureRemoteBranch(path, 'mission/x', { run: r.run, log: () => {} })).toBe('fetched');
    expect(r.fetches()).toEqual([[
      'fetch', '-q', '--no-tags', '--depth', String(CLOUD_BRANCH_FETCH_DEPTH), 'origin', '+refs/heads/mission/x:refs/remotes/origin/mission/x',
    ]]);
    expect(git(path, 'rev-parse', 'origin/mission/x')).toBe(git(origin, 'rev-parse', 'mission/x'));
    expect(git(path, 'rev-parse', '--is-shallow-repository')).toBe('true');
    expect(Number(git(path, 'rev-list', '--count', 'origin/mission/x'))).toBeLessThanOrEqual(CLOUD_BRANCH_FETCH_DEPTH);
    // Nothing else came in, and the default branch was not deepened.
    expect(remoteBranches(path)).toEqual(['dev', 'mission/x']);
    expect(Number(git(path, 'rev-list', '--count', 'origin/dev'))).toBe(1);
    // A second ask is answered locally.
    expect(ensureRemoteBranch(path, 'mission/x', { run: r.run, log: () => {} })).toBe('present');
    expect(r.fetches()).toHaveLength(1);
  });

  test('a branch the remote does not have: missing, at once, no retry', () => {
    const path = cloudClone();
    const r = recordingRun(path);
    expect(ensureRemoteBranch(path, 'no/such-branch', { run: r.run, sleep: () => { throw new Error('must not wait'); }, log: () => {} })).toBe('missing');
    expect(r.fetches()).toHaveLength(1);
  });

  test('a transient failure is retried on the shared policy', () => {
    const path = cloudClone();
    const real = recordingRun(path);
    let failed = false;
    const sleeps: number[] = [];
    const run: GitCwdRun = (args, t) => {
      if (args[0] === 'fetch' && !failed) { failed = true; return { status: 128, stdout: '', stderr: 'error: RPC failed; curl 18 transfer closed\nfatal: early EOF', signal: null }; }
      return real.run(args, t);
    };
    expect(ensureRemoteBranch(path, 'mission/x', { run, sleep: (ms) => sleeps.push(ms), retryAfter: () => null, log: () => {} })).toBe('fetched');
    expect(sleeps).toHaveLength(1);
  });

  test('a full clone (host) never fetches on demand: its `git fetch origin` already brought every branch', () => {
    const path = join(dir, 'host');
    cloneRepo(url, path, { env: {}, log: () => {} });
    const r = recordingRun(path);
    expect(ensureRemoteBranch(path, 'mission/x', { run: r.run, log: () => {} })).toBe('present');
    expect(ensureRemoteBranch(path, 'no/such-branch', { run: r.run, log: () => {} })).toBe('not_needed');
    expect(r.fetches()).toEqual([]);
  });

  test('a name git would read as an option is refused without running anything', () => {
    const path = cloudClone();
    const r = recordingRun(path);
    expect(ensureRemoteBranch(path, '--upload-pack=touch /tmp/x', { run: r.run, log: () => {} })).toBe('missing');
    expect(r.calls).toEqual([]);
  });

  test('remoteBranchFetchArgs: a depth only for a branch this shallow clone does not have yet', () => {
    const path = cloudClone();
    // An existing ref is updated incrementally: a depth there could cut off the commit a worktree was cut from.
    expect(remoteBranchFetchArgs(path, 'dev')).toEqual(['fetch', '--no-tags', '--quiet', 'origin', '+refs/heads/dev:refs/remotes/origin/dev']);
    expect(remoteBranchFetchArgs(path, 'mission/x')).toEqual(['fetch', '--no-tags', '--quiet', '--depth', String(CLOUD_BRANCH_FETCH_DEPTH), 'origin', '+refs/heads/mission/x:refs/remotes/origin/mission/x']);
    const host = join(dir, 'host');
    cloneRepo(url, host, { env: {}, log: () => {} });
    expect(remoteBranchFetchArgs(host, 'mission/x')).toEqual(['fetch', '--no-tags', '--quiet', 'origin', '+refs/heads/mission/x:refs/remotes/origin/mission/x']);
  });
});

// A mission integration branch can appear on the remote after a worktree was
// cut from trunk in its absence. The prompt asks, at render time, whether it is
// there now and what it carries beyond the cut base (task 19e95341).
describe('probeBranchBeyond: does origin/<branch> exist now, and how far beyond <beyond>', () => {
  let dir: string;
  let origin: string;
  let url: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'probe-beyond-'));
    ({ origin, url } = makeDeepOrigin(dir));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test('present: counts the commits on the branch that the cut base lacks', () => {
    const path = join(dir, 'host');
    cloneRepo(url, path, { env: {}, log: () => {} });
    // mission/x = main~3 + 3 own; dev = main~5 + 2 own → main~4, main~3 and 3 own.
    expect(probeBranchBeyond(path, 'mission/x', 'dev')).toEqual({ state: 'present', commitsAhead: 5 });
    expect(probeBranchBeyond(path, 'dev', 'dev')).toEqual({ state: 'present', commitsAhead: 0 });
  });

  test('a branch created on the remote after the clone is fetched fresh, not read from a stale ref', () => {
    const path = join(dir, 'host');
    cloneRepo(url, path, { env: {}, log: () => {} });
    expect(probeBranchBeyond(path, 'mission/late', 'dev')).toEqual({ state: 'missing' });
    git(origin, 'branch', 'mission/late', 'mission/x');
    expect(probeBranchBeyond(path, 'mission/late', 'dev')).toEqual({ state: 'present', commitsAhead: 5 });
  });

  test('works in a narrow cloud clone too', () => {
    const path = join(dir, 'cloud');
    cloneRepo(url, path, { env: { BUILDD_EXECUTOR: 'cloud' }, branch: 'dev', log: () => {} });
    const r = probeBranchBeyond(path, 'mission/x', 'dev');
    expect(r.state).toBe('present');
    expect(r.state === 'present' && r.commitsAhead).toBeGreaterThan(0);
  });

  test('a fetch that fails for another reason, with no local ref: unknown', () => {
    const run: GitCwdRun = (args) => args[0] === 'fetch'
      ? { status: 128, stdout: '', stderr: 'fatal: unable to access: Could not resolve host', signal: null }
      : { status: 1, stdout: '', stderr: '', signal: null };
    expect(probeBranchBeyond('/nowhere', 'mission/x', 'dev', { run })).toEqual({ state: 'unknown' });
  });

  test('unsafe names are refused without running anything', () => {
    const calls: string[][] = [];
    const run: GitCwdRun = (args) => { calls.push(args); return { status: 0, stdout: '', stderr: '', signal: null }; };
    expect(probeBranchBeyond('/nowhere', '--upload-pack=x', 'dev', { run })).toEqual({ state: 'unknown' });
    expect(probeBranchBeyond('/nowhere', 'mission/x', '--upload-pack=x', { run })).toEqual({ state: 'unknown' });
    expect(calls).toEqual([]);
  });
});
