/**
 * The startup banner (R-17): it asks the terminal for its background the same
 * way `buildd top` does, so a light terminal with no COLORFGBG (VS Code) gets
 * Day muted text instead of Night grey on white, and its primary text is the
 * terminal's own foreground.
 */
import { describe, expect, test } from 'bun:test';
import { renderBanner, type BannerInfo } from '../../src/banner';
import { OSC11_QUERY, createPalette, detectTerminalPalette, stripAnsi } from '../../src/terminal-palette';

function fakeTerminal(opts: { stdinTTY?: boolean; stdoutTTY?: boolean; reply?: string | null } = {}) {
  const listeners = new Set<(d: string) => void>();
  const writes: string[] = [];
  const raw: boolean[] = [];
  const stdin = {
    isTTY: opts.stdinTTY ?? true,
    isRaw: false,
    setRawMode(on: boolean) { raw.push(on); this.isRaw = on; },
    on(_e: 'data', cb: (d: string) => void) { listeners.add(cb); },
    off(_e: 'data', cb: (d: string) => void) { listeners.delete(cb); },
    resume() {}, pause() {},
  };
  const stdout = {
    isTTY: opts.stdoutTTY ?? true,
    write(s: string) {
      writes.push(s);
      if (s === OSC11_QUERY && opts.reply) setTimeout(() => { for (const l of [...listeners]) l(opts.reply!); }, 5);
      return true;
    },
  };
  return { stdin, stdout, writes, raw, listeners };
}

const INFO: BannerInfo = {
  version: '0.340.0', commit: 'abc1234', debug: false, port: 8766, server: 'https://buildd.dev',
  apiKey: 'bld_test_key_1234', socketPath: '/tmp/x/runner.sock', repos: 3, reposCached: true, roots: 1,
  serverless: false, localUrl: 'http://localhost:8766',
};

describe('banner palette: the same OSC 11 probe as top', () => {
  test('a white background answer gives Day, and the terminal is left as it was', async () => {
    const t = fakeTerminal({ reply: '\x1b]11;rgb:ffff/ffff/ffff\x07' });
    const p = await detectTerminalPalette(t, { COLORTERM: 'truecolor' });
    expect(t.writes).toEqual([OSC11_QUERY]);
    expect(p.theme).toBe('day');
    expect(t.raw).toEqual([true, false]);
    expect(t.listeners.size).toBe(0);
  });

  test('no answer: at most the 150 ms cap, then COLORFGBG / Night', async () => {
    const t = fakeTerminal({ reply: null });
    const start = Date.now();
    const p = await detectTerminalPalette(t, { COLORTERM: 'truecolor' });
    expect(Date.now() - start).toBeLessThan(600);
    expect(p.theme).toBe('night');
    expect(t.raw).toEqual([true, false]);
  });

  test('never asks unless both stdin and stdout are a terminal', async () => {
    for (const o of [{ stdinTTY: false }, { stdoutTTY: false }]) {
      const t = fakeTerminal({ ...o, reply: '\x1b]11;rgb:ffff/ffff/ffff\x07' });
      const p = await detectTerminalPalette(t, { COLORTERM: 'truecolor' });
      expect(t.writes).toEqual([]);
      expect(t.raw).toEqual([]);
      expect(p.theme).toBe('night');
    }
  });

  test('BUILDD_THEME still wins over the answer', async () => {
    const t = fakeTerminal({ reply: '\x1b]11;rgb:ffff/ffff/ffff\x07' });
    expect((await detectTerminalPalette(t, { BUILDD_THEME: 'night' })).theme).toBe('night');
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
