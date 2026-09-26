import { describe, it, expect } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * `bg-text-primary` inverts with the theme: near-black in light mode, near-white
 * in dark mode. Pairing it with a fixed `text-white` made selected chips
 * white-on-white (unreadable) in dark mode. The foreground for an inverted
 * surface must invert too — use `text-surface-1`.
 */
const SRC = join(import.meta.dir, '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.tsx') && !p.includes('.test.')) out.push(p);
  }
  return out;
}

// Any single string literal (quotes or backticks) holding both tokens.
const STRING_LITERAL = /'[^'\n]*'|"[^"\n]*"|`[^`]*`/g;

function offenders(source: string): string[] {
  const hits: string[] = [];
  for (const m of source.matchAll(STRING_LITERAL)) {
    const tokens = new Set(m[0].slice(1, -1).split(/\s+/));
    if (tokens.has('bg-text-primary') && tokens.has('text-white')) hits.push(m[0].trim());
  }
  return hits;
}

describe('inverted chip contrast', () => {
  it('detects the bad pairing', () => {
    expect(offenders(`const c = active ? 'bg-text-primary text-white border-text-primary' : ''`)).toHaveLength(1);
    expect(offenders(`const c = active ? 'bg-text-primary text-surface-1' : ''`)).toHaveLength(0);
  });

  it('no component pairs bg-text-primary with a fixed text-white', () => {
    const bad: string[] = [];
    for (const file of walk(SRC)) {
      for (const hit of offenders(readFileSync(file, 'utf8'))) {
        bad.push(`${relative(SRC, file)}: ${hit}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
