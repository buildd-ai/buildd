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
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
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

  test('cloud container: shallow, but every branch tip (mission and resume branches resolve from origin/<branch>)', () => {
    const args = cloneArgs('https://github.com/acme/widget.git', '/w/ws-1', { BUILDD_EXECUTOR: 'cloud' });
    expect(args).toEqual(['clone', '--depth', String(CLOUD_CLONE_DEPTH), '--no-single-branch', 'https://github.com/acme/widget.git', '/w/ws-1']);
    // Not a partial clone: bundles (warm, park) and lazy blob fetches do not mix.
    expect(args.some(a => a.startsWith('--filter'))).toBe(false);
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
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'git-clone-'));
    const origin = join(dir, 'origin.git');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
    // One fast-import stream: CLOUD_CLONE_DEPTH + 10 commits on main.
    let stream = '';
    for (let i = 0; i < CLOUD_CLONE_DEPTH + 10; i++) {
      const data = `${i}\n`;
      stream += `commit refs/heads/main\nmark :${i + 1}\ncommitter t <t@example.com> ${1_700_000_000 + i} +0000\ndata 3\nc${String(i).padStart(2, '0')}\n`;
      if (i > 0) stream += `from :${i}\n`;
      stream += `M 100644 inline f.txt\ndata ${data.length}\n${data}\n`;
    }
    execFileSync('git', ['fast-import', '--quiet'], { cwd: origin, input: stream });
    git(origin, 'branch', 'mission/x', 'main~3');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test('cloud: shallow at the fixed depth, with every branch as origin/<branch>', () => {
    const path = join(dir, 'cloud');
    cloneRepo(`file://${join(dir, 'origin.git')}`, path, { env: { BUILDD_EXECUTOR: 'cloud' }, log: () => {} });
    expect(git(path, 'rev-parse', '--is-shallow-repository')).toBe('true');
    const depth = Number(git(path, 'rev-list', '--count', 'origin/main'));
    expect(depth).toBeGreaterThanOrEqual(CLOUD_CLONE_DEPTH);
    expect(depth).toBeLessThan(CLOUD_CLONE_DEPTH + 10);
    expect(git(path, 'rev-parse', 'origin/mission/x')).toBe(git(join(dir, 'origin.git'), 'rev-parse', 'mission/x'));
    expect(git(path, 'config', 'remote.origin.fetch')).toBe('+refs/heads/*:refs/remotes/origin/*');
  });

  test('host: a full clone', () => {
    const path = join(dir, 'host');
    cloneRepo(`file://${join(dir, 'origin.git')}`, path, { env: {}, log: () => {} });
    expect(git(path, 'rev-parse', '--is-shallow-repository')).toBe('false');
    expect(Number(git(path, 'rev-list', '--count', 'origin/main'))).toBe(CLOUD_CLONE_DEPTH + 10);
  });
});
