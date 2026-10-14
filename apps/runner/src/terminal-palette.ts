/**
 * The runner's terminal colours: brand tokens from docs/design/design-system.md
 * (design-system spec R-13), shared by `buildd top` and the startup banner.
 *
 * - Night values by default; Day when the terminal reports a light background
 *   (COLORFGBG ends in 7 or 15) or BUILDD_THEME=day (BUILDD_THEME=night wins
 *   over COLORFGBG the other way).
 * - Truecolor when COLORTERM is truecolor/24bit, else the nearest xterm-256.
 * - NO_COLOR (any value) or a non-TTY drops every colour: the glyphs carry the
 *   meaning on their own.
 *
 * One accent only. Nothing here paints the terminal's own background except the
 * selected row.
 */

export type PaletteToken =
  | 'text'      // --text-primary: titles, row text
  | 'muted'     // --text-muted: role, elapsed, cost, reasons, key hints
  | 'faint'     // --faint: rules, pane divider, idle marks (never text)
  | 'selected'  // --surface-4: selected row background
  | 'accent'    // --accent-text: wordmark, ● running, live counts, decision prompts
  | 'warning'   // --status-warning: ? asking a question
  | 'success'   // --status-success: ✓ done / merged
  | 'info'      // --status-info: ◐ in review / auditing
  | 'error'     // --status-error: ✗ failed / blocked
  | 'queue';    // --q: ○ waiting in queue

export type Theme = 'night' | 'day';
export type ColorDepth = 'truecolor' | '256' | 'none';

export const PALETTE_HEX: Record<Theme, Record<PaletteToken, string>> = {
  night: {
    text: '#ede8e2',
    muted: '#a89f96',
    faint: '#7a7269',
    selected: '#2f2c28',
    accent: '#f59b4e',
    warning: '#f59b4e',
    success: '#86c99d',
    info: '#93b8d6',
    error: '#e08a7f',
    queue: '#a89f96',
  },
  day: {
    text: '#26231f',
    muted: '#6b655c',
    faint: '#8f887d',
    selected: '#eeebe4',
    accent: '#9a4a12',
    warning: '#a9521a',
    success: '#2f6440',
    info: '#2d5a7c',
    error: '#97391f',
    queue: '#5f594f',
  },
};

type Env = Record<string, string | undefined>;

export function detectTheme(env: Env): Theme {
  const forced = env.BUILDD_THEME?.toLowerCase();
  if (forced === 'day' || forced === 'light') return 'day';
  if (forced === 'night' || forced === 'dark') return 'night';
  // COLORFGBG is "fg;bg" (sometimes "fg;x;bg"); a light background is 7 or 15.
  const bg = env.COLORFGBG?.split(';').pop()?.trim();
  if (bg === '7' || bg === '15') return 'day';
  return 'night';
}

export function detectColorDepth(env: Env, isTTY: boolean): ColorDepth {
  if (env.NO_COLOR !== undefined) return 'none';
  if (!isTTY) return 'none';
  const ct = env.COLORTERM?.toLowerCase();
  if (ct === 'truecolor' || ct === '24bit') return 'truecolor';
  return '256';
}

function rgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

const CUBE = [0, 95, 135, 175, 215, 255];

/** Nearest xterm-256 index (6x6x6 cube or the grey ramp) for a hex colour. */
export function hexTo256(hex: string): number {
  const [r, g, b] = rgb(hex);
  const dist = (a: [number, number, number]) => (a[0] - r) ** 2 + (a[1] - g) ** 2 + (a[2] - b) ** 2;
  const nearestCube = (v: number) => {
    let best = 0;
    for (let i = 1; i < CUBE.length; i++) if (Math.abs(CUBE[i] - v) < Math.abs(CUBE[best] - v)) best = i;
    return best;
  };
  const ci = [nearestCube(r), nearestCube(g), nearestCube(b)];
  const cubeIdx = 16 + 36 * ci[0] + 6 * ci[1] + ci[2];
  const cubeDist = dist([CUBE[ci[0]], CUBE[ci[1]], CUBE[ci[2]]]);
  // Grey ramp: 232..255 = 8, 18, ..., 238.
  const avg = (r + g + b) / 3;
  const gi = Math.max(0, Math.min(23, Math.round((avg - 8) / 10)));
  const gv = 8 + gi * 10;
  const greyDist = dist([gv, gv, gv]);
  return greyDist < cubeDist ? 232 + gi : cubeIdx;
}

const RESET_FG = '\x1b[39m';
const RESET_BG = '\x1b[49m';
const RESET_ALL = '\x1b[0m';

export interface Palette {
  theme: Theme;
  depth: ColorDepth;
  /** Wrap text in a token's foreground. Identity when depth is none. */
  fg(token: PaletteToken, text: string): string;
  /** Wrap text in the selected-row background. Identity when depth is none. */
  selectedBg(text: string): string;
  bold(text: string): string;
  /** The raw SGR that starts a token's foreground ('' when depth is none). */
  fgCode(token: PaletteToken): string;
  reset: string;
}

function sgr(hex: string, depth: ColorDepth, layer: 38 | 48): string {
  if (depth === 'none') return '';
  if (depth === 'truecolor') {
    const [r, g, b] = rgb(hex);
    return `\x1b[${layer};2;${r};${g};${b}m`;
  }
  return `\x1b[${layer};5;${hexTo256(hex)}m`;
}

export function createPalette(theme: Theme, depth: ColorDepth): Palette {
  const hex = PALETTE_HEX[theme];
  const fgCode = (token: PaletteToken) => sgr(hex[token], depth, 38);
  const none = depth === 'none';
  return {
    theme,
    depth,
    fgCode,
    // Reset only the foreground, so a row's selected background survives.
    fg: (token, text) => (none ? text : `${fgCode(token)}${text}${RESET_FG}`),
    selectedBg: (text) => (none ? text : `${sgr(hex.selected, depth, 48)}${text}${RESET_BG}`),
    bold: (text) => (none ? text : `\x1b[1m${text}\x1b[22m`),
    reset: none ? '' : RESET_ALL,
  };
}

/** The palette for this process's terminal. */
export function terminalPalette(env: Env = process.env, isTTY = !!process.stdout.isTTY): Palette {
  return createPalette(detectTheme(env), detectColorDepth(env, isTTY));
}

/** Strip SGR and OSC 8 sequences (for widths and plain snapshots). */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '').replace(/\x1b\]8;;[^\x07]*\x07/g, '');
}
