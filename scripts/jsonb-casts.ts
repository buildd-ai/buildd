/**
 * Casts of a jsonb column to a hand-written object type, behind
 * `scripts/jsonb-casts.test.ts`.
 *
 * `(w.waitingFor as { prompt: string; options?: string[] })` told the compiler
 * that option objects were strings; every fixture agreed, and the mission task
 * sheet crashed on a real question ("e.trim is not a function"). A cast is not
 * a check: it asserts whatever shape you type and turns the type checker off
 * for the one value most likely to have drifted, a column older rows and
 * newer writers fill differently.
 *
 * Flagged: `<expr>.<jsonbColumn> as { ... }` (also `as unknown as { ... }`)
 * where the literal claims a concrete field type. Columns are every
 * `jsonb('...')` property in packages/core/db/schema.ts, matched by name.
 *
 * Not flagged: a literal whose leaves are all `unknown` (`{ shipped?: unknown }`),
 * because that is the honest form: the reader still has to check the value.
 *
 * Fixing a hit, in order of preference:
 *   - give the column a `$type<T>()` in the schema (types only, no migration)
 *     and read it as that type, or a `Pick<T, ...>` of it;
 *   - cast to `{ field?: unknown }` and validate before use;
 *   - normalize through a shared reader (e.g. waitingForOptionLabels).
 * Matching is by property name, so a non-DB `.result as { ... }` (an HTTP body)
 * is flagged too; the `unknown` form fixes that just as well.
 *
 *   bun scripts/jsonb-casts.ts            # print counts
 *   bun scripts/jsonb-casts.ts --prune    # lower baseline counts to what remains
 *
 * `--prune` only ever lowers. A new cast is fixed by not writing it, never by
 * raising a number in the baseline.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const SCHEMA_PATH = 'packages/core/db/schema.ts';
export const BASELINE_PATH = 'scripts/jsonb-casts.baseline.json';

/** file → number of flagged casts. */
export type Baseline = Record<string, number>;

/** Property names of every jsonb column in the schema. */
export function jsonbColumns(schemaSource: string): string[] {
  const out = new Set<string>();
  for (const m of schemaSource.matchAll(/^\s+(\w+):\s*jsonb\(\s*['"]/gm)) out.add(m[1]);
  return [...out].sort();
}

/** The `{ ... }` starting at `open` (which must be `{`), braces balanced. */
function braceBlock(src: string, open: number): string | null {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1);
  }
  return null;
}

/** True when every leaf type in the literal is `unknown` (or null/undefined). */
export function onlyUnknownLeaves(literal: string): boolean {
  const rest = literal
    .replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '')
    .replace(/(?:readonly\s+)?['"]?[\w$-]+['"]?\??\s*:/g, '')
    .replace(/[{};,|\s]/g, ' ')
    .split(' ')
    .filter(Boolean);
  return rest.every(t => t === 'unknown' || t === 'null' || t === 'undefined');
}

/** Flagged casts in one source file, as `column: literal` strings. */
export function findCasts(source: string, columns: string[]): string[] {
  if (columns.length === 0) return [];
  const re = new RegExp(`\\.(${columns.join('|')})\\)?\\s+as\\s+(?:unknown\\s+as\\s+)?(?=\\{)`, 'g');
  const hits: string[] = [];
  for (const m of source.matchAll(re)) {
    const literal = braceBlock(source, m.index! + m[0].length);
    if (literal && !onlyUnknownLeaves(literal)) hits.push(`${m[1]}: ${literal.replace(/\s+/g, ' ')}`);
  }
  return hits;
}

export function scannedFiles(cwd = process.cwd()): string[] {
  const r = spawnSync('git', ['ls-files', 'apps', 'packages', 'scripts'], { cwd, encoding: 'utf8' });
  return r.stdout.split('\n').filter(f =>
    /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) && !/(^|\/)__tests__\//.test(f) && f !== SCHEMA_PATH && f !== 'scripts/jsonb-casts.ts');
}

export function scan(cwd = process.cwd()): Baseline {
  const columns = jsonbColumns(readFileSync(join(cwd, SCHEMA_PATH), 'utf8'));
  const out: Baseline = {};
  for (const f of scannedFiles(cwd)) {
    const n = findCasts(readFileSync(join(cwd, f), 'utf8'), columns).length;
    if (n > 0) out[f] = n;
  }
  return sortBaseline(out);
}

function sortBaseline(b: Baseline): Baseline {
  return Object.fromEntries(Object.entries(b).sort(([a], [z]) => a.localeCompare(z)));
}

export function readBaseline(cwd = process.cwd()): Baseline {
  return JSON.parse(readFileSync(join(cwd, BASELINE_PATH), 'utf8')) as Baseline;
}

/** Baseline lowered to the current counts. Never raises or adds. */
export function prune(baseline: Baseline, current: Baseline): Baseline {
  const out: Baseline = {};
  for (const [f, n] of Object.entries(baseline)) {
    const now = Math.min(n, current[f] ?? 0);
    if (now > 0) out[f] = now;
  }
  return sortBaseline(out);
}

const total = (b: Baseline) => Object.values(b).reduce((a, n) => a + n, 0);

if (import.meta.main) {
  const current = scan();
  if (process.argv.includes('--prune')) writeFileSync(BASELINE_PATH, JSON.stringify(prune(readBaseline(), current), null, 2) + '\n');
  console.log(`baseline: ${total(readBaseline())} casts`);
  console.log(`current:  ${total(current)} casts`);
}
