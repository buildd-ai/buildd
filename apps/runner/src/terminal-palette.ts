/**
 * The runner's terminal colours: brand tokens from docs/design/design-system.md
 * (design-system spec R-13), shared by `buildd top` and the startup banner.
 *
 * - Primary text (titles, row text) is the terminal's own default foreground
 *   (SGR 39), never a palette colour, so it reads on any background (R-17).
 *   Palette colours are for glyphs, the accent and muted meta.
 * - Theme order: BUILDD_THEME, then the background the terminal reports to an
 *   OSC 11 query (queryTerminalBackground, light = Day), then COLORFGBG (ends
 *   in 7 or 15 = Day), then Night. VS Code's terminal sets no COLORFGBG but
 *   answers OSC 11. Only `buildd top`, a foreground program, asks: the startup
 *   banner may run in the background, where touching the TTY stops the process.
 * - Truecolor when COLORTERM is truecolor/24bit, else the nearest xterm-256.
 * - NO_COLOR (any value) or a non-TTY drops every colour: the glyphs carry the
 *   meaning on their own.
 *
 * One accent only. Nothing here paints the terminal's own background except the
 * selected row.
 */

export type PaletteToken =
  | 'text'      // titles, row text: the terminal's default foreground, never a hex
  | 'selectedText' // --text-primary: text on the selected row's own background
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
    selectedText: '#ede8e2',
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
    selectedText: '#26231f',
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

/** A colour with each channel in 0..1. */
export interface Rgb { r: number; g: number; b: number }

/** The query for the terminal's background colour. */
export const OSC11_QUERY = '\x1b]11;?\x07';
/** How long `top` waits for the answer before drawing anyway (R-17). */
export const OSC11_TIMEOUT_MS = 150;

// eslint-disable-next-line no-control-regex
const OSC11_REPLY = /\x1b\]11;rgba?:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})(?:\/[0-9a-f]{1,4})?(?:\x07|\x1b\\)/i;

/** Parse `ESC ] 11 ; rgb:RRRR/GGGG/BBBB` ended by BEL or ST. Null when absent or unfinished. */
export function parseOsc11(s: string): Rgb | null {
  const m = OSC11_REPLY.exec(s);
  if (!m) return null;
  const ch = (h: string) => parseInt(h, 16) / (16 ** h.length - 1);
  return { r: ch(m[1]), g: ch(m[2]), b: ch(m[3]) };
}

/** Relative luminance (WCAG), 0 black .. 1 white. */
export function luminance({ r, g, b }: Rgb): number {
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function themeForBackground(bg: Rgb): Theme {
  // 0.18 is mid-grey's luminance: lighter than that is a light terminal.
  return luminance(bg) > 0.18 ? 'day' : 'night';
}

export interface QueryableTerminal {
  stdin: {
    isTTY?: boolean;
    isRaw?: boolean;
    setRawMode?(on: boolean): unknown;
    on(ev: 'data', cb: (d: any) => void): unknown;
    off?(ev: 'data', cb: (d: any) => void): unknown;
    removeListener?(ev: 'data', cb: (d: any) => void): unknown;
    resume?(): unknown;
    pause?(): unknown;
  };
  stdout: { isTTY?: boolean; write(s: string): unknown };
}

/**
 * Ask the terminal for its background (OSC 11) and wait at most `timeoutMs`.
 * Never throws and never waits longer. The reply is consumed here; anything
 * else read meanwhile (keys typed during startup, or the start of a reply cut
 * off by the timeout) comes back in `rest`, for a key decoder to read. Leaves
 * the terminal's raw mode as it found it, unless `leaveRaw` (the caller wants
 * raw mode next anyway).
 */
export function queryTerminalBackground(
  term: QueryableTerminal,
  timeoutMs = OSC11_TIMEOUT_MS,
  opts: { leaveRaw?: boolean } = {},
): Promise<{ background: Rgb | null; rest: string }> {
  const { stdin, stdout } = term;
  if (!stdin.isTTY || !stdout.isTTY) return Promise.resolve({ background: null, rest: '' });
  return new Promise(resolve => {
    let buf = '';
    let settled = false;
    const wasRaw = !!stdin.isRaw;
    const finish = (background: Rgb | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      (stdin.off ?? stdin.removeListener)?.call(stdin, 'data', onData);
      if (!wasRaw && !opts.leaveRaw) { try { stdin.setRawMode?.(false); } catch { /* gone */ } }
      // Drop the reply. An unfinished one stays in `rest` on purpose: fed to
      // top's key decoder it opens the terminal string, so the tail that
      // arrives later is swallowed too instead of being typed as keys.
      const rest = buf.replace(OSC11_REPLY, '');
      resolve({ background, rest });
    };
    const onData = (d: Buffer | string) => {
      buf += typeof d === 'string' ? d : d.toString('utf8');
      const bg = parseOsc11(buf);
      if (bg) finish(bg);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    try {
      if (!wasRaw) stdin.setRawMode?.(true);
      stdin.on('data', onData);
      stdin.resume?.();
      stdout.write(OSC11_QUERY);
    } catch {
      finish(null);
    }
  });
}

export function detectTheme(env: Env, background: Rgb | null = null): Theme {
  const forced = env.BUILDD_THEME?.toLowerCase();
  if (forced === 'day' || forced === 'light') return 'day';
  if (forced === 'night' || forced === 'dark') return 'night';
  if (background) return themeForBackground(background);
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
  // Primary text is the terminal's own foreground (R-17): readable whatever
  // the background, even when the theme guess is wrong.
  const fgCode = (token: PaletteToken) => (token === 'text' ? (depth === 'none' ? '' : RESET_FG) : sgr(hex[token], depth, 38));
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
export function terminalPalette(env: Env = process.env, isTTY = !!process.stdout.isTTY, background: Rgb | null = null): Palette {
  return createPalette(detectTheme(env, background), detectColorDepth(env, isTTY));
}

/** Strip SGR and OSC 8 sequences (for widths and plain snapshots). */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '').replace(/\x1b\]8;;[^\x07]*\x07/g, '');
}
