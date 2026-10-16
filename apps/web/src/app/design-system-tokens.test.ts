/**
 * The token tables in docs/design/design-system.md §2 say what ships, so every
 * row has to match globals.css. "If this doc and globals.css ever disagree,
 * globals.css wins and this doc is the bug" — this test is how the bug is found.
 *
 * Each row of the form `| `--token` | `night` | `day` | ... |` (the first cell
 * may name two tokens, `--accent` / `--primary`) is checked against the Night
 * block (`:root, [data-theme="dark"]`) and the Day block (`[data-theme="light"]`),
 * whitespace-normalised and case-insensitive.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const css = readFileSync(join(import.meta.dir, 'globals.css'), 'utf8');
const doc = readFileSync(
  join(import.meta.dir, '..', '..', '..', '..', 'docs', 'design', 'design-system.md'),
  'utf8',
);

const NIGHT_SELECTOR = ':root, [data-theme="dark"]';
const DAY_SELECTOR = '[data-theme="light"]';

const norm = (v: string) => v.replace(/\s+/g, '').toLowerCase();

/** Every custom property declared directly in the block opened by `selector {`. */
export function themeDeclarations(source: string, selector: string): Map<string, string> {
  const start = source.indexOf(`\n${selector} {`);
  if (start === -1) throw new Error(`theme block not found: ${selector}`);
  const open = source.indexOf('{', start);
  const close = source.indexOf('}', open);
  const body = source.slice(open + 1, close).replace(/\/\*[\s\S]*?\*\//g, '');
  const tokens = new Map<string, string>();
  for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    tokens.set(m[1], norm(m[2]));
  }
  return tokens;
}

export interface TokenRow {
  line: number;
  tokens: string[];
  night: string;
  day: string;
}

/**
 * The `| `--token` | `night` | `day` |` rows of the doc's token tables: the
 * tables whose header reads `| Token | Night | Day |`. Other tables (§2.8
 * Retired, the geometry table) mention tokens without being a token table.
 */
export function tokenRows(markdown: string): TokenRow[] {
  const rows: TokenRow[] = [];
  let inTokenTable = false;
  markdown.split('\n').forEach((text, i) => {
    if (!text.startsWith('|')) {
      inTokenTable = false;
      return;
    }
    if (/^\|\s*Token\s*\|\s*Night\s*\|\s*Day\s*\|/.test(text)) {
      inTokenTable = true;
      return;
    }
    if (!inTokenTable || !text.startsWith('| `--')) return;
    const cells = text.split('|').slice(1, -1).map(c => c.trim());
    const tokens = [...cells[0].matchAll(/--[a-z0-9-]+/g)].map(m => m[0]);
    const value = (cell: string | undefined) => {
      const m = cell?.match(/^`([^`]+)`$/);
      if (!m) throw new Error(`line ${i + 1}: expected a backticked value, got ${JSON.stringify(cell)}`);
      return norm(m[1]);
    };
    rows.push({ line: i + 1, tokens, night: value(cells[1]), day: value(cells[2]) });
  });
  return rows;
}

const night = themeDeclarations(css, NIGHT_SELECTOR);
const day = themeDeclarations(css, DAY_SELECTOR);
const rows = tokenRows(doc);

describe('design-system.md token tables match globals.css', () => {
  it('finds the tables (a parse that sees nothing must not pass)', () => {
    // §2.1–§2.5 hold 38 rows today; a doc reshuffle that hides them fails here.
    expect(rows.length).toBeGreaterThanOrEqual(38);
    expect(night.size).toBeGreaterThan(40);
    expect(day.size).toBeGreaterThan(40);
    expect(rows.some(r => r.tokens.length === 2)).toBe(true); // `--accent` / `--primary`
  });

  for (const row of rows) {
    for (const token of row.tokens) {
      it(`${token} (doc line ${row.line})`, () => {
        expect({ token, theme: 'night', value: night.get(token) }).toEqual({
          token, theme: 'night', value: row.night,
        });
        expect({ token, theme: 'day', value: day.get(token) }).toEqual({
          token, theme: 'day', value: row.day,
        });
      });
    }
  }
});

describe('the parsers', () => {
  const table = (row: string) => `| Token | Night | Day | Use |\n|---|---|---|---|\n${row}`;

  it('reads both names of a double-name row', () => {
    const [row] = tokenRows(table('| `--accent` / `--primary` | `#F4811F` | `#e07a2e` | x |'));
    expect(row.tokens).toEqual(['--accent', '--primary']);
    expect(row.night).toBe('#f4811f');
  });

  it('normalises whitespace inside a value', () => {
    const [row] = tokenRows(table('| `--border` | `rgba(255,245,230,0.10)` | `#e3ded5` | x |'));
    const block = themeDeclarations('\n:root {\n  --border: rgba(255, 245, 230, 0.10);\n}', ':root');
    expect(block.get('--border')).toBe(row.night);
  });

  it('a mismatched value is caught', () => {
    const [row] = tokenRows(table('| `--q` | `#a89f96` | `#000000` | x |'));
    expect(day.get('--q')).not.toBe(row.day);
  });

  it('skips token mentions outside a Token | Night | Day table', () => {
    expect(tokenRows('| Was | Now |\n|---|---|\n| `--status-warning` ochre | orange |')).toEqual([]);
  });
});
