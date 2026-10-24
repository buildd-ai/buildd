/**
 * Design tokens: apps/web/src/design/tokens.json is generated from globals.css
 * (Night and Day colour tokens). Living Spec "Designs in buildd" R-18, AC-15, AC-16.
 *
 *   bun run scripts/design/tokens-check.ts            fail if tokens.json is stale
 *   bun run scripts/design/tokens-check.ts --write    regenerate tokens.json
 *   bun run scripts/design/tokens-check.ts <files>    also compare design HTML files
 *                                                     or a tokens file against globals.css
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';

export const CSS_PATH = 'apps/web/src/app/globals.css';
export const TOKENS_PATH = 'apps/web/src/design/tokens.json';

export type Theme = 'night' | 'day';
export type Tokens = Record<Theme, Record<string, string>>;
export interface TokenDiff {
  theme: Theme;
  token: string;
  expected: string;
  actual: string;
}

/** Night is `:root` / `[data-theme="dark"]`; Day is `[data-theme="light"]`. */
export function extractTokens(css: string): Tokens {
  const out: Tokens = { night: {}, day: {} };
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const unrecognized: string[] = [];
  for (const m of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = m[1].trim();
    let themes: Theme[] = [];
    if (/^\[data-theme=["']light["']\]$/.test(selector)) themes = ['day'];
    else if (/^:root\s*,\s*\[data-theme=["']dark["']\]$/.test(selector)) themes = ['night'];
    else if (/^:root\s*,\s*\[data-theme\]$/.test(selector)) themes = ['night', 'day'];
    else if (/^:root$/.test(selector)) themes = ['night', 'day'];
    if (themes.length === 0) {
      if (/^(:root|\[data-theme)/.test(selector)) unrecognized.push(selector);
      continue;
    }
    for (const d of m[2].matchAll(/(--[\w-]+)\s*:\s*([^;]+);?/g)) {
      const value = d[2].replace(/\s+/g, ' ').trim();
      for (const theme of themes) {
        out[theme][d[1]] = value;
      }
    }
  }
  if (unrecognized.length) {
    const msg = `Warning: unrecognized selectors with :root or [data-theme]: ${unrecognized.join(', ')}`;
    console.warn(msg);
  }
  return out;
}

function sorted(o: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

export function renderTokensJson(t: Tokens): string {
  return JSON.stringify({ night: sorted(t.night), day: sorted(t.day) }, null, 2) + '\n';
}

/** Tokens the other side declares with a different value; undeclared ones are not diffs. */
export function compareTokens(expected: Tokens, actual: Tokens): TokenDiff[] {
  const diffs: TokenDiff[] = [];
  for (const theme of ['night', 'day'] as const) {
    for (const [token, value] of Object.entries(actual[theme] ?? {})) {
      const want = expected[theme][token];
      if (want !== undefined && want !== value) diffs.push({ theme, token, expected: want, actual: value });
    }
  }
  return diffs;
}

export function parseTokensFile(path: string, text: string): Tokens {
  if (path.endsWith('.json')) {
    const j = JSON.parse(text);
    return { night: j.night ?? {}, day: j.day ?? {} };
  }
  return extractTokens(text);
}

function main(): number {
  const args = process.argv.slice(2);
  const write = args.includes('--write');
  const files = args.filter(a => !a.startsWith('--'));
  const root = join(import.meta.dir, '..', '..');
  const expected = extractTokens(readFileSync(join(root, CSS_PATH), 'utf8'));
  const rendered = renderTokensJson(expected);
  const target = join(root, TOKENS_PATH);
  let failed = false;

  if (write) {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, rendered);
    console.log(`wrote ${TOKENS_PATH}`);
  } else if (!existsSync(target) || readFileSync(target, 'utf8') !== rendered) {
    console.error(`${TOKENS_PATH} is stale versus ${CSS_PATH}. Run: bun run scripts/design/tokens-check.ts --write`);
    failed = true;
  }

  for (const f of files) {
    const diffs = compareTokens(expected, parseTokensFile(f, readFileSync(f, 'utf8')));
    for (const d of diffs) {
      console.error(`${f}: ${d.token} (${d.theme}) is ${d.actual}, globals.css has ${d.expected}`);
    }
    if (diffs.length) failed = true;
  }
  return failed ? 1 : 0;
}

if (import.meta.main) process.exit(main());
