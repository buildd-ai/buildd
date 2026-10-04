import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { EventEmitter } from 'events';

// No real browser in CI: every exec, spawn and fs check is mocked.
const mockExecSync = mock((_cmd: string, _opts?: unknown): Buffer => Buffer.from(''));
const mockExecFileSync = mock((_file: string, _args: string[], _opts?: any): Buffer => Buffer.from(''));
const mockSpawn = mock((_file: string, _args: string[], _opts?: any): any => null);
mock.module('child_process', () => ({ execSync: mockExecSync, execFileSync: mockExecFileSync, spawn: mockSpawn }));

const mockExistsSync = mock((_p: string) => false);
const mockStatSync = mock((_p: string): any => ({ mtimeMs: 1, ino: 1 }));
const mockRealpathSync = mock((p: string) => p);
mock.module('fs', () => ({
  existsSync: mockExistsSync,
  readFileSync: () => '',
  statSync: mockStatSync,
  realpathSync: mockRealpathSync,
}));

import {
  detectBrowser,
  detectBrowserAsync,
  checkBrowserCapability,
  refreshBrowserCapability,
  formatBrowserDetection,
  rescanBrowserCapability,
  applyBrowserCapability,
  applyAgentPlaywrightEnv,
  getLastBrowserDetection,
  browserProbeArgs,
  resetBrowserCapabilityCache,
  setBrowserProbeTimeoutForTests,
  SYSTEM_PLAYWRIGHT_DIR,
  FAILURE_BACKOFF_MS,
} from './browser-capability';
import { buildAgentBaseEnv, RUNNER_ENV_PASSTHROUGH } from './agent-env';
import { setPlaywrightPinForTests } from './playwright-pin';

const HTML = '<html><head></head><body></body></html>\n';
const SHELL = `${SYSTEM_PLAYWRIGHT_DIR}/chromium_headless_shell-1200/chrome-linux/headless_shell`;
const HANG = Symbol('hang');

function execError(status: number | null, stderr: string, extra: Record<string, unknown> = {}) {
  return Object.assign(new Error(`Command failed`), { status, stderr: Buffer.from(stderr), ...extra });
}

/** A simulated host: which binaries are on PATH, what find returns, how each launch behaves. */
interface Host {
  onPath?: Record<string, string>;
  dirs?: string[];
  found?: string[];
  realpath?: Record<string, string>;
  mtime?: Record<string, number>;
  /** Returns stdout, throws an execError, or returns HANG (async only: never exits). */
  launch?: Record<string, () => Buffer | typeof HANG>;
}
let host: Host;
/** Paths launched, in order, by either the sync or the async probe. */
let probes: string[];

function install(h: Host) {
  host = h;
}

function launchOf(file: string) {
  probes.push(file);
  const fn = host.launch?.[file];
  if (!fn) throw Object.assign(new Error(`spawn ${file} ENOENT`), { code: 'ENOENT' });
  return fn();
}

function fakeChild(file: string) {
  const child: any = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 4242;
  child.unref = () => {};
  queueMicrotask(() => {
    let out: Buffer | typeof HANG;
    try {
      out = launchOf(file);
    } catch (err: any) {
      if (err.status == null) { child.emit('error', err); return; }
      child.stderr.emit('data', err.stderr);
      child.emit('exit', err.status);
      child.emit('close', err.status);
      return;
    }
    if (out === HANG) return;
    child.stdout.emit('data', out);
    child.emit('exit', 0);
    child.emit('close', 0);
  });
  return child;
}

beforeEach(() => {
  resetBrowserCapabilityCache();
  // No pin unless a test sets one, so discovery order is the pin-agnostic one.
  setPlaywrightPinForTests(null);
  probes = [];
  host = {};
  delete process.env.PLAYWRIGHT_BROWSERS_PATH;
  mockExistsSync.mockReset();
  mockExistsSync.mockImplementation((p: string) => (host.dirs ?? []).includes(p));
  mockStatSync.mockReset();
  mockStatSync.mockImplementation((p: string) => ({ mtimeMs: host.mtime?.[p] ?? 1, ino: 7 }));
  mockRealpathSync.mockReset();
  mockRealpathSync.mockImplementation((p: string) => host.realpath?.[p] ?? p);
  mockExecSync.mockReset();
  mockExecSync.mockImplementation((cmd: string) => {
    if (cmd.startsWith('which ')) {
      const bin = cmd.slice('which '.length);
      const p = host.onPath?.[bin];
      if (p) return Buffer.from(`${p}\n`);
      throw execError(1, '');
    }
    if (cmd.startsWith('find ')) return Buffer.from((host.found ?? []).join('\n'));
    throw execError(1, 'unexpected shell command');
  });
  mockExecFileSync.mockReset();
  mockExecFileSync.mockImplementation((file: string) => {
    const out = launchOf(file);
    if (out === HANG) throw execError(null, '', { code: 'ETIMEDOUT', signal: 'SIGKILL' });
    return out;
  });
  mockSpawn.mockReset();
  mockSpawn.mockImplementation((file: string) => fakeChild(file));
});

afterEach(() => {
  delete process.env.PLAYWRIGHT_BROWSERS_PATH;
  setPlaywrightPinForTests();
});

describe('detectBrowser', () => {
  it('finds a Playwright headless shell under /opt/ms-playwright when it is the only browser installed', () => {
    install({
      dirs: [SYSTEM_PLAYWRIGHT_DIR],
      found: [SHELL],
      launch: { [SHELL]: () => Buffer.from(HTML) },
    });

    const d = detectBrowser();

    expect(d.available).toBe(true);
    expect(d.path).toBe(SHELL);
    expect(d.searched).toContain(SYSTEM_PLAYWRIGHT_DIR);
    // The find command asks for the headless shell names, not just "chrome".
    const findCmd = mockExecSync.mock.calls.map(c => c[0]).find(c => c.startsWith('find '))!;
    expect(findCmd).toContain(SYSTEM_PLAYWRIGHT_DIR);
    expect(findCmd).toContain('headless_shell');
    expect(findCmd).toContain('chrome-headless-shell');
    // Headless shell is launched with plain --headless.
    const args = mockExecFileSync.mock.calls[0][1];
    expect(args).toContain('--headless');
    expect(args).not.toContain('--headless=new');
  });

  it('finds chrome-headless-shell on PATH', () => {
    install({
      onPath: { 'chrome-headless-shell': '/usr/local/bin/chrome-headless-shell' },
      launch: { '/usr/local/bin/chrome-headless-shell': () => Buffer.from(HTML) },
    });
    expect(detectBrowser().path).toBe('/usr/local/bin/chrome-headless-shell');
  });

  it('searches PLAYWRIGHT_BROWSERS_PATH and ignores the "0" sentinel', () => {
    process.env.PLAYWRIGHT_BROWSERS_PATH = '/srv/pw';
    install({ dirs: ['/srv/pw'] });
    expect(detectBrowser().searched).toEqual(['/srv/pw']);

    process.env.PLAYWRIGHT_BROWSERS_PATH = '0';
    expect(detectBrowser().searched).toEqual([]);
  });

  it('launches a full Chromium with --headless=new and the probe flags', () => {
    const args = browserProbeArgs('/usr/bin/chromium');
    expect(args).toContain('--headless=new');
    expect(args).toContain('--no-sandbox');
    expect(args).toContain('--disable-gpu');
    expect(args.slice(-2)).toEqual(['--dump-dom', 'about:blank']);
  });

  it('launches via argv (no shell) and SIGKILLs on timeout', () => {
    install({ onPath: { chromium: '/usr/bin/chromium' }, launch: { '/usr/bin/chromium': () => Buffer.from(HTML) } });
    detectBrowser();
    const [file, args, opts] = mockExecFileSync.mock.calls[0];
    expect(file).toBe('/usr/bin/chromium');
    expect(Array.isArray(args)).toBe(true);
    expect(opts.killSignal).toBe('SIGKILL');
    expect(opts.timeout).toBeGreaterThan(0);
    // No launch went through a shell.
    expect(mockExecSync.mock.calls.some(c => String(c[0]).includes('--dump-dom'))).toBe(false);
  });

  it('is not available when the binary exists but the launch probe fails', () => {
    install({
      onPath: { chromium: '/usr/bin/chromium' },
      launch: {
        '/usr/bin/chromium': () => {
          throw execError(127, 'chromium: error while loading shared libraries: libnss3.so: cannot open shared object file');
        },
      },
    });

    const d = detectBrowser();

    expect(d.available).toBe(false);
    expect(d.attempts).toHaveLength(1);
    expect(d.attempts[0].exitCode).toBe(127);
    expect(d.attempts[0].stderrHead).toContain('libnss3.so');
  });

  it('is not available when the probe exits 0 without printing HTML (snap stub)', () => {
    install({
      onPath: { 'chromium-browser': '/usr/bin/chromium-browser' },
      launch: { '/usr/bin/chromium-browser': () => Buffer.from('Command requires the chromium snap to be installed.\n') },
    });
    const d = detectBrowser();
    expect(d.available).toBe(false);
    expect(d.attempts[0].reason).toBe('no html on stdout');
  });

  it('uses a working Playwright build even when a broken PATH binary exists', () => {
    install({
      onPath: { 'chromium-browser': '/usr/bin/chromium-browser' },
      dirs: [SYSTEM_PLAYWRIGHT_DIR],
      found: [SHELL],
      launch: {
        '/usr/bin/chromium-browser': () => Buffer.from('snap stub\n'),
        [SHELL]: () => Buffer.from(HTML),
      },
    });
    const d = detectBrowser();
    expect(d.path).toBe(SHELL);
    expect(d.attempts.map(a => a.path)).toEqual([SHELL]);
  });

  it('reports a timeout as the reason', () => {
    install({
      onPath: { chromium: '/usr/bin/chromium' },
      launch: {
        '/usr/bin/chromium': () => HANG,
      },
    });
    expect(detectBrowser().attempts[0].reason).toMatch(/timeout/);
  });

  it('caches a successful probe per path: a second scan does not relaunch', () => {
    install({ dirs: [SYSTEM_PLAYWRIGHT_DIR], found: [SHELL], launch: { [SHELL]: () => Buffer.from(HTML) } });
    expect(detectBrowser().available).toBe(true);
    expect(detectBrowser().available).toBe(true);
    expect(probes).toHaveLength(1);
  });

  it('backs off a failed probe: the same unchanged binary is not relaunched within the backoff', () => {
    install({
      onPath: { chromium: '/usr/bin/chromium' },
      launch: { '/usr/bin/chromium': () => { throw execError(127, 'libnss3.so missing'); } },
    });
    expect(detectBrowser().available).toBe(false);
    const again = detectBrowser();
    expect(again.available).toBe(false);
    expect(again.attempts[0].cached).toBe(true);
    expect(again.attempts[0].stderrHead).toContain('libnss3.so');
    expect(probes).toHaveLength(1);
  });

  it('re-probes a failed binary at once when it is reinstalled (mtime changes)', () => {
    let fixed = false;
    install({
      onPath: { chromium: '/usr/bin/chromium' },
      mtime: { '/usr/bin/chromium': 1 },
      launch: { '/usr/bin/chromium': () => { if (fixed) return Buffer.from(HTML); throw execError(127, 'libnss3.so missing'); } },
    });
    expect(detectBrowser().available).toBe(false);
    fixed = true;
    host.mtime = { '/usr/bin/chromium': 2 };
    expect(detectBrowser().available).toBe(true);
    expect(probes).toHaveLength(2);
  });

  it('re-probes a failed binary after the backoff, so a later install-deps is picked up', () => {
    let deps = false;
    install({
      onPath: { chromium: '/usr/bin/chromium' },
      launch: { '/usr/bin/chromium': () => { if (deps) return Buffer.from(HTML); throw execError(127, 'libnss3.so missing'); } },
    });
    const t0 = Date.now();
    const now = spyOn(Date, 'now').mockReturnValue(t0);
    try {
      expect(detectBrowser().available).toBe(false);
      deps = true;
      now.mockReturnValue(t0 + FAILURE_BACKOFF_MS - 1);
      expect(detectBrowser().available).toBe(false);
      now.mockReturnValue(t0 + FAILURE_BACKOFF_MS + 1);
      expect(detectBrowser().available).toBe(true);
    } finally {
      now.mockRestore();
    }
  });

  it('probes Playwright builds before PATH, so broken PATH entries cannot use up the launch cap', () => {
    install({
      onPath: {
        chromium: '/usr/bin/chromium',
        'chromium-browser': '/usr/bin/chromium-browser',
        'google-chrome': '/usr/bin/google-chrome',
      },
      dirs: [SYSTEM_PLAYWRIGHT_DIR],
      found: [SHELL],
      launch: {
        '/usr/bin/chromium': () => Buffer.from('snap stub\n'),
        '/usr/bin/chromium-browser': () => Buffer.from('snap stub\n'),
        '/usr/bin/google-chrome': () => { throw execError(1, 'broken'); },
        [SHELL]: () => Buffer.from(HTML),
      },
    });
    const d = detectBrowser();
    expect(d.available).toBe(true);
    expect(d.path).toBe(SHELL);
    expect(probes[0]).toBe(SHELL);
  });

  it('prefers the headless shell over full Chromium inside a Playwright dir', () => {
    const full = `${SYSTEM_PLAYWRIGHT_DIR}/chromium-1200/chrome-linux/chrome`;
    install({
      dirs: [SYSTEM_PLAYWRIGHT_DIR],
      found: [full, SHELL],
      launch: { [full]: () => Buffer.from(HTML), [SHELL]: () => Buffer.from(HTML) },
    });
    expect(detectBrowser().path).toBe(SHELL);
  });

  it('skips PATH entries that resolve into snapd and dedupes by realpath', () => {
    install({
      onPath: {
        chromium: '/usr/bin/chromium',
        'chromium-browser': '/usr/bin/chromium-browser',
        'google-chrome': '/usr/bin/google-chrome',
        'google-chrome-stable': '/usr/bin/google-chrome-stable',
      },
      realpath: {
        '/usr/bin/chromium': '/snap/bin/chromium',
        '/usr/bin/google-chrome': '/opt/google/chrome/chrome',
        '/usr/bin/google-chrome-stable': '/opt/google/chrome/chrome',
      },
      launch: {
        '/usr/bin/chromium-browser': () => { throw execError(1, 'broken'); },
        '/usr/bin/google-chrome': () => Buffer.from(HTML),
      },
    });
    const d = detectBrowser();
    expect(d.path).toBe('/usr/bin/google-chrome');
    expect(probes).toEqual(['/usr/bin/chromium-browser', '/usr/bin/google-chrome']);
  });

  it('caps the number of launches per scan', () => {
    const paths = Array.from({ length: 6 }, (_, i) => `${SYSTEM_PLAYWRIGHT_DIR}/c${i}/chrome`);
    install({ dirs: [SYSTEM_PLAYWRIGHT_DIR], found: paths, launch: {} });
    detectBrowser();
    expect(probes.length).toBeLessThanOrEqual(3);
  });

  it('records the Playwright root the passing build lives under', () => {
    install({ dirs: [SYSTEM_PLAYWRIGHT_DIR], found: [SHELL], launch: { [SHELL]: () => Buffer.from(HTML) } });
    expect(detectBrowser().browsersRoot).toBe(SYSTEM_PLAYWRIGHT_DIR);
  });
});

describe('detectBrowserAsync (periodic re-scan)', () => {
  it('launches with spawn in its own process group, never a blocking exec', async () => {
    install({ dirs: [SYSTEM_PLAYWRIGHT_DIR], found: [SHELL], launch: { [SHELL]: () => Buffer.from(HTML) } });
    const d = await detectBrowserAsync();
    expect(d.available).toBe(true);
    expect(mockExecFileSync).not.toHaveBeenCalled();
    const [file, args, opts] = mockSpawn.mock.calls[0];
    expect(file).toBe(SHELL);
    expect(args).toContain('--dump-dom');
    expect(opts.detached).toBe(true);
  });

  it('SIGKILLs the whole process group of a hung browser on timeout', async () => {
    setBrowserProbeTimeoutForTests(20);
    const kill = spyOn(process, 'kill').mockImplementation(() => true);
    try {
      install({ dirs: [SYSTEM_PLAYWRIGHT_DIR], found: [SHELL], launch: { [SHELL]: () => HANG } });
      const d = await detectBrowserAsync();
      expect(d.available).toBe(false);
      expect(d.attempts[0].reason).toMatch(/timeout/);
      expect(kill).toHaveBeenCalledWith(-4242, 'SIGKILL');
    } finally {
      kill.mockRestore();
    }
  });

  it('reports exit code and stderr for a failing async launch', async () => {
    install({ onPath: { chromium: '/usr/bin/chromium' }, launch: { '/usr/bin/chromium': () => { throw execError(127, 'libnss3.so missing'); } } });
    const d = await detectBrowserAsync();
    expect(d.attempts[0].exitCode).toBe(127);
    expect(d.attempts[0].stderrHead).toContain('libnss3.so');
  });

  it('does not block the event loop while a probe runs', async () => {
    setBrowserProbeTimeoutForTests(30);
    const kill = spyOn(process, 'kill').mockImplementation(() => true);
    try {
      install({ dirs: [SYSTEM_PLAYWRIGHT_DIR], found: [SHELL], launch: { [SHELL]: () => HANG } });
      let ticked = false;
      setTimeout(() => { ticked = true; }, 1);
      const p = detectBrowserAsync();
      await new Promise(r => setTimeout(r, 5));
      expect(ticked).toBe(true);
      await p;
    } finally {
      kill.mockRestore();
    }
  });
});

describe('formatBrowserDetection', () => {
  it('names the working binary', () => {
    expect(formatBrowserDetection({ available: true, path: SHELL, searched: [], attempts: [] })).toContain(SHELL);
  });

  it('lists what was searched when nothing was found', () => {
    const line = formatBrowserDetection({ available: false, searched: [SYSTEM_PLAYWRIGHT_DIR], attempts: [] });
    expect(line).toContain('browser: no');
    expect(line).toContain(SYSTEM_PLAYWRIGHT_DIR);
    expect(line).toContain('chrome-headless-shell');
    expect(line.split('\n')).toHaveLength(1);
  });

  it('shows path, exit code and stderr head for each failed probe', () => {
    const line = formatBrowserDetection({
      available: false,
      searched: [],
      attempts: [{ path: '/usr/bin/chromium', source: 'path', ok: false, exitCode: 127, stderrHead: 'libnss3.so missing' }],
    });
    expect(line).toContain('/usr/bin/chromium');
    expect(line).toContain('exit=127');
    expect(line).toContain('libnss3.so missing');
  });
});

describe('checkBrowserCapability logging', () => {
  it('logs one line on first check and stays quiet while the outcome is unchanged', async () => {
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      install({});
      checkBrowserCapability();
      checkBrowserCapability();
      expect(log).toHaveBeenCalledTimes(1);
      expect(String(log.mock.calls[0][0])).toContain('browser: no');

      install({ dirs: [SYSTEM_PLAYWRIGHT_DIR], found: [SHELL], launch: { [SHELL]: () => Buffer.from(HTML) } });
      await refreshBrowserCapability();
      expect(log).toHaveBeenCalledTimes(2);
      expect(String(log.mock.calls[1][0])).toContain('browser: yes');
      await refreshBrowserCapability();
      expect(log).toHaveBeenCalledTimes(2);
    } finally {
      log.mockRestore();
    }
  });

  it('after startup, the full env scan reuses the latest detection instead of launching', async () => {
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      install({ dirs: [SYSTEM_PLAYWRIGHT_DIR], found: [SHELL], launch: { [SHELL]: () => Buffer.from(HTML) } });
      expect(checkBrowserCapability()).toBe(true);
      install({}); // browser gone, but only the re-scan notices
      expect(checkBrowserCapability()).toBe(true);
      expect(probes).toHaveLength(1);
      await refreshBrowserCapability();
      expect(checkBrowserCapability()).toBe(false);
    } finally {
      log.mockRestore();
    }
  });
});

describe('rescanBrowserCapability', () => {
  const base = () => ({
    tools: [],
    envKeys: ['GITHUB_TOKEN', 'backend:codex'],
    mcp: [],
    labels: { type: 'local' as const, os: 'linux', arch: 'arm64', hostname: 'h' },
    scannedAt: new Date(0).toISOString(),
  });

  it('flips the browser key on when a browser is installed after startup, and off when it goes away', async () => {
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      install({});
      let env = (await rescanBrowserCapability(() => base()))!;
      expect(env.envKeys).not.toContain('browser');

      install({ dirs: [SYSTEM_PLAYWRIGHT_DIR], found: [SHELL], launch: { [SHELL]: () => Buffer.from(HTML) } });
      { const cur = env; env = (await rescanBrowserCapability(() => cur))!; }
      expect(env.envKeys).toContain('browser');
      expect(env.envKeys).toContain('GITHUB_TOKEN');
      expect(env.envKeys).toContain('backend:codex');

      install({}); // browser removed
      { const cur = env; env = (await rescanBrowserCapability(() => cur))!; }
      expect(env.envKeys).not.toContain('browser');
      expect(env.envKeys).toEqual(['GITHUB_TOKEN', 'backend:codex']);
    } finally {
      log.mockRestore();
    }
  });

  it('returns undefined when there is no environment yet', async () => {
    expect(await rescanBrowserCapability(() => undefined)).toBeUndefined();
  });

  it('applies the result to the environment current when the probe finishes, not when it started', async () => {
    install({ dirs: [SYSTEM_PLAYWRIGHT_DIR], found: [SHELL], launch: { [SHELL]: () => Buffer.from(HTML) } });
    let current = base();
    const p = rescanBrowserCapability(() => current);
    current = { ...base(), envKeys: ['NEW_KEY'] }; // a full scan landed meanwhile
    const env = (await p)!;
    expect(env.envKeys).toEqual(['NEW_KEY', 'browser']);
  });

  it('applyBrowserCapability does not duplicate the key and returns the same object when unchanged', () => {
    const env = { envKeys: ['browser', 'X'] };
    expect(applyBrowserCapability(env, true)).toBe(env);
    expect(applyBrowserCapability(env, false).envKeys).toEqual(['X']);
  });
});

describe('agent env carries the Playwright path the runner verified', () => {
  it('passes PLAYWRIGHT_BROWSERS_PATH through the allowlist', () => {
    expect(RUNNER_ENV_PASSTHROUGH.has('PLAYWRIGHT_BROWSERS_PATH')).toBe(true);
    const env = buildAgentBaseEnv(
      { HOME: '/home/coder', PLAYWRIGHT_BROWSERS_PATH: '/srv/pw', BUILDD_API_KEY: 'bld_x' },
      { available: false, searched: [], attempts: [] },
    );
    expect(env.PLAYWRIGHT_BROWSERS_PATH).toBe('/srv/pw');
    expect(env.BUILDD_API_KEY).toBeUndefined();
  });

  it('sets it to the verified Playwright root when the runner has none', () => {
    install({ dirs: [SYSTEM_PLAYWRIGHT_DIR], found: [SHELL], launch: { [SHELL]: () => Buffer.from(HTML) } });
    detectBrowser();
    const env = buildAgentBaseEnv({ HOME: '/home/coder' });
    expect(env.PLAYWRIGHT_BROWSERS_PATH).toBe(SYSTEM_PLAYWRIGHT_DIR);
    expect(getLastBrowserDetection()?.browsersRoot).toBe(SYSTEM_PLAYWRIGHT_DIR);
  });

  it('leaves an explicit value alone and sets nothing for a PATH browser or no browser', () => {
    expect(applyAgentPlaywrightEnv({ PLAYWRIGHT_BROWSERS_PATH: '/srv/pw' },
      { available: true, path: SHELL, browsersRoot: SYSTEM_PLAYWRIGHT_DIR, searched: [], attempts: [] }).PLAYWRIGHT_BROWSERS_PATH).toBe('/srv/pw');
    expect(applyAgentPlaywrightEnv({}, { available: true, path: '/usr/bin/chromium', searched: [], attempts: [] }).PLAYWRIGHT_BROWSERS_PATH).toBeUndefined();
    expect(applyAgentPlaywrightEnv({}, { available: false, searched: [SYSTEM_PLAYWRIGHT_DIR], attempts: [] }).PLAYWRIGHT_BROWSERS_PATH).toBeUndefined();
  });
});

describe('pinned Playwright build', () => {
  const PIN = { version: '1.61.1', chromiumRevision: '1228', headlessShellRevision: '1228' };
  const PINNED_CHROME = `${SYSTEM_PLAYWRIGHT_DIR}/chromium-1228/chrome-linux64/chrome`;
  const OTHER_SHELL = `${SYSTEM_PLAYWRIGHT_DIR}/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell`;

  it('probes the pinned build before another version\'s headless shell', () => {
    setPlaywrightPinForTests(PIN);
    install({
      dirs: [SYSTEM_PLAYWRIGHT_DIR],
      found: [OTHER_SHELL, PINNED_CHROME],
      launch: { [OTHER_SHELL]: () => Buffer.from(HTML), [PINNED_CHROME]: () => Buffer.from(HTML) },
    });
    const d = detectBrowser();
    expect(d.available).toBe(true);
    expect(d.path).toBe(PINNED_CHROME);
    expect(probes[0]).toBe(PINNED_CHROME);
    expect(d.pin).toEqual(PIN);
  });

  it('names the expected build, what is installed and the repair when no browser launches', () => {
    setPlaywrightPinForTests(PIN);
    install({ dirs: [SYSTEM_PLAYWRIGHT_DIR], found: [OTHER_SHELL], launch: {} });
    const line = formatBrowserDetection(detectBrowser());
    expect(line).toContain('browser: no');
    expect(line).toContain(OTHER_SHELL);
    expect(line).toContain('pinned Playwright 1.61.1 expects chromium_headless_shell-1228 / chromium-1228');
    expect(line).toContain('installed: none');
    expect(line).toContain('bun run browser:install');
    expect(line.split('\n')).toHaveLength(1);
  });

  it('lists the pinned build directory when it is present but fails to launch', () => {
    setPlaywrightPinForTests(PIN);
    const dir = `${SYSTEM_PLAYWRIGHT_DIR}/chromium-1228`;
    install({ dirs: [SYSTEM_PLAYWRIGHT_DIR, dir], found: [PINNED_CHROME], launch: { [PINNED_CHROME]: () => { throw execError(127, 'libnss3.so missing'); } } });
    const line = formatBrowserDetection(detectBrowser());
    expect(line).toContain(`installed: ${dir}`);
    expect(line).toContain('libnss3.so missing');
  });

  it('flags a working Playwright build that is not the pinned one', () => {
    setPlaywrightPinForTests(PIN);
    const line = formatBrowserDetection({
      available: true, path: OTHER_SHELL, browsersRoot: SYSTEM_PLAYWRIGHT_DIR, searched: [SYSTEM_PLAYWRIGHT_DIR], attempts: [], pin: PIN,
    });
    expect(line).toContain('browser: yes');
    expect(line).toContain('not the pinned build');
  });

  it('says nothing about the pin for a system Chromium on PATH', () => {
    const line = formatBrowserDetection({ available: true, path: '/usr/bin/chromium', searched: [], attempts: [], pin: PIN });
    expect(line).not.toContain('pinned');
  });
});
