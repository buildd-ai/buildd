import { describe, it, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';

/**
 * The positive half of the hand-built-SQL convention (see
 * scripts/lint-hand-built-sql.ts for the negative half — the mechanical rules
 * that flag specific known-broken shapes).
 *
 * Two historical incidents shipped invalid SQL that no test in the route's own
 * file could ever have caught, because that file's suite replaces
 * `drizzle-orm` wholesale with object builders: `sql` is a stub that records
 * its template and never renders. The fix both times was the same — extract
 * the fragment into a named, exported function and render it through the REAL
 * `PgDialect` in a colocated test (apps/web/src/app/api/workers/claim/deps-gate.ts
 * + deps-gate.test.ts; apps/web/src/lib/handoff-gate.ts + handoff-gate.test.ts).
 *
 * The convention this enforces:
 *
 *   A hand-built SQL fragment with no rendered assertion is not tested.
 *
 * Checkable without a manual registry (unlike scripts/signal-fire-coverage.test.ts,
 * which needs one because a signal's "proof" isn't syntactically discoverable):
 * every exported function with an explicit `: SQL` return type is a fragment
 * claiming to be renderable, and some tracked test file either imports it and
 * renders it through PgDialect, or it doesn't. Both halves are mechanical scans
 * of `git ls-files`, same shape as scripts/collector-coverage.test.ts.
 */

function trackedFiles(): string[] {
  const ls = spawnSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return (ls.stdout ?? '').split('\0').filter(Boolean);
}

const EXCLUDE_DIRS_RE = /(^|\/)(node_modules|\.next|dist)\//;
const TEST_FILE_RE = /__tests__|\.test\.tsx?$|\.spec\.tsx?$/;
const SOURCE_FILE_RE = /\.tsx?$/;

interface ExportedSqlFn {
  file: string;
  name: string;
  basename: string; // filename without extension, for import-specifier matching
}

/**
 * Every `export function <name>(...): SQL` (optionally `| undefined` /
 * `| null`) in `src`. Walks the parameter list with a simple paren-depth
 * counter rather than a regex like `\([^)]*\)`, so a parameter type that
 * itself contains parens doesn't truncate the match early.
 */
function findExportedSqlFunctions(src: string, file: string): ExportedSqlFn[] {
  const out: ExportedSqlFn[] = [];
  const basename = file.replace(/^.*\//, '').replace(/\.tsx?$/, '');
  const re = /export function (\w+)\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const name = m[1];
    let i = m.index + m[0].length; // just after the function's opening '('
    let depth = 1;
    while (i < src.length && depth > 0) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')') depth--;
      i++;
    }
    const rest = src.slice(i, i + 80);
    if (/^\s*:\s*SQL\b/.test(rest)) {
      out.push({ file, name, basename });
    }
  }
  return out;
}

/**
 * Whether some tracked test file both imports `fn.name` from a module whose
 * specifier ends in `fn.basename` (covers relative imports, `@/`-alias
 * imports, and `@buildd/core`-style package imports alike) AND renders
 * something through `PgDialect`. This is deliberately not "the SAME test file
 * as `fn.file`'s sibling" — packages/core/memory-query-tokens-sql.ts and
 * packages/core/memory-file-scope-sql.ts are both tested from a
 * differently-named file in `__tests__/`, which is legitimate.
 */
function hasRenderedTest(fn: ExportedSqlFn, testFiles: Array<{ path: string; content: string }>): boolean {
  // Static `import { name } from '...basename'`, or the dynamic
  // `const { name } = await import('...basename')` destructure this repo's
  // bun tests reach for when `mock.module` must run before the module under
  // test loads (see packages/core/__tests__/worker-messages.test.ts) — both
  // are real coverage, so both count.
  const staticImportRe = new RegExp(`import\\s*\\{[^}]*\\b${fn.name}\\b[^}]*\\}\\s*from\\s*['"][^'"]*${fn.basename}['"]`);
  const dynamicImportRe = new RegExp(
    `(?:const|let|var)\\s*\\{[^}]*\\b${fn.name}\\b[^}]*\\}\\s*=\\s*await\\s*import\\(\\s*['"][^'"]*${fn.basename}['"]\\s*\\)`,
  );
  return testFiles.some((f) => (staticImportRe.test(f.content) || dynamicImportRe.test(f.content)) && /PgDialect/.test(f.content));
}

describe('SQL-render coverage sanity', () => {
  it('the corpus scan finds tracked source and test files', () => {
    const files = trackedFiles();
    expect(files.filter((f) => SOURCE_FILE_RE.test(f) && !EXCLUDE_DIRS_RE.test(f)).length).toBeGreaterThan(400);
    expect(files.filter((f) => TEST_FILE_RE.test(f)).length).toBeGreaterThan(400);
  });

  it('discovers at least the exported : SQL functions known at authoring time', () => {
    // Guards the guard: a regex regression that stops matching real exports
    // would make every check below vacuously pass over an empty set — exactly
    // the green-over-nothing failure this whole task exists to prevent.
    const files = trackedFiles().filter((f) => SOURCE_FILE_RE.test(f) && !EXCLUDE_DIRS_RE.test(f) && !TEST_FILE_RE.test(f));
    const found = files.flatMap((f) => (existsSync(f) ? findExportedSqlFunctions(readFileSync(f, 'utf8'), f) : []));
    expect(found.length).toBeGreaterThanOrEqual(14);
  });
});

describe('every exported : SQL function has a colocated PgDialect-rendered test', () => {
  const sourceFiles = trackedFiles().filter(
    (f) => SOURCE_FILE_RE.test(f) && !EXCLUDE_DIRS_RE.test(f) && !TEST_FILE_RE.test(f),
  );
  const testFiles = trackedFiles()
    .filter((f) => TEST_FILE_RE.test(f) && existsSync(f))
    .map((path) => ({ path, content: readFileSync(path, 'utf8') }));

  const allFns = sourceFiles.flatMap((f) => (existsSync(f) ? findExportedSqlFunctions(readFileSync(f, 'utf8'), f) : []));

  it.each(allFns.map((fn) => [`${fn.file}#${fn.name}`, fn] as const))('%s renders through PgDialect in a tracked test', (_label, fn) => {
    expect(
      hasRenderedTest(fn, testFiles),
      `${fn.file}#${fn.name} declares ": SQL" but no tracked test imports it and renders it through PgDialect. ` +
        'This is exactly the invisibility class that shipped PR #2598 and the dependsOn/depends_on identifier-folding ' +
        'bug: a route test that stubs drizzle-orm cannot see a malformed fragment. Add a test next to the function ' +
        "(or in the module's existing test file) that imports it, calls `new PgDialect().sqlToQuery(...)`, and " +
        'asserts on the rendered SQL text — not just on inputs/outputs of a mock.',
    ).toBe(true);
  });
});
