/**
 * The startup banner (R-17). It prints once, at startup, often from a runner
 * started in the background (`buildd &`), so it must never read the terminal:
 * no OSC 11 probe, no raw mode, no stdin. A background process that does is
 * stopped by the shell (SIGTTOU/SIGTTIN) and the runner freezes at startup.
 * Its primary text is the terminal's own foreground, so only its accent and
 * muted colours need a theme, and that comes from the environment
 * (BUILDD_THEME, then COLORFGBG, then Night). `buildd top`, an interactive
 * foreground program, keeps the probe.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { bannerPalette, renderBanner, type BannerInfo } from '../../src/banner';
import { createPalette, stripAnsi } from '../../src/terminal-palette';

const INFO: BannerInfo = {
  version: '0.340.0', commit: 'abc1234', debug: false, port: 8766, server: 'https://buildd.dev',
  apiKey: 'bld_test_key_1234', socketPath: '/tmp/x/runner.sock', repos: 3, reposCached: true, roots: 1,
  serverless: false, localUrl: 'http://localhost:8766',
};

describe('banner palette: from the environment, never the terminal', () => {
  test('never touches stdin or raw mode, and writes nothing', () => {
    const desc = Object.getOwnPropertyDescriptor(process, 'stdin')!;
    const out = process.stdout.write;
    let touched = 0;
    let wrote = 0;
    Object.defineProperty(process, 'stdin', { configurable: true, get() { touched++; throw new Error('the banner read stdin'); } });
    (process.stdout as any).write = () => { wrote++; return true; };
    try {
      const p = bannerPalette({ COLORTERM: 'truecolor' }, true);
      expect(p.theme).toBe('night');
    } finally {
      Object.defineProperty(process, 'stdin', desc);
      (process.stdout as any).write = out;
    }
    expect(touched).toBe(0);
    expect(wrote).toBe(0);
  });

  test('is synchronous: there is nothing to wait for', () => {
    const p = bannerPalette({}, true);
    expect(typeof (p as any).then).toBe('undefined');
  });

  test('BUILDD_THEME, then COLORFGBG, then Night', () => {
    expect(bannerPalette({ BUILDD_THEME: 'day', COLORFGBG: '15;0' }, true).theme).toBe('day');
    expect(bannerPalette({ BUILDD_THEME: 'night', COLORFGBG: '0;15' }, true).theme).toBe('night');
    expect(bannerPalette({ COLORFGBG: '0;15' }, true).theme).toBe('day');
    expect(bannerPalette({ COLORFGBG: '15;0' }, true).theme).toBe('night');
    expect(bannerPalette({}, true).theme).toBe('night');
  });

  test('NO_COLOR or a non-terminal stdout: no colour', () => {
    expect(bannerPalette({ NO_COLOR: '1' }, true).depth).toBe('none');
    expect(bannerPalette({}, false).depth).toBe('none');
  });

  test('the banner code path has no probe, stdin or raw mode in it', () => {
    const index = readFileSync(join(import.meta.dir, '../../src/index.ts'), 'utf8');
    const section = index.slice(index.indexOf('// ── Startup banner'), index.indexOf('// Auto-install HTTP MCP'));
    expect(section).toContain('bannerPalette(');
    for (const banned of ['queryTerminalBackground', 'detectTerminalPalette', 'stdin', 'setRawMode', 'await ']) {
      expect({ banned, found: section.includes(banned) }).toEqual({ banned, found: false });
    }
    const banner = readFileSync(join(import.meta.dir, '../../src/banner.ts'), 'utf8');
    for (const banned of ['queryTerminalBackground', 'stdin', 'setRawMode', 'OSC11_QUERY']) {
      expect({ banned, found: banner.includes(banned) }).toEqual({ banned, found: false });
    }
  });
});

describe('renderBanner', () => {
  test('on Day, meta is Day muted and never Night grey', () => {
    const out = renderBanner(INFO, createPalette('day', 'truecolor')).join('\n');
    expect(out).toContain('\x1b[38;2;107;101;92m'); // Day muted
    expect(out).not.toContain('\x1b[38;2;168;159;150m'); // Night muted
    expect(out).not.toContain('\x1b[38;2;237;232;226m'); // Night text
  });

  test('primary text (the values) is the terminal default foreground', () => {
    const lines = renderBanner(INFO, createPalette('day', 'truecolor'));
    const server = lines.find(l => stripAnsi(l).includes('https://buildd.dev'))!;
    expect(server).toContain('\x1b[39mhttps://buildd.dev');
    const socket = lines.find(l => stripAnsi(l).includes('runner.sock'))!;
    expect(socket).toContain('\x1b[39m/tmp/x/runner.sock');
  });

  test('NO_COLOR: plain text, same content', () => {
    const lines = renderBanner(INFO, createPalette('night', 'none'));
    expect(lines.join('\n')).not.toContain('\x1b[');
    expect(lines.some(l => l.includes('server   https://buildd.dev'))).toBe(true);
    expect(lines.some(l => l.includes('bld_···1234'))).toBe(true);
  });

  test('not logged in says how to fix it', () => {
    const lines = renderBanner({ ...INFO, apiKey: '' }, createPalette('night', 'none'));
    expect(lines.join('\n')).toContain('Not logged in — run buildd login');
  });
});
