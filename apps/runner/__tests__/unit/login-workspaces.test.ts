/**
 * `buildd login --workspaces` (spec "One runner for every team you run", R-4,
 * AC-4): opens the edit page for the key this machine already uses and never
 * mints or rewrites a key. Plain `buildd login` is untouched.
 *
 * The end-to-end cases run login.ts in a child process with a temp HOME, a temp
 * cwd, a fake server on localhost and an `open` stub on PATH, so no real
 * ~/.buildd, no repo dir and no browser are involved.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import {
  currentKey, editLine, picksEditUrl, resolvePicksEdit, runWorkspacesEdit,
} from '../../src/login-workspaces';
import { resolveBuilddServer } from '../../src/server-url';

const ACCOUNT = 'acct-test-1';
const DEAD = 'http://127.0.0.1:9';

const meFetch = (status: number, body: unknown): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as any;

describe('which key and server', () => {
  test('the saved key and server', () => {
    expect(currentKey({ apiKey: 'bld_saved', builddServer: 'https://example.test' }, {})).toEqual({
      apiKey: 'bld_saved', server: 'https://example.test', source: 'config',
    });
  });

  test('BUILDD_API_KEY wins, as it does for the runner, with its own server', () => {
    const k = currentKey({ apiKey: 'bld_saved', builddServer: 'https://saved.test' }, { BUILDD_API_KEY: 'bld_env', BUILDD_SERVER: 'https://env.test' });
    expect(k).toEqual({ apiKey: 'bld_env', server: 'https://env.test', source: 'env' });
  });

  test('--server wins over both', () => {
    expect(currentKey({ apiKey: 'bld_saved', builddServer: 'https://saved.test' }, {}, 'https://flag.test')?.server).toBe('https://flag.test');
  });

  test('a saved key with no saved server asks BUILDD_SERVER, as the runner does', () => {
    expect(currentKey({ apiKey: 'bld_saved' }, { BUILDD_SERVER: 'https://env.test' })).toEqual({
      apiKey: 'bld_saved', server: 'https://env.test', source: 'config',
    });
  });

  test('BUILDD_SERVER beats the saved server for a saved key too (the runner order)', () => {
    expect(currentKey({ apiKey: 'bld_saved', builddServer: 'https://saved.test' }, { BUILDD_SERVER: 'https://env.test' })?.server)
      .toBe('https://env.test');
  });

  test('same answer as the runner for every mix of flag, env and saved server', () => {
    const flags = [undefined, 'https://flag.test'];
    const envs = [{}, { BUILDD_SERVER: 'https://env.test' }, { BUILDD_SERVER: '  ' }];
    const saved = [{}, { builddServer: 'https://saved.test' }];
    for (const f of flags) for (const e of envs) for (const c of saved) {
      expect(currentKey({ apiKey: 'bld_saved', ...c }, e, f)?.server).toBe(resolveBuilddServer({ flag: f, env: e, saved: c.builddServer }));
    }
  });

  test('a saved key with no saved server asks BUILDD_SERVER, as the runner does', () => {
    expect(currentKey({ apiKey: 'bld_saved' }, { BUILDD_SERVER: 'https://env.test' })).toEqual({
      apiKey: 'bld_saved', server: 'https://env.test', source: 'config',
    });
  });

  test('BUILDD_SERVER beats the saved server for a saved key too (the runner order)', () => {
    expect(currentKey({ apiKey: 'bld_saved', builddServer: 'https://saved.test' }, { BUILDD_SERVER: 'https://env.test' })?.server)
      .toBe('https://env.test');
  });

  test('same answer as the runner for every mix of flag, env and saved server', () => {
    const flags = [undefined, 'https://flag.test'];
    const envs: Record<string, string>[] = [{}, { BUILDD_SERVER: 'https://env.test' }, { BUILDD_SERVER: '  ' }];
    const saved: Record<string, string>[] = [{}, { builddServer: 'https://saved.test' }];
    for (const f of flags) for (const e of envs) for (const c of saved) {
      expect(currentKey({ apiKey: 'bld_saved', ...c }, e, f)?.server).toBe(resolveBuilddServer({ flag: f, env: e, saved: c.builddServer }));
    }
  });

  test('defaults to buildd.dev; no key at all is null', () => {
    expect(currentKey({ apiKey: 'bld_saved' }, {})?.server).toBe('https://buildd.dev');
    expect(currentKey({}, {})).toBeNull();
    expect(currentKey({ apiKey: '  ' }, { BUILDD_API_KEY: ' ' })).toBeNull();
  });
});

describe('the edit page URL', () => {
  test('is the runner-picks page for the key account', () => {
    expect(picksEditUrl('https://buildd.dev/', ACCOUNT)).toBe(`https://buildd.dev/api/auth/runner-picks?account=${ACCOUNT}`);
  });

  test('the account comes from GET /api/accounts/me with the key', async () => {
    const calls: Array<{ url: string; auth: string | null }> = [];
    const f = (async (url: string, init?: RequestInit) => {
      calls.push({ url, auth: new Headers(init?.headers).get('authorization') });
      return new Response(JSON.stringify({ id: ACCOUNT, name: 'laptop' }), { status: 200 });
    }) as any;
    const out = await resolvePicksEdit({ apiKey: 'bld_k', server: 'https://x.test', source: 'config' }, f);
    expect(out).toEqual({ ok: true, url: `https://x.test/api/auth/runner-picks?account=${ACCOUNT}`, accountName: 'laptop' });
    expect(calls).toEqual([{ url: 'https://x.test/api/accounts/me', auth: 'Bearer bld_k' }]);
  });

  test('a refused key says to sign in again', async () => {
    const out = await resolvePicksEdit({ apiKey: 'bld_k', server: 'https://x.test', source: 'config' }, meFetch(401, { error: 'Invalid API key' }));
    expect(out).toEqual({ ok: false, message: 'https://x.test does not accept the saved key. Run buildd login to sign in again.' });
  });

  test('an unreachable server says so', async () => {
    const out = await resolvePicksEdit({ apiKey: 'bld_k', server: DEAD, source: 'config' });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.message).toStartWith(`Could not reach ${DEAD}`);
  });
});

describe('runWorkspacesEdit', () => {
  const run = async (config: Record<string, unknown>, f: typeof fetch, openUrl = async (_u: string) => {}) => {
    const log: string[] = [];
    const err: string[] = [];
    const opened: string[] = [];
    const code = await runWorkspacesEdit({
      config, env: {}, fetchImpl: f,
      openUrl: async (u) => { opened.push(u); await openUrl(u); },
      log: (l) => log.push(l), error: (l) => err.push(l),
    });
    return { code, log, err, opened };
  };

  test('prints one line with the URL and opens it', async () => {
    const r = await run({ apiKey: 'bld_k', builddServer: 'https://x.test' }, meFetch(200, { id: ACCOUNT }));
    const url = `https://x.test/api/auth/runner-picks?account=${ACCOUNT}`;
    expect(r.code).toBe(0);
    expect(r.log).toEqual([editLine(url)]);
    expect(r.log[0]).toContain(url);
    expect(r.opened).toEqual([url]);
  });

  test('no browser on this machine still succeeds: the URL is on the line', async () => {
    const r = await run({ apiKey: 'bld_k', builddServer: 'https://x.test' }, meFetch(200, { id: ACCOUNT }), async () => { throw new Error('no open'); });
    expect(r.code).toBe(0);
    expect(r.log).toHaveLength(1);
  });

  test('no key yet: says to run buildd login, opens nothing', async () => {
    const r = await run({}, meFetch(200, { id: ACCOUNT }));
    expect(r.code).toBe(1);
    expect(r.err).toEqual(['This machine has no buildd key yet. Run buildd login first.']);
    expect(r.opened).toEqual([]);
  });
});

// ── login.ts end to end, in a child process ─────────────────────────────────

const LOGIN = resolve(import.meta.dir, '../../src/login.ts');
const dirs: string[] = [];
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function sandbox() {
  const home = tmp('buildd-login-home-');
  const cwd = tmp('buildd-login-cwd-');
  const bin = tmp('buildd-login-bin-');
  const openLog = join(bin, 'opened.txt');
  // A stub `open` so no browser starts; it records what it was asked to open.
  writeFileSync(join(bin, 'open'), `#!/bin/sh\necho "$1" >> "${openLog}"\n`);
  chmodSync(join(bin, 'open'), 0o755);
  return { home, cwd, bin, openLog };
}

function runLogin(args: string[], sb: ReturnType<typeof sandbox>) {
  const env: Record<string, string> = {
    PATH: `${sb.bin}:${process.env.PATH ?? ''}`,
    HOME: sb.home,
    BUILDD_HOME: join(sb.home, '.buildd'),
    NODE_ENV: 'production',
  };
  const p = Bun.spawnSync([process.execPath, '--no-env-file', 'run', LOGIN, ...args], { cwd: sb.cwd, env, stdout: 'pipe', stderr: 'pipe' });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

describe('buildd login --workspaces (login.ts)', () => {
  test('--help lists --workspaces', () => {
    const r = runLogin(['--help'], sandbox());
    expect(r.code).toBe(0);
    expect(r.out).toContain('--workspaces');
  });

  test('opens the edit page for the current key and leaves config.json byte for byte', async () => {
    const seen: string[] = [];
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        seen.push(`${req.method} ${url.pathname}`);
        if (url.pathname === '/api/accounts/me' && req.headers.get('authorization') === 'Bearer bld_current') {
          return Response.json({ id: ACCOUNT, name: 'laptop' });
        }
        return new Response('no', { status: 404 });
      },
    });
    try {
      const sb = sandbox();
      const base = `http://127.0.0.1:${server.port}`;
      mkdirSync(join(sb.home, '.buildd'), { recursive: true });
      const cfgPath = join(sb.home, '.buildd', 'config.json');
      const before = JSON.stringify({ apiKey: 'bld_current', builddServer: base, presenceToken: 'bldp_x' }, null, 2);
      writeFileSync(cfgPath, before);

      const p = Bun.spawn([process.execPath, '--no-env-file', 'run', LOGIN, '--workspaces'], {
        cwd: sb.cwd,
        env: { PATH: `${sb.bin}:${process.env.PATH ?? ''}`, HOME: sb.home, BUILDD_HOME: join(sb.home, '.buildd'), NODE_ENV: 'production' },
        stdout: 'pipe', stderr: 'pipe',
      });
      const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
      const url = `${base}/api/auth/runner-picks?account=${ACCOUNT}`;

      expect(err).toBe('');
      expect(code).toBe(0);
      expect(out.trim().split('\n')).toEqual([editLine(url)]);
      expect(readFileSync(sb.openLog, 'utf8').trim()).toBe(url);
      // Nothing minted: the only request was which account this key is.
      expect(seen).toEqual(['GET /api/accounts/me']);
      expect(readFileSync(cfgPath, 'utf8')).toBe(before);
    } finally {
      server.stop(true);
    }
  });

  test('a saved key and no saved server: asks BUILDD_SERVER, not buildd.dev', async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === '/api/accounts/me' && req.headers.get('authorization') === 'Bearer bld_current') {
          return Response.json({ id: ACCOUNT, name: 'laptop' });
        }
        return new Response('no', { status: 404 });
      },
    });
    try {
      const sb = sandbox();
      const base = `http://127.0.0.1:${server.port}`;
      mkdirSync(join(sb.home, '.buildd'), { recursive: true });
      writeFileSync(join(sb.home, '.buildd', 'config.json'), JSON.stringify({ apiKey: 'bld_current' }));
      const p = Bun.spawn([process.execPath, '--no-env-file', 'run', LOGIN, '--workspaces'], {
        cwd: sb.cwd,
        env: { PATH: `${sb.bin}:${process.env.PATH ?? ''}`, HOME: sb.home, BUILDD_HOME: join(sb.home, '.buildd'), NODE_ENV: 'production', BUILDD_SERVER: base },
        stdout: 'pipe', stderr: 'pipe',
      });
      const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
      expect(err).toBe('');
      expect(code).toBe(0);
      expect(out).toContain(`${base}/api/auth/runner-picks?account=${ACCOUNT}`);
    } finally {
      server.stop(true);
    }
  });

  test('a dead server: exits 1, writes no config, opens nothing', () => {
    const sb = sandbox();
    mkdirSync(join(sb.home, '.buildd'), { recursive: true });
    const cfgPath = join(sb.home, '.buildd', 'config.json');
    const before = JSON.stringify({ apiKey: 'bld_current', builddServer: DEAD });
    writeFileSync(cfgPath, before);
    const r = runLogin(['--workspaces'], sb);
    expect(r.code).toBe(1);
    expect(r.err).toContain(`Could not reach ${DEAD}`);
    expect(readFileSync(cfgPath, 'utf8')).toBe(before);
    expect(existsSync(sb.openLog)).toBe(false);
  });

  test('no saved key: exits 1 and creates no config', () => {
    const sb = sandbox();
    const r = runLogin(['--workspaces', '--server', DEAD], sb);
    expect(r.code).toBe(1);
    expect(r.err).toContain('Run buildd login first');
    expect(existsSync(join(sb.home, '.buildd', 'config.json'))).toBe(false);
  });
});
