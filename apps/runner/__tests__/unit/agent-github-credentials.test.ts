/**
 * An agent told `githubCredentials.mode = 'scoped'` acts on GitHub only with
 * the task-scoped token the runner fetched: inherited GitHub tokens are
 * stripped, and host git/gh credentials are overridden for the agent's
 * processes. The git checks run the real `git credential fill`, so they hold
 * against git's own config precedence, not our reading of it.
 */
import { describe, test, expect, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import {
  INHERITED_GITHUB_TOKEN_ENV,
  applyScopedGitHubEnv,
  clearScopedGitHubToken,
  writeScopedGitHubToken,
  ScopedGitHubTokenRefresher,
  startScopedGitHubSession,
  type ScopedGitHubTokenResult,
} from '../../src/agent-github-credentials';

const scratch = mkdtempSync(join(tmpdir(), 'agent-github-credentials-test-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let n = 0;
const freshDir = () => join(scratch, `s${n++}`);

/**
 * A host whose global git config hands out the operator's token for every
 * host, and a repo-local config that tries to as well.
 */
function hostEnv(): Record<string, string> {
  const globalCfg = join(scratch, `global-${n++}.gitconfig`);
  writeFileSync(globalCfg, [
    '[credential]',
    '\thelper = "!f() { echo username=operator; echo password=operator-token; }; f"',
    '[credential "https://github.com"]',
    '\thelper = "!f() { echo username=operator; echo password=operator-url-token; }; f"',
    '[user]',
    '\tname = Operator',
  ].join('\n'));
  return {
    PATH: process.env.PATH ?? '',
    HOME: scratch,
    GIT_CONFIG_GLOBAL: globalCfg,
    GIT_CONFIG_NOSYSTEM: '1',
    GITHUB_TOKEN: 'operator-env-token',
    GH_TOKEN: 'operator-env-token',
  };
}

function credentialFill(env: Record<string, string>, host: string, cwd = scratch): { status: number | null; out: string } {
  const r = spawnSync('git', ['credential', 'fill'], {
    cwd, env, input: `protocol=https\nhost=${host}\n\n`, encoding: 'utf8', timeout: 10_000,
  });
  return { status: r.status, out: r.stdout ?? '' };
}

describe('applyScopedGitHubEnv', () => {
  test('strips every inherited GitHub token from the agent env', () => {
    const env = { ...hostEnv(), GH_ENTERPRISE_TOKEN: 'x', GITHUB_ENTERPRISE_TOKEN: 'y' };
    applyScopedGitHubEnv(env, freshDir());
    for (const key of INHERITED_GITHUB_TOKEN_ENV) expect(env[key]).toBeUndefined();
  });

  test('git: hands out the scoped token for github.com, overriding host helpers', () => {
    const env = hostEnv();
    const files = applyScopedGitHubEnv(env, freshDir());
    writeScopedGitHubToken(files, 'ghs_task_scoped');
    const { status, out } = credentialFill(env, 'github.com');
    expect(status).toBe(0);
    expect(out).toContain('password=ghs_task_scoped');
    expect(out).not.toContain('operator');
  });

  test('git: a repo-local credential helper does not win either', () => {
    const env = hostEnv();
    const repo = join(scratch, `repo-${n++}`);
    spawnSync('git', ['init', '-q', repo], { env });
    spawnSync('git', ['-C', repo, 'config', 'credential.helper', '!f() { echo password=local-token; }; f'], { env });
    const files = applyScopedGitHubEnv(env, freshDir());
    writeScopedGitHubToken(files, 'ghs_task_scoped');
    const { out } = credentialFill(env, 'github.com', repo);
    expect(out).toContain('password=ghs_task_scoped');
    expect(out).not.toContain('local-token');
  });

  test('git: gives nothing for other hosts, and does not prompt', () => {
    const env = hostEnv();
    const files = applyScopedGitHubEnv(env, freshDir());
    writeScopedGitHubToken(files, 'ghs_task_scoped');
    const { status, out } = credentialFill(env, 'gitlab.example.com');
    expect(status).not.toBe(0);
    expect(out).not.toContain('password=');
  });

  test('git: with no token yet (fetch failed), github.com gets nothing, not the operator token', () => {
    const env = hostEnv();
    applyScopedGitHubEnv(env, freshDir());
    const { status, out } = credentialFill(env, 'github.com');
    expect(status).not.toBe(0);
    expect(out).not.toContain('operator');
  });

  test('git: SSH remotes on github.com are rewritten to https, so host SSH keys are not used', () => {
    const env = hostEnv();
    applyScopedGitHubEnv(env, freshDir());
    const repo = join(scratch, `repo-${n++}`);
    spawnSync('git', ['init', '-q', repo], { env });
    spawnSync('git', ['-C', repo, 'remote', 'add', 'origin', 'git@github.com:acme/widget.git'], { env });
    const pushUrl = spawnSync('git', ['-C', repo, 'remote', 'get-url', '--push', 'origin'], { env, encoding: 'utf8' });
    expect(pushUrl.stdout.trim()).toBe('https://github.com/acme/widget.git');
  });

  test('git: keeps the host identity (only credentials are overridden)', () => {
    const env = hostEnv();
    applyScopedGitHubEnv(env, freshDir());
    const name = spawnSync('git', ['config', 'user.name'], { env, encoding: 'utf8', cwd: scratch });
    expect(name.stdout.trim()).toBe('Operator');
  });

  test('gh: points GH_CONFIG_DIR at a private dir holding only the scoped token', () => {
    const env = hostEnv();
    const files = applyScopedGitHubEnv(env, freshDir());
    expect(env.GH_CONFIG_DIR).toBe(files.ghConfigDir);
    writeScopedGitHubToken(files, 'ghs_task_scoped');
    const hosts = readFileSync(join(files.ghConfigDir, 'hosts.yml'), 'utf8');
    expect(hosts).toContain('github.com:');
    expect(hosts).toContain('oauth_token: ghs_task_scoped');
    expect(statSync(files.tokenPath).mode & 0o077).toBe(0);
    expect(statSync(join(files.ghConfigDir, 'hosts.yml')).mode & 0o077).toBe(0);
  });

  test('a refresh replaces the token everywhere; clearing removes it', () => {
    const env = hostEnv();
    const files = applyScopedGitHubEnv(env, freshDir());
    writeScopedGitHubToken(files, 'ghs_first');
    writeScopedGitHubToken(files, 'ghs_second');
    expect(credentialFill(env, 'github.com').out).toContain('password=ghs_second');
    expect(readFileSync(join(files.ghConfigDir, 'hosts.yml'), 'utf8')).toContain('ghs_second');
    clearScopedGitHubToken(files);
    expect(credentialFill(env, 'github.com').out).not.toContain('password=');
    expect(existsSync(join(files.ghConfigDir, 'hosts.yml'))).toBe(false);
  });

  test('refuses a token that would break out of the credential file format', () => {
    const files = applyScopedGitHubEnv(hostEnv(), freshDir());
    expect(() => writeScopedGitHubToken(files, 'ghs_x\npassword=evil')).toThrow();
  });
});

describe('ScopedGitHubTokenRefresher', () => {
  function harness(results: Array<ScopedGitHubTokenResult | Error>) {
    const env = hostEnv();
    const files = applyScopedGitHubEnv(env, freshDir());
    let now = Date.parse('2026-01-01T00:00:00Z');
    const timers: Array<{ at: number; fn: () => void; id: number }> = [];
    let nextId = 1;
    const calls: number[] = [];
    const refresher = new ScopedGitHubTokenRefresher({
      files,
      fetchToken: async () => {
        calls.push(now);
        const r = results.shift();
        if (!r) throw new Error('no more results');
        if (r instanceof Error) throw r;
        return r;
      },
      now: () => now,
      setTimer: (fn, ms) => { const id = nextId++; timers.push({ at: now + ms, fn, id }); return id; },
      clearTimer: (id) => { const i = timers.findIndex(t => t.id === id); if (i >= 0) timers.splice(i, 1); },
      retryMs: 60_000,
    });
    async function advanceTo(ms: number) {
      now = ms;
      for (;;) {
        const due = timers.filter(t => t.at <= now).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers.splice(timers.indexOf(due), 1);
        due.fn();
        await new Promise(r => setTimeout(r, 0));
      }
    }
    return { env, files, refresher, calls, timers, advanceTo, get now() { return now; } };
  }
  const t0 = Date.parse('2026-01-01T00:00:00Z');
  const ok = (token: string, minutes: number): ScopedGitHubTokenResult => ({ token, expiresAt: new Date(t0 + minutes * 60_000) });

  test('fetches on start and refreshes five minutes before expiry', async () => {
    const h = harness([ok('ghs_a', 60), { token: 'ghs_b', expiresAt: new Date(t0 + 115 * 60_000) }]);
    expect(await h.refresher.start()).toEqual({ ok: true });
    expect(credentialFill(h.env, 'github.com').out).toContain('password=ghs_a');
    await h.advanceTo(t0 + 54 * 60_000);
    expect(h.calls.length).toBe(1);
    await h.advanceTo(t0 + 55 * 60_000);
    expect(h.calls.length).toBe(2);
    expect(credentialFill(h.env, 'github.com').out).toContain('password=ghs_b');
    h.refresher.stop();
  });

  test('a failed start reports why and retries; a later success installs the token', async () => {
    const h = harness([new Error('HTTP 502'), ok('ghs_late', 60)]);
    const r = await h.refresher.start();
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain('502');
    expect(credentialFill(h.env, 'github.com').out).not.toContain('password=');
    await h.advanceTo(t0 + 60_000);
    expect(credentialFill(h.env, 'github.com').out).toContain('password=ghs_late');
    h.refresher.stop();
  });

  test('a permanent refusal stops retrying', async () => {
    const err = Object.assign(new Error('Workspace has no linked GitHub repository'), { permanent: true });
    const h = harness([err]);
    const r = await h.refresher.start();
    expect(r).toEqual({ ok: false, reason: 'Workspace has no linked GitHub repository', permanent: true });
    expect(h.timers.length).toBe(0);
  });

  test('a failed refresh keeps the still-valid token and retries', async () => {
    const h = harness([ok('ghs_a', 60), new Error('HTTP 502'), ok('ghs_c', 120)]);
    await h.refresher.start();
    await h.advanceTo(t0 + 55 * 60_000);
    expect(credentialFill(h.env, 'github.com').out).toContain('password=ghs_a');
    await h.advanceTo(t0 + 56 * 60_000);
    expect(credentialFill(h.env, 'github.com').out).toContain('password=ghs_c');
    h.refresher.stop();
  });

  test('startScopedGitHubSession: installs the first token under <home>/github', async () => {
    const env = hostEnv();
    const home = freshDir();
    const session = await startScopedGitHubSession({ env, homeDir: home, fetchToken: async () => ok('ghs_s', 60) });
    expect(session.ok).toBe(true);
    expect(env.GH_CONFIG_DIR).toBe(join(home, 'github', 'gh'));
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(credentialFill(env, 'github.com').out).toContain('password=ghs_s');
    session.stop();
    expect(credentialFill(env, 'github.com').out).not.toContain('password=');
  });

  test('startScopedGitHubSession fails closed: no operator token even when setup fails', async () => {
    const env = hostEnv();
    const session = await startScopedGitHubSession({ env, homeDir: "/nonexistent/it's-quoted", fetchToken: async () => ok('ghs_s', 60) });
    expect(session.ok).toBe(false);
    expect(session.reason).toContain('could not prepare');
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.GH_TOKEN).toBeUndefined();
  });

  test('stop clears the timer and the token', async () => {
    const h = harness([ok('ghs_a', 60)]);
    await h.refresher.start();
    h.refresher.stop();
    expect(h.timers.length).toBe(0);
    expect(credentialFill(h.env, 'github.com').out).not.toContain('password=');
  });
});
