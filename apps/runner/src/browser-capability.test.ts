import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';

// No real browser in CI: every exec and existence check is mocked.
const mockExecSync = mock((_cmd: string, _opts?: unknown): Buffer => Buffer.from(''));
mock.module('child_process', () => ({ execSync: mockExecSync }));

const mockExistsSync = mock((_p: string) => false);
mock.module('fs', () => ({ existsSync: mockExistsSync, readFileSync: () => '' }));

import {
  detectBrowser,
  checkBrowserCapability,
  formatBrowserDetection,
  rescanBrowserCapability,
  applyBrowserCapability,
  browserProbeCommand,
  resetBrowserCapabilityCache,
  SYSTEM_PLAYWRIGHT_DIR,
} from './browser-capability';

const HTML = '<html><head></head><body></body></html>\n';
const SHELL = `${SYSTEM_PLAYWRIGHT_DIR}/chromium_headless_shell-1200/chrome-linux/headless_shell`;

function execError(status: number | null, stderr: string, extra: Record<string, unknown> = {}) {
  return Object.assign(new Error(`Command failed`), { status, stderr: Buffer.from(stderr), ...extra });
}

/** A simulated host: which binaries are on PATH, what find returns, how each launch behaves. */
interface Host {
  onPath?: Record<string, string>;
  dirs?: string[];
  found?: string[];
  launch?: Record<string, () => Buffer>;
}
let host: Host;
let probes: string[];

function install(h: Host) {
  host = h;
}

beforeEach(() => {
  resetBrowserCapabilityCache();
  probes = [];
  host = {};
  delete process.env.PLAYWRIGHT_BROWSERS_PATH;
  mockExistsSync.mockReset();
  mockExistsSync.mockImplementation((p: string) => (host.dirs ?? []).includes(p));
  mockExecSync.mockReset();
  mockExecSync.mockImplementation((cmd: string) => {
    if (cmd.startsWith('which ')) {
      const bin = cmd.slice('which '.length);
      const p = host.onPath?.[bin];
      if (p) return Buffer.from(`${p}\n`);
      throw execError(1, '');
    }
    if (cmd.startsWith('find ')) return Buffer.from((host.found ?? []).join('\n'));
    if (cmd.includes('--dump-dom')) {
      probes.push(cmd);
      const path = Object.keys(host.launch ?? {}).find(p => cmd.startsWith(`'${p}'`));
      if (path) return host.launch![path]();
      throw execError(127, `${cmd.split(' ')[0]}: not found`);
    }
    throw execError(1, 'unexpected');
  });
});

afterEach(() => {
  delete process.env.PLAYWRIGHT_BROWSERS_PATH;
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
    expect(probes[0]).toContain(' --headless ');
    expect(probes[0]).not.toContain('--headless=new');
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
    const cmd = browserProbeCommand('/usr/bin/chromium');
    expect(cmd).toContain('--headless=new');
    expect(cmd).toContain('--no-sandbox');
    expect(cmd).toContain('--disable-gpu');
    expect(cmd).toContain('--dump-dom about:blank');
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

  it('falls through a broken PATH binary to a working Playwright build', () => {
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
    expect(d.attempts.map(a => a.ok)).toEqual([false, true]);
  });

  it('reports a timeout as the reason', () => {
    install({
      onPath: { chromium: '/usr/bin/chromium' },
      launch: {
        '/usr/bin/chromium': () => { throw execError(null, '', { code: 'ETIMEDOUT', signal: 'SIGTERM' }); },
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

  it('does not cache failures, so a later install-deps is picked up', () => {
    let deps = false;
    install({
      onPath: { chromium: '/usr/bin/chromium' },
      launch: { '/usr/bin/chromium': () => { if (deps) return Buffer.from(HTML); throw execError(127, 'libnss3.so missing'); } },
    });
    expect(detectBrowser().available).toBe(false);
    deps = true;
    expect(detectBrowser().available).toBe(true);
  });

  it('caps the number of launches per scan', () => {
    const paths = Array.from({ length: 6 }, (_, i) => `${SYSTEM_PLAYWRIGHT_DIR}/c${i}/chrome`);
    install({ dirs: [SYSTEM_PLAYWRIGHT_DIR], found: paths, launch: {} });
    detectBrowser();
    expect(probes.length).toBeLessThanOrEqual(3);
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
  it('logs one line on first check and stays quiet while the outcome is unchanged', () => {
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      install({});
      checkBrowserCapability();
      checkBrowserCapability();
      expect(log).toHaveBeenCalledTimes(1);
      expect(String(log.mock.calls[0][0])).toContain('browser: no');

      install({ dirs: [SYSTEM_PLAYWRIGHT_DIR], found: [SHELL], launch: { [SHELL]: () => Buffer.from(HTML) } });
      checkBrowserCapability();
      expect(log).toHaveBeenCalledTimes(2);
      expect(String(log.mock.calls[1][0])).toContain('browser: yes');
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

  it('flips the browser key on when a browser is installed after startup, and off when it goes away', () => {
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      install({});
      let env = rescanBrowserCapability(base())!;
      expect(env.envKeys).not.toContain('browser');

      install({ dirs: [SYSTEM_PLAYWRIGHT_DIR], found: [SHELL], launch: { [SHELL]: () => Buffer.from(HTML) } });
      env = rescanBrowserCapability(env)!;
      expect(env.envKeys).toContain('browser');
      expect(env.envKeys).toContain('GITHUB_TOKEN');
      expect(env.envKeys).toContain('backend:codex');

      install({}); // browser removed
      env = rescanBrowserCapability(env)!;
      expect(env.envKeys).not.toContain('browser');
      expect(env.envKeys).toEqual(['GITHUB_TOKEN', 'backend:codex']);
    } finally {
      log.mockRestore();
    }
  });

  it('returns undefined when there is no environment yet', () => {
    expect(rescanBrowserCapability(undefined)).toBeUndefined();
  });

  it('applyBrowserCapability does not duplicate the key and returns the same object when unchanged', () => {
    const env = { envKeys: ['browser', 'X'] };
    expect(applyBrowserCapability(env, true)).toBe(env);
    expect(applyBrowserCapability(env, false).envKeys).toEqual(['X']);
  });
});
