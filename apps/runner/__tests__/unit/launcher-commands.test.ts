/**
 * `buildd status`, `buildd logout` and `buildd init <workspace-id>`: the account
 * commands both launchers (install.sh and install.ps1's buildd.cmd) hand to
 * launcher-commands.ts. They lived inline in the bash launcher only, so on
 * Windows they fell through to the runner and failed with "Unknown argument".
 *
 * Every case uses a temp home and a temp cwd; nothing touches the real
 * ~/.buildd, ~/.claude or a repo.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runInit, runLogout, runStatus, type LauncherContext } from '../../src/launcher-commands';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

type Captured = LauncherContext & { lines: string[]; errors: string[]; calls: { url: string; init?: RequestInit }[] };

function ctx(opts: { config?: unknown; fetchStatus?: number; fetchThrows?: boolean } = {}): Captured {
  const home = tempDir('buildd-home-');
  const cwd = tempDir('buildd-cwd-');
  if (opts.config !== undefined) {
    mkdirSync(join(home, '.buildd'), { recursive: true });
    writeFileSync(join(home, '.buildd', 'config.json'), JSON.stringify(opts.config));
  }
  const lines: string[] = [];
  const errors: string[] = [];
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (opts.fetchThrows) throw new Error('offline');
    return new Response(null, { status: opts.fetchStatus ?? 204 });
  }) as unknown as typeof fetch;
  return { home, cwd, fetch: fetchImpl, log: (s) => lines.push(s), error: (s) => errors.push(s), lines, errors, calls };
}

const readConfig = (c: Captured) => JSON.parse(readFileSync(join(c.home, '.buildd', 'config.json'), 'utf-8'));

describe('buildd status', () => {
  test('signed in: masked key and the saved server', async () => {
    const c = ctx({ config: { apiKey: 'bld_0123456789abcdefWXYZ', builddServer: 'https://example.test' } });
    expect(await runStatus(c)).toBe(0);
    expect(c.lines).toEqual([
      'Status: logged in',
      'API key: bld_012345...WXYZ',
      'Server:  https://example.test',
    ]);
  });

  test('signed in with no saved server: buildd.dev', async () => {
    const c = ctx({ config: { apiKey: 'bld_0123456789abcdefWXYZ' } });
    await runStatus(c);
    expect(c.lines[2]).toBe('Server:  https://buildd.dev');
  });

  test('a config with no key is not signed in', async () => {
    const c = ctx({ config: { builddServer: 'https://example.test' } });
    expect(await runStatus(c)).toBe(0);
    expect(c.lines).toEqual(['Status: not logged in', 'Run "buildd login" to authenticate.']);
  });

  test('no config file is not signed in', async () => {
    const c = ctx();
    expect(await runStatus(c)).toBe(0);
    expect(c.lines).toEqual(['Status: not logged in', 'Run "buildd login" to authenticate.']);
  });

  test('the full key is never printed', async () => {
    const key = 'bld_0123456789abcdefWXYZ';
    const c = ctx({ config: { apiKey: key } });
    await runStatus(c);
    expect(c.lines.join('\n')).not.toContain(key);
  });
});

describe('buildd logout', () => {
  test('revokes the presence token, then drops both credentials and keeps the rest', async () => {
    const c = ctx({ config: { apiKey: 'bld_key', presenceToken: 'bldp_tok', builddServer: 'https://example.test/', runnerName: 'box' } });
    expect(await runLogout(c)).toBe(0);
    expect(c.calls).toHaveLength(1);
    expect(c.calls[0].url).toBe('https://example.test/api/auth/presence-token');
    expect(c.calls[0].init?.method).toBe('DELETE');
    expect((c.calls[0].init?.headers as Record<string, string>).Authorization).toBe('Bearer bldp_tok');
    expect(readConfig(c)).toEqual({ builddServer: 'https://example.test/', runnerName: 'box' });
    expect(c.lines.join('\n')).toContain('Logged out. API key and session presence token removed from');
  });

  test('revokes against buildd.dev when no server is saved', async () => {
    const c = ctx({ config: { apiKey: 'bld_key', presenceToken: 'bldp_tok' } });
    await runLogout(c);
    expect(c.calls[0].url).toBe('https://buildd.dev/api/auth/presence-token');
  });

  test('an unreachable server still logs out', async () => {
    const c = ctx({ config: { apiKey: 'bld_key', presenceToken: 'bldp_tok' }, fetchThrows: true });
    expect(await runLogout(c)).toBe(0);
    expect(readConfig(c)).toEqual({});
  });

  test('a refused revoke still logs out', async () => {
    const c = ctx({ config: { apiKey: 'bld_key', presenceToken: 'bldp_tok' }, fetchStatus: 500 });
    expect(await runLogout(c)).toBe(0);
    expect(readConfig(c)).toEqual({});
  });

  test('no presence token (or not a bldp_ one): nothing is sent', async () => {
    const c = ctx({ config: { apiKey: 'bld_key', presenceToken: 'something-else' } });
    await runLogout(c);
    expect(c.calls).toHaveLength(0);
    expect(readConfig(c)).toEqual({});
  });

  test('no config file: says so and writes nothing', async () => {
    const c = ctx();
    expect(await runLogout(c)).toBe(0);
    expect(c.lines).toEqual(['Not logged in (no config file found)']);
    expect(existsSync(join(c.home, '.buildd', 'config.json'))).toBe(false);
  });
});

describe('buildd init', () => {
  const signedIn = { apiKey: 'bld_key', builddServer: 'https://example.test' };

  function repo(c: Captured) { mkdirSync(join(c.cwd, '.git')); }

  test('writes .mcp.json for the workspace with the saved key and server', async () => {
    const c = ctx({ config: signedIn });
    repo(c);
    expect(await runInit(c, 'ws-1')).toBe(0);
    expect(JSON.parse(readFileSync(join(c.cwd, '.mcp.json'), 'utf-8'))).toEqual({
      mcpServers: {
        buildd: {
          type: 'http',
          url: 'https://example.test/api/mcp?workspace=ws-1',
          headers: { Authorization: 'Bearer bld_key' },
        },
      },
    });
    expect(c.lines).toContain('Created .mcp.json for workspace ws-1');
  });

  test('creates .gitignore with .mcp.json, or appends it once', async () => {
    const fresh = ctx({ config: signedIn });
    repo(fresh);
    await runInit(fresh, 'ws-1');
    expect(readFileSync(join(fresh.cwd, '.gitignore'), 'utf-8')).toBe('.mcp.json\n');

    const existing = ctx({ config: signedIn });
    repo(existing);
    writeFileSync(join(existing.cwd, '.gitignore'), 'node_modules\n');
    await runInit(existing, 'ws-1');
    await runInit(existing, 'ws-1');
    expect(readFileSync(join(existing.cwd, '.gitignore'), 'utf-8')).toBe('node_modules\n.mcp.json\n');
  });

  test('turns on project MCP servers in Claude Code, keeping other settings', async () => {
    const c = ctx({ config: signedIn });
    repo(c);
    mkdirSync(join(c.home, '.claude'));
    writeFileSync(join(c.home, '.claude', 'settings.json'), JSON.stringify({ theme: 'dark' }));
    await runInit(c, 'ws-1');
    expect(JSON.parse(readFileSync(join(c.home, '.claude', 'settings.json'), 'utf-8'))).toEqual({ theme: 'dark', enableAllProjectMcpServers: true });
  });

  test('leaves an explicit enableAllProjectMcpServers alone', async () => {
    const c = ctx({ config: signedIn });
    repo(c);
    mkdirSync(join(c.home, '.claude'));
    writeFileSync(join(c.home, '.claude', 'settings.json'), JSON.stringify({ enableAllProjectMcpServers: false }));
    await runInit(c, 'ws-1');
    expect(JSON.parse(readFileSync(join(c.home, '.claude', 'settings.json'), 'utf-8'))).toEqual({ enableAllProjectMcpServers: false });
  });

  test('creates Claude Code settings when there are none', async () => {
    const c = ctx({ config: signedIn });
    repo(c);
    await runInit(c, 'ws-1');
    expect(JSON.parse(readFileSync(join(c.home, '.claude', 'settings.json'), 'utf-8'))).toEqual({ enableAllProjectMcpServers: true });
  });

  test('outside a git repo: refuses', async () => {
    const c = ctx({ config: signedIn });
    expect(await runInit(c, 'ws-1')).toBe(1);
    expect(c.errors.join('\n')).toContain('not in a git repository');
    expect(existsSync(join(c.cwd, '.mcp.json'))).toBe(false);
  });

  test('no workspace id: usage', async () => {
    const c = ctx({ config: signedIn });
    repo(c);
    expect(await runInit(c, undefined)).toBe(1);
    expect(c.lines[0]).toBe('Usage: buildd init <workspace-id>');
  });

  test('not signed in: refuses', async () => {
    const c = ctx();
    repo(c);
    expect(await runInit(c, 'ws-1')).toBe(1);
    expect(c.errors.join('\n')).toContain("not logged in. Run 'buildd login' first.");
    expect(existsSync(join(c.cwd, '.mcp.json'))).toBe(false);
  });
});

describe('launcher-commands.ts as a script', () => {
  const script = join(import.meta.dir, '../../src/launcher-commands.ts');

  function run(args: string[], home: string) {
    const p = Bun.spawnSync(['bun', '--no-env-file', 'run', script, ...args], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
      cwd: home,
    });
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
  }

  test('`status` reads ~/.buildd/config.json', () => {
    const home = tempDir('buildd-home-');
    mkdirSync(join(home, '.buildd'));
    writeFileSync(join(home, '.buildd', 'config.json'), JSON.stringify({ apiKey: 'bld_0123456789abcdefWXYZ' }));
    const r = run(['status'], home);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Status: logged in');
  });

  test('an unknown command is a usage error', () => {
    const r = run(['bogus'], tempDir('buildd-home-'));
    expect(r.code).toBe(64);
    expect(r.err).toContain('bogus');
  });
});
