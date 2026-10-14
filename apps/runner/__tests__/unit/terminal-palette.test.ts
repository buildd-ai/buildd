/**
 * The terminal palette shared by `buildd top` and the startup banner
 * (design-system spec R-13): Night by default, Day on a light terminal,
 * truecolor or nearest xterm-256, and nothing at all under NO_COLOR or off a TTY.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  OSC11_QUERY, PALETTE_HEX, createPalette, detectColorDepth, detectTheme, hexTo256, luminance, parseOsc11,
  queryTerminalBackground, stripAnsi, terminalPalette, themeForBackground, type PaletteToken,
} from '../../src/terminal-palette';

const TOKENS = Object.keys(PALETTE_HEX.night) as PaletteToken[];
const mapping = (theme: 'night' | 'day', depth: 'truecolor' | '256' | 'none') => {
  const p = createPalette(theme, depth);
  return Object.fromEntries(TOKENS.map(t => [t, JSON.stringify(p.fg(t, 'x'))]));
};

describe('theme', () => {
  test('night by default', () => expect(detectTheme({})).toBe('night'));
  test('a light background in COLORFGBG means day', () => {
    expect(detectTheme({ COLORFGBG: '0;15' })).toBe('day');
    expect(detectTheme({ COLORFGBG: '0;default;7' })).toBe('day');
    expect(detectTheme({ COLORFGBG: '15;0' })).toBe('night');
  });
  test('BUILDD_THEME wins over COLORFGBG', () => {
    expect(detectTheme({ BUILDD_THEME: 'day' })).toBe('day');
    expect(detectTheme({ BUILDD_THEME: 'night', COLORFGBG: '0;15' })).toBe('night');
  });
});

describe('terminal background (OSC 11, R-17)', () => {
  const WHITE = { r: 1, g: 1, b: 1 };
  const BLACK = { r: 0, g: 0, b: 0 };

  test('parses rgb:RRRR/GGGG/BBBB ended by BEL or ST', () => {
    expect(parseOsc11('\x1b]11;rgb:ffff/ffff/ffff\x07')).toEqual(WHITE);
    expect(parseOsc11('\x1b]11;rgb:0000/0000/0000\x1b\\')).toEqual(BLACK);
    const vs = parseOsc11('\x1b]11;rgb:1e1e/1e1e/1e1e\x07')!;
    expect(vs.r).toBeCloseTo(0x1e1e / 0xffff, 5);
  });
  test('short hex components scale to the same range', () => {
    expect(parseOsc11('\x1b]11;rgb:ff/ff/ff\x07')).toEqual(WHITE);
    expect(parseOsc11('\x1b]11;rgb:f/f/f\x07')).toEqual(WHITE);
  });
  test('anything else is no answer', () => {
    expect(parseOsc11('')).toBeNull();
    expect(parseOsc11('\x1b]11;rgb:ffff/ffff\x07')).toBeNull();
    expect(parseOsc11('\x1b]10;rgb:ffff/ffff/ffff\x07')).toBeNull();
    expect(parseOsc11('\x1b]11;rgb:ffff/ffff/ffff')).toBeNull(); // not terminated yet
  });
  test('luminance decides the theme', () => {
    expect(luminance(WHITE)).toBeCloseTo(1, 5);
    expect(luminance(BLACK)).toBe(0);
    expect(themeForBackground(WHITE)).toBe('day');
    expect(themeForBackground({ r: 0.95, g: 0.94, b: 0.92 })).toBe('day');
    expect(themeForBackground({ r: 0.12, g: 0.12, b: 0.12 })).toBe('night');
  });
  test('order: BUILDD_THEME, then the terminal answer, then COLORFGBG, then night', () => {
    expect(detectTheme({}, WHITE)).toBe('day');
    expect(detectTheme({ COLORFGBG: '15;0' }, WHITE)).toBe('day');
    expect(detectTheme({ COLORFGBG: '0;15' }, BLACK)).toBe('night');
    expect(detectTheme({ BUILDD_THEME: 'night' }, WHITE)).toBe('night');
    expect(detectTheme({ COLORFGBG: '0;15' }, null)).toBe('day');
    expect(detectTheme({}, null)).toBe('night');
  });

  function fakeTerminal(reply: ((write: string, emit: (d: string) => void) => void) | null) {
    const listeners = new Set<(d: string) => void>();
    const emit = (d: string) => { for (const l of [...listeners]) l(d); };
    const writes: string[] = [];
    const raw: boolean[] = [];
    return {
      writes, raw, listeners,
      stdin: {
        isTTY: true,
        isRaw: false,
        setRawMode(on: boolean) { raw.push(on); this.isRaw = on; },
        on(_e: 'data', cb: (d: string) => void) { listeners.add(cb); },
        off(_e: 'data', cb: (d: string) => void) { listeners.delete(cb); },
        resume() {}, pause() {},
      },
      stdout: { isTTY: true, write(s: string) { writes.push(s); reply?.(s, emit); return true; } },
    };
  }

  test('asks the terminal and reads a white background', async () => {
    const t = fakeTerminal((w, emit) => { if (w === OSC11_QUERY) setTimeout(() => emit('\x1b]11;rgb:ffff/ffff/ffff\x07'), 5); });
    const r = await queryTerminalBackground(t, 150);
    expect(t.writes).toEqual([OSC11_QUERY]);
    expect(r.background).toEqual(WHITE);
    expect(r.rest).toBe('');
    expect(t.listeners.size).toBe(0);
  });

  test('a reply split across chunks still parses, and typed keys around it are kept', async () => {
    const t = fakeTerminal((w, emit) => {
      if (w !== OSC11_QUERY) return;
      setTimeout(() => { emit('j\x1b]11;rgb:00'); emit('00/0000/0000\x1b\\'); }, 5);
    });
    const r = await queryTerminalBackground(t, 150);
    expect(r.background).toEqual(BLACK);
    expect(r.rest).toBe('j');
  });

  test('no answer gives up after the timeout and never blocks longer', async () => {
    const t = fakeTerminal(null);
    const start = Date.now();
    const r = await queryTerminalBackground(t, 40);
    expect(Date.now() - start).toBeLessThan(400);
    expect(r.background).toBeNull();
    expect(t.listeners.size).toBe(0);
  });

  test('a terminal that is not a TTY is never asked', async () => {
    const t = fakeTerminal(null);
    (t.stdin as any).isTTY = false;
    const r = await queryTerminalBackground(t, 40);
    expect(t.writes).toEqual([]);
    expect(r.background).toBeNull();
  });
});

describe('primary text is the terminal default foreground (R-17, AC-6)', () => {
  test('text never carries a palette colour', () => {
    for (const theme of ['night', 'day'] as const) {
      for (const depth of ['truecolor', '256'] as const) {
        const p = createPalette(theme, depth);
        expect(p.fgCode('text')).toBe('\x1b[39m');
        expect(p.fg('text', 'title')).not.toMatch(/\x1b\[38;/);
      }
    }
  });
  test('meta and glyphs keep their palette colours', () => {
    expect(createPalette('night', 'truecolor').fgCode('muted')).toMatch(/^\x1b\[38;2;/);
    expect(createPalette('day', 'truecolor').fgCode('accent')).toMatch(/^\x1b\[38;2;/);
  });
  test('the selected row pairs its own background with the theme text colour', () => {
    const p = createPalette('night', 'truecolor');
    expect(p.fgCode('selectedText')).toBe('\x1b[38;2;237;232;226m');
  });
  test('terminalPalette takes the terminal answer into account', () => {
    expect(terminalPalette({}, true, { r: 1, g: 1, b: 1 }).theme).toBe('day');
    expect(terminalPalette({}, true, null).theme).toBe('night');
  });
});

describe('depth', () => {
  test('truecolor when COLORTERM says so', () => {
    expect(detectColorDepth({ COLORTERM: 'truecolor' }, true)).toBe('truecolor');
    expect(detectColorDepth({ COLORTERM: '24bit' }, true)).toBe('truecolor');
  });
  test('256 otherwise', () => expect(detectColorDepth({}, true)).toBe('256'));
  test('NO_COLOR (any value, even empty) and a non-TTY drop colour', () => {
    expect(detectColorDepth({ NO_COLOR: '', COLORTERM: 'truecolor' }, true)).toBe('none');
    expect(detectColorDepth({ NO_COLOR: '1' }, true)).toBe('none');
    expect(detectColorDepth({ COLORTERM: 'truecolor' }, false)).toBe('none');
  });
});

describe('token mapping', () => {
  test('night, truecolor', () => expect(mapping('night', 'truecolor')).toMatchSnapshot());
  test('night, 256', () => expect(mapping('night', '256')).toMatchSnapshot());
  test('day, truecolor', () => expect(mapping('day', 'truecolor')).toMatchSnapshot());
  test('day, 256', () => expect(mapping('day', '256')).toMatchSnapshot());

  test('NO_COLOR leaves text untouched', () => {
    const p = terminalPalette({ NO_COLOR: '1' }, true);
    for (const t of TOKENS) expect(p.fg(t, 'abc')).toBe('abc');
    expect(p.selectedBg('row')).toBe('row');
    expect(p.reset).toBe('');
  });

  test('the accent is the brand accent, not the old copper', () => {
    expect(createPalette('night', 'truecolor').fgCode('accent')).toBe('\x1b[38;2;245;155;78m');
    expect(JSON.stringify(PALETTE_HEX)).not.toMatch(/c8956a|34d399|f87171/i);
  });

  test('fg resets only the foreground, so a selected row keeps its background', () => {
    const p = createPalette('night', 'truecolor');
    const row = p.selectedBg(p.fg('text', 'a') + p.fg('muted', 'b'));
    expect(row.startsWith('\x1b[48;2;47;44;40m')).toBe(true);
    expect(row).not.toContain('\x1b[0m');
    expect(stripAnsi(row)).toBe('ab');
  });
});

describe('hexTo256', () => {
  test('exact cube and grey colours map to themselves', () => {
    expect(hexTo256('#ff0000')).toBe(196);
    expect(hexTo256('#000000')).toBe(16);
    expect(hexTo256('#080808')).toBe(232);
    expect(hexTo256('#eeeeee')).toBe(255);
  });
  test('brand accent lands on an orange', () => {
    expect(hexTo256("#f59b4e")).toBe(209); // #ff875f
  });
});

describe('startup banner uses the palette', () => {
  const src = readFileSync(join(import.meta.dir, '../../src/index.ts'), 'utf8');
  const banner = src.slice(src.indexOf('// ── Startup banner'), src.indexOf('// Auto-install HTTP MCP'));
  test('no hard-coded truecolor escapes or gradient left', () => {
    expect(banner).toContain('terminalPalette()');
    expect(banner).not.toMatch(/38;2;\d+;\d+;\d+m/);
    expect(banner).not.toMatch(/\bA[1-5]\b/);
  });
});
