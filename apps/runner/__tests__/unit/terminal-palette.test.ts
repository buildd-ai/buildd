/**
 * The terminal palette shared by `buildd top` and the startup banner
 * (design-system spec R-13): Night by default, Day on a light terminal,
 * truecolor or nearest xterm-256, and nothing at all under NO_COLOR or off a TTY.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  PALETTE_HEX, createPalette, detectColorDepth, detectTheme, hexTo256, stripAnsi, terminalPalette, type PaletteToken,
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
