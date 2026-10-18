/**
 * The runner's login mode (spec 34a48877 R-14, R-19, AC-14): how its own
 * logins share its slots, kept in config.json like its slots, set with
 * `buildd logins <mode>` or `b` in top, and sent on every claim with its live
 * agents per backend. A fake socket and a temp config.json; never ~/.buildd.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  applyLoginMode, classifyLoginsArgs, loginUseFor, loginsStatusLine, readLoginModeFromConfig, runLoginsCommand, saveLoginModeToConfig,
} from '../../src/runner-logins';
import { classifyCliArgs } from '../../src/cli-args';

const home = () => mkdtempSync(join(tmpdir(), 'buildd-logins-'));
const live = async () => ({ state: 'live' as const });
const absent = async () => ({ state: 'absent' as const });

describe('config.json', () => {
  test('the mode is saved beside the other fields and read back; never set reads as balanced', () => {
    const dir = home();
    const file = join(dir, 'config.json');
    writeFileSync(file, JSON.stringify({ apiKey: 'bld_fake', maxConcurrent: 9 }));
    expect(readLoginModeFromConfig(file)).toBe('balanced');
    saveLoginModeToConfig(file, 'codex-first');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ apiKey: 'bld_fake', maxConcurrent: 9, loginMode: 'codex-first' });
    expect(readLoginModeFromConfig(file)).toBe('codex-first');
  });

  test('a garbled saved mode reads as balanced', () => {
    const dir = home();
    const file = join(dir, 'config.json');
    writeFileSync(file, JSON.stringify({ loginMode: 'fastest' }));
    expect(readLoginModeFromConfig(file)).toBe('balanced');
  });
});

describe('what the claim carries', () => {
  test('the mode, the slots and the working agents per backend; a question or a finished run is not counted', () => {
    expect(loginUseFor('balanced', 9, [
      { status: 'working', taskBackend: 'claude' },
      { status: 'stale', taskBackend: 'codex' },
      { status: 'working', taskBackend: 'codex' },
      { status: 'working' },
      { status: 'waiting', taskBackend: 'codex' },
      { status: 'done', taskBackend: 'claude' },
    ])).toEqual({ mode: 'balanced', slots: 9, running: { claude: 2, codex: 2 } });
  });
});

describe('words', () => {
  test('buildd logins alone: the mode and how each login is used now', () => {
    expect(loginsStatusLine('balanced', 9, { claude: 6, codex: 2 })).toBe('Login mode: balanced. Claude: 6 running (up to 6). Codex: 2 running (up to 3).');
    expect(loginsStatusLine('claude-first', 9, { claude: 4, codex: 0 })).toBe('Login mode: claude-first. Claude: 4 running. Codex: idle, takes work when Claude is at its limit.');
    expect(loginsStatusLine('codex-first', 9, { claude: 0, codex: 1 })).toBe('Login mode: codex-first. Codex: 1 running. Claude: idle, takes work when Codex is at its limit.');
  });
});

describe('buildd logins', () => {
  test('arguments', () => {
    expect(classifyLoginsArgs([])).toEqual({ kind: 'show' });
    expect(classifyLoginsArgs(['claude-first'])).toEqual({ kind: 'set', raw: 'claude-first' });
    expect(classifyLoginsArgs(['a', 'b'])).toMatchObject({ kind: 'unknown' });
    expect(classifyLoginsArgs(['--fast'])).toMatchObject({ kind: 'unknown' });
    expect(classifyCliArgs(['bun', 'buildd', 'logins', 'codex-first'])).toEqual({ kind: 'logins', cmd: { kind: 'set', raw: 'codex-first' } });
    expect(classifyCliArgs(['bun', 'buildd', 'logins'])).toEqual({ kind: 'logins', cmd: { kind: 'show' } });
  });

  test('an unknown mode is refused with the modes, and nothing is written', async () => {
    const dir = home();
    const file = join(dir, 'config.json');
    const r = await runLoginsCommand({ kind: 'set', raw: 'fastest' }, { configFile: file, socketPath: join(dir, 's'), probe: absent });
    expect(r.code).toBe(64);
    expect(r.stderr).toContain('balanced, claude-first or codex-first');
    expect(() => readFileSync(file, 'utf8')).toThrow();
  });

  test('with no runner it saves the mode for the next start', async () => {
    const dir = home();
    const file = join(dir, 'config.json');
    const r = await runLoginsCommand({ kind: 'set', raw: 'claude-first' }, { configFile: file, socketPath: join(dir, 's'), probe: absent });
    expect(r).toEqual({ code: 0, stdout: 'No runner is running on this machine. Saved: the next start uses claude-first.', stderr: '' });
    expect(readLoginModeFromConfig(file)).toBe('claude-first');
    const shown = await runLoginsCommand({ kind: 'show' }, { configFile: file, socketPath: join(dir, 's'), probe: absent });
    expect(shown.stdout).toBe('No runner is running on this machine. The next start uses claude-first.');
  });

  test('AC-14: with a runner it asks that runner and prints its line', async () => {
    const dir = home();
    const posts: Array<[string, Record<string, unknown>]> = [];
    const r = await runLoginsCommand({ kind: 'set', raw: 'codex-first' }, {
      configFile: join(dir, 'config.json'), socketPath: join(dir, 's'), probe: live,
      post: async (path, body) => { posts.push([path, body]); return { status: 200, body: { mode: 'codex-first', line: 'Login mode now codex-first. Running agents keep their login; the next claim follows it.' } }; },
    });
    expect(posts).toEqual([['/api/logins', { mode: 'codex-first' }]]);
    expect(r.stdout).toBe('Login mode now codex-first. Running agents keep their login; the next claim follows it.');
    const shown = await runLoginsCommand({ kind: 'show' }, {
      configFile: join(dir, 'config.json'), socketPath: join(dir, 's'), probe: live,
      get: async () => ({ status: 200, body: { mode: 'balanced', slots: 9, running: { claude: 6, codex: 2 } } }),
    });
    expect(shown.stdout).toBe('Login mode: balanced. Claude: 6 running (up to 6). Codex: 2 running (up to 3).');
  });

  test('a runner from before login modes says to update it', async () => {
    const dir = home();
    const r = await runLoginsCommand({ kind: 'set', raw: 'balanced' }, {
      configFile: join(dir, 'config.json'), socketPath: join(dir, 's'), probe: live,
      post: async () => ({ status: 404, body: 'Not found' }),
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('update it');
  });
});

describe("the runner's side (POST /api/logins)", () => {
  test('sets the mode, saves it, and never touches a running agent (R-19)', () => {
    const set: string[] = [];
    const r = applyLoginMode({ mode: 'claude-first' }, { setLoginMode: (m) => set.push(m) });
    expect(r).toEqual({ status: 200, body: { mode: 'claude-first', line: 'Login mode now claude-first. Running agents keep their login; the next claim follows it.' } });
    expect(set).toEqual(['claude-first']);
  });

  test('an unknown mode is a 400 and sets nothing', () => {
    const set: string[] = [];
    expect(applyLoginMode({ mode: 'x' }, { setLoginMode: (m) => set.push(m) }).status).toBe(400);
    expect(set).toEqual([]);
  });
});
