#!/usr/bin/env bun
/**
 * Flag hand-built `sql` fragments in the shape that has shipped broken SQL to
 * production three times in one night, all invisible to the route tests
 * beside them because those tests replace `drizzle-orm` with object builders
 * — the fragment is constructed, handed to a stub, and never rendered.
 *
 * This is a real recursive-descent scanner, not a line-based grep: it walks
 * each file tracking strings, comments, and nested `${...}` / `(...)` / `{...}`
 * regions so a multi-line `sql` template or a `sql.raw()` call spanning many
 * lines is parsed correctly, including a `sql` template nested inside another
 * template's `${...}` interpolation.
 *
 * Known simplification, shared with scripts/lint-model-ids.ts's tokenizer: a
 * `/regex/` literal is not distinguished from a `/` division operator, so a
 * regex containing a quote character inside a `${...}` region can desync the
 * quote-tracking briefly. Checked against this repo's actual codebase (1900+
 * files, including one such regex nested three levels deep inside a real
 * `sql.raw()` argument) with zero incorrect results — see the false-positive
 * count in this file's own run output — so this is a documented, verified
 * simplification rather than an untested gap.
 *
 * Three mechanical rules, in order of how many real incidents each one traces
 * to:
 *
 *   1. `ANY(${...})` inside a `sql`-tagged template. Interpolating a plain JS
 *      array into a template `sql` fragment expands it to a PARAMETER LIST,
 *      not a Postgres array, so it renders `ANY(($1, $2, $3))` — a row
 *      constructor, which `ANY` rejects outright on every execution. Fixed in
 *      the claim route (PR #2598) by moving to `inArray(...)`, which renders
 *      `IN ($1, $2, $3)` — the correct form.
 *
 *   2. `sql.raw(` whose argument is a template literal containing a `${...}`
 *      interpolation. `sql.raw` emits exactly the text it is handed with NO
 *      escaping and NO identifier quoting — both the identifier-folding bug
 *      (rule 3 below, when the interpolated text is a bare column name) and
 *      straightforward injection live here. The fix is almost never "escape
 *      harder": it's `${sql.identifier(name)}` (a real Drizzle column/table
 *      reference) so the interpolation happens outside `sql.raw` entirely, or
 *      a bound parameter if the value is data rather than an identifier.
 *
 *   3. A bare camelCase word inside a `sql` template's LITERAL text (i.e.
 *      outside any `${...}`) that matches a Drizzle schema property name whose
 *      snake_case column differs after Postgres's case-folding. Postgres folds
 *      an UNQUOTED identifier to lower case, so `dependsOn` arrives at the
 *      server as `dependson` — which is not `depends_on` and does not exist.
 *      The historical version of this bug (`dependsOn @> ...`) raised
 *      `undefined_column` on every execution and was swallowed by a
 *      deliberately fail-open `try/catch`, so "the query errored" read
 *      identically to "nothing depends on this task". The schema property list
 *      this rule checks against is derived from `packages/core/db/schema.ts`
 *      itself, not hardcoded, so it tracks new columns automatically.
 *
 * None of these rules ban hand-built SQL. Lateral joins, set-returning
 * functions, and jsonb operators are all real uses Drizzle's query builder
 * cannot express, and both historical fixes kept raw SQL — they extracted it
 * to a named function whose SQL is rendered through the real `PgDialect` and
 * asserted on in a test (see scripts/sql-render-coverage.test.ts for the
 * positive half of this convention). The goal is ASSERTED, not ABSENT.
 *
 * Usage:
 *   bun run scripts/lint-hand-built-sql.ts              # lint the repo
 *   bun run scripts/lint-hand-built-sql.ts --self-test  # prove the check can fail (and pass)
 */

import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';

const EXCLUDE_DIRS = new Set(['node_modules', '.next', 'dist', '.git']);
const TEST_FILE_RE = /__tests__|\.test\.|\.spec\./;
const SOURCE_FILE_RE = /\.tsx?$/;
const SCHEMA_PATH = 'packages/core/db/schema.ts';

// File-specific allowlist. Directories are NOT allowed here — see C30 in
// scripts/lint-model-ids.ts for how a directory entry silently loses coverage.
// Each entry states why the flagged construct is examined and intentional.
//
// Empty on purpose: every real hit this rule set found in the codebase (three
// sql.raw()-with-interpolation spots and one ANY(${...}) nested inside one of
// them, all in one-off migration/admin scripts) was a genuine fix — a
// dynamic-table-name sql.raw() rewritten to sql.identifier(), and a
// hand-escaped ARRAY[...] literal rewritten to inArray() — not a case that
// needed an exemption. Keep it that way: a diluted allowlist is how the
// model-id lint nearly lost its value (see scripts/lint-model-ids.ts).
const ALLOWLIST: string[] = [];

// ─── Recursive-descent scan ─────────────────────────────────────────────────
//
// One pass, no backtracking: whenever a bracket/paren/brace/template opens, the
// scanner recurses into a fresh call that consumes exactly that region and
// returns the index just past its match. This means nesting (a `sql` template
// inside a `${...}` of another `sql` template, a `sql.raw(...)` call inside a
// `${...}` interpolation, an object literal inside a call argument) is handled
// correctly without any explicit depth counters — each nested region is fully
// consumed by its own recursive call before the caller sees its next character.

interface TemplateMatch {
  start: number; // index of the opening backtick
  end: number; // index just past the closing backtick
  literalPieces: Array<{ start: number; end: number }>; // text OUTSIDE any ${...}
}

interface RawCallMatch {
  start: number; // index of `s` in the `sql.raw(` this call belongs to
  argStart: number; // index just past the call's opening `(`
  argEnd: number; // index of the call's closing `)`
  argText: string;
}

interface ScanState {
  templates: TemplateMatch[];
  rawCalls: RawCallMatch[];
}

function scanQuoted(src: string, start: number, quote: string): number {
  let i = start + 1;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '\\' && i + 1 < n) {
      i += 2;
      continue;
    }
    if (c === quote) return i + 1;
    i++;
  }
  return i;
}

function scanTemplate(src: string, start: number, isSqlTag: boolean, state: ScanState): number {
  let i = start + 1;
  const n = src.length;
  let literalStart = i;
  const literalPieces: Array<{ start: number; end: number }> = [];
  while (i < n) {
    const c = src[i];
    if (c === '\\' && i + 1 < n) {
      i += 2;
      continue;
    }
    if (c === '`') {
      literalPieces.push({ start: literalStart, end: i });
      const end = i + 1;
      if (isSqlTag) state.templates.push({ start, end, literalPieces });
      return end;
    }
    if (c === '$' && src[i + 1] === '{') {
      literalPieces.push({ start: literalStart, end: i });
      i = scan(src, i + 2, '}', state);
      literalStart = i;
      continue;
    }
    i++;
  }
  literalPieces.push({ start: literalStart, end: i });
  if (isSqlTag) state.templates.push({ start, end: i, literalPieces });
  return i;
}

/**
 * Scans code from `i`. If `stopChar` is set, returns the index just past the
 * first unnested occurrence of it (the caller already consumed the opening
 * bracket). If `stopChar` is undefined, scans to EOF — used for the top-level
 * file scan.
 *
 * Tracks the last few non-whitespace tokens ONLY to recognise `sql` directly
 * before a backtick (a tagged template) and the three-token sequence
 * `sql` `.` `raw` directly before a `(` (a `sql.raw` call). Nothing else reads
 * the token history.
 */
function scan(src: string, i: number, stopChar: '}' | ')' | ']' | undefined, state: ScanState): number {
  const n = src.length;
  let identBuf = '';
  const history: string[] = [];
  const flush = () => {
    if (identBuf) {
      history.push(identBuf);
      if (history.length > 4) history.shift();
      identBuf = '';
    }
  };

  while (i < n) {
    const c = src[i];
    if (stopChar && c === stopChar) {
      flush();
      return i + 1;
    }
    if (c === '/' && src[i + 1] === '/') {
      flush();
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      flush();
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === "'" || c === '"') {
      flush();
      i = scanQuoted(src, i, c);
      continue;
    }
    if (/[A-Za-z0-9_$]/.test(c)) {
      identBuf += c;
      i++;
      continue;
    }
    if (c === '`') {
      const word = identBuf;
      flush();
      i = scanTemplate(src, i, word === 'sql', state);
      continue;
    }
    if (c === '.') {
      flush();
      history.push('.');
      if (history.length > 4) history.shift();
      i++;
      continue;
    }
    if (c === '(') {
      flush(); // must happen BEFORE the history check: identBuf still holds the
      // token immediately before '(' (e.g. "raw") until flushed, so checking
      // history first would always miss it.
      const isRawCall = history.slice(-3).join('|') === 'sql|.|raw';
      const callStart = i - 'raw'.length - 1 - 'sql'.length; // best-effort; only used when isRawCall
      const argStart = i + 1;
      const argEnd = scan(src, argStart, ')', state);
      if (isRawCall) {
        state.rawCalls.push({
          start: Math.max(0, callStart),
          argStart,
          argEnd: argEnd - 1,
          argText: src.slice(argStart, argEnd - 1),
        });
      }
      i = argEnd;
      continue;
    }
    if (c === '{') {
      flush();
      i = scan(src, i + 1, '}', state);
      continue;
    }
    if (c === '[') {
      flush();
      i = scan(src, i + 1, ']', state);
      continue;
    }
    flush();
    i++;
  }
  flush();
  return i;
}

function analyze(src: string): ScanState {
  const state: ScanState = { templates: [], rawCalls: [] };
  scan(src, 0, undefined, state);
  return state;
}

// ─── Schema-derived risky property list (rule 3) ────────────────────────────

const COLUMN_DECL_RE = /^\s*([a-zA-Z_][a-zA-Z0-9_]*):\s*[a-zA-Z_][a-zA-Z0-9_.]*\(\s*'([a-z][a-z0-9_]*)'/;

/**
 * Every Drizzle schema property whose name, after Postgres folds an unquoted
 * identifier to lower case, no longer matches its real column name. A
 * single-word property (`status` -> `status`) survives folding intact; a
 * multi-word one (`dependsOn` -> `dependson`) does not, and a bare occurrence
 * of it in raw SQL text asks Postgres for a column that was never created.
 */
function deriveRiskySchemaProps(schemaAbsPath: string): Map<string, string> {
  const risky = new Map<string, string>();
  if (!existsSync(schemaAbsPath)) return risky;
  const lines = readFileSync(schemaAbsPath, 'utf8').split('\n');
  for (const line of lines) {
    const m = COLUMN_DECL_RE.exec(line);
    if (!m) continue;
    const [, propName, columnName] = m;
    if (propName.toLowerCase() !== columnName) {
      risky.set(propName, columnName);
    }
  }
  return risky;
}

/** Blanks SQL `--` line comments and quoted string/identifier content, so a comment or a quoted alias cannot trip rule 3. */
function stripSqlCommentsAndQuotes(text: string): string {
  return text
    .replace(/--[^\n]*/g, ' ')
    .replace(/"[^"]*"/g, (m) => ' '.repeat(m.length))
    .replace(/'[^']*'/g, (m) => ' '.repeat(m.length));
}

// ─── Violations ──────────────────────────────────────────────────────────────

interface Violation {
  file: string;
  line: number;
  rule: 'any-param-list' | 'raw-template-interpolation' | 'folded-identifier';
  text: string;
  detail: string;
}

function lineAt(src: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < src.length; i++) {
    if (src[i] === '\n') line++;
  }
  return line;
}

/**
 * Whether this file actually binds `sql` to drizzle-orm's tag — static or
 * dynamic import, either form seen in this repo.
 *
 * All three rules key off the bare identifier `sql`, but that name is not
 * reserved: `@neondatabase/serverless`'s `neon(...)` and `postgres.js`'s
 * client are both commonly assigned to a local `sql` too, and BOTH of those
 * libraries correctly cast a JS array into a real Postgres array on
 * interpolation — the exact thing drizzle's `sql` tag does NOT do, which is
 * what rule 1 exists to catch. A file that never imports `sql` from
 * `drizzle-orm` gets no violations at all, regardless of what its local `sql`
 * variable is tagged with.
 */
function importsDrizzleSql(src: string): boolean {
  return (
    /import\s*\{[^}]*\bsql\b[^}]*\}\s*from\s*['"]drizzle-orm['"]/.test(src) ||
    /(?:const|let|var)\s*\{[^}]*\bsql\b[^}]*\}\s*=\s*await\s*import\(\s*['"]drizzle-orm['"]\s*\)/.test(src)
  );
}

function findViolations(src: string, relPath: string, riskyProps: Map<string, string>): Violation[] {
  if (!importsDrizzleSql(src)) return [];
  const violations: Violation[] = [];
  const { templates, rawCalls } = analyze(src);

  for (const t of templates) {
    const raw = src.slice(t.start, t.end);

    // Rule 1: ANY(${...}) — array-as-parameter-list.
    const anyRe = /ANY\(\s*\$\{/g;
    let m: RegExpExecArray | null;
    while ((m = anyRe.exec(raw))) {
      violations.push({
        file: relPath,
        line: lineAt(src, t.start + m.index),
        rule: 'any-param-list',
        text: raw.slice(m.index, m.index + 40).replace(/\s+/g, ' ').trim(),
        detail:
          'ANY(${...}) — a JS array interpolated here expands to a parameter list, not a Postgres array, ' +
          'and renders as a row constructor ANY() rejects on every execution. Use inArray(...) instead.',
      });
    }

    // Rule 3: bare camelCase schema property in literal (non-${}) text.
    for (const piece of t.literalPieces) {
      const pieceText = src.slice(piece.start, piece.end);
      const masked = stripSqlCommentsAndQuotes(pieceText);
      for (const [prop, col] of riskyProps) {
        const wordRe = new RegExp(`\\b${prop}\\b`);
        const wm = wordRe.exec(masked);
        if (wm) {
          violations.push({
            file: relPath,
            line: lineAt(src, piece.start + wm.index),
            rule: 'folded-identifier',
            text: wm[0],
            detail:
              `bare '${prop}' in raw SQL text — Postgres folds this unquoted identifier to lower case ` +
              `('${prop.toLowerCase()}'), which does not match the real column '${col}'. ` +
              `Use \${<table>.${prop}} (or sql.identifier('${col}')) instead of the bare property name.`,
          });
        }
      }
    }
  }

  // Rule 2: sql.raw(...) whose argument is a template literal with an interpolation.
  for (const call of rawCalls) {
    const trimmed = call.argText.trimStart();
    if (trimmed.startsWith('`') && call.argText.includes('${')) {
      violations.push({
        file: relPath,
        line: lineAt(src, call.argStart),
        rule: 'raw-template-interpolation',
        text: call.argText.slice(0, 60).replace(/\s+/g, ' ').trim(),
        detail:
          "sql.raw() argument is a template literal with a ${...} interpolation — sql.raw() emits exactly " +
          'the text it is handed, with no escaping and no identifier quoting. Use ${sql.identifier(name)} ' +
          '(interpolated in a sql`` template, outside sql.raw) for an identifier, or a bound parameter for data.',
      });
    }
  }

  return violations;
}

// ─── File walking ────────────────────────────────────────────────────────────

function walk(root: string, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name)) continue;
      walk(join(root, entry.name), out);
    } else if (entry.isFile() && SOURCE_FILE_RE.test(entry.name)) {
      out.push(join(root, entry.name));
    }
  }
  return out;
}

function isAllowlisted(relPath: string): boolean {
  return ALLOWLIST.some((entry) => relPath === entry);
}

function lint(root: string): { exitCode: number } {
  for (const entry of ALLOWLIST) {
    if (entry.endsWith('/') || !/\.tsx?$/.test(entry)) {
      console.log(`ERROR: allowlist entry '${entry}' must be an exact .ts/.tsx file path, not a directory.`);
      return { exitCode: 1 };
    }
  }

  const riskyProps = deriveRiskySchemaProps(join(root, SCHEMA_PATH));
  if (riskyProps.size === 0) {
    console.log(`ERROR: derived zero risky schema properties from ${SCHEMA_PATH} — schema parsing is broken.`);
    return { exitCode: 1 };
  }

  const files = walk(root);
  let scanned = 0;
  let testFiles = 0;
  let allowedHits = 0;
  const violations: Violation[] = [];

  for (const absPath of files) {
    scanned++;
    const relPath = relative(root, absPath).split('\\').join('/');
    if (TEST_FILE_RE.test(relPath)) {
      testFiles++;
      continue;
    }
    const src = readFileSync(absPath, 'utf8');
    const found = findViolations(src, relPath, riskyProps);
    if (found.length === 0) continue;
    if (isAllowlisted(relPath)) {
      allowedHits += found.length;
      continue;
    }
    violations.push(...found);
  }

  console.log(
    `lint-hand-built-sql: scanned ${scanned} source file(s) (${testFiles} test file(s) excluded); ` +
      `${riskyProps.size} risky schema properties derived from ${SCHEMA_PATH}; ` +
      `${allowedHits} allowlisted hit(s); ${violations.length} violation(s)`,
  );

  if (violations.length > 0) {
    console.log('ERROR: hand-built SQL fragments that will render invalid or wrong SQL:');
    for (const v of violations) {
      console.log(`${v.file}:${v.line} [${v.rule}] ${v.text}`);
      console.log(`  ${v.detail}`);
    }
    return { exitCode: 1 };
  }

  console.log('lint-hand-built-sql: OK');
  return { exitCode: 0 };
}

// ─── Self-test ───────────────────────────────────────────────────────────────

function assert(name: string, condition: boolean, detail: string): boolean {
  console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${name}${condition ? '' : ` — ${detail}`}`);
  return condition;
}

function selfTest(repoRoot: string): number {
  const tmp = mkdtempSync(join(tmpdir(), 'lint-hand-built-sql-'));
  let ok = true;
  try {
    mkdirSync(join(tmp, 'src'), { recursive: true });

    const riskyProps = deriveRiskySchemaProps(join(repoRoot, SCHEMA_PATH));
    ok =
      assert(
        'schema parsing finds dependsOn as a risky property',
        riskyProps.has('dependsOn') && riskyProps.get('dependsOn') === 'depends_on',
        `got ${JSON.stringify([...riskyProps.entries()].filter(([k]) => k === 'dependsOn'))}`,
      ) && ok;

    // ── Historical defect #1: PR #2598, "ANY over a parameter list broke every claim". ──
    const bug1 = `
import { sql } from 'drizzle-orm';
import { tasks } from '@buildd/core/db/schema';
export function dependentCountQuery(claimedTaskIds: string[]) {
  return sql\`
    SELECT dep_id AS "taskId", count(*)::integer AS "dependentCount"
    FROM \${tasks}, jsonb_array_elements_text(\${tasks.dependsOn}::jsonb) AS dep_id
    WHERE dep_id = ANY(\${claimedTaskIds})
      AND \${tasks.status} != 'cancelled'
    GROUP BY dep_id
  \`;
}
`;

    // ── Historical defect #2: the handoff gate's "dependsOn @> ..." raw fragment. ──
    const bug2 = `
import { and, inArray, not, sql } from 'drizzle-orm';
import { tasks } from '@buildd/core/db/schema';
export function unfinishedDependentPredicate(taskId: string) {
  return and(
    sql\`dependsOn @> \${sql.raw(\`'"\${taskId}"'\`)}\`,
    not(inArray(tasks.status, ['cancelled'])),
  );
}
`;

    // ── Corrected form of defect #1: inArray, no ANY(${array}). Must pass. ──
    const fixed1 = `
import { sql, inArray } from 'drizzle-orm';
import { tasks } from '@buildd/core/db/schema';
export function dependentCountQuery(claimedTaskIds: string[]) {
  return sql\`
    SELECT dep_id AS "taskId", count(*)::integer AS "dependentCount"
    FROM \${tasks}, jsonb_array_elements_text(\${tasks.dependsOn}::jsonb) AS dep_id
    WHERE \${inArray(sql\`dep_id\`, claimedTaskIds)}
      AND \${tasks.status} != 'cancelled'
    GROUP BY dep_id
  \`;
}
`;

    // ── Corrected form of defect #2: real column reference via ${...}. Must pass. ──
    const fixed2 = `
import { and, inArray, not, sql } from 'drizzle-orm';
import { tasks } from '@buildd/core/db/schema';
export function unfinishedDependentPredicate(taskId: string) {
  return and(
    sql\`\${tasks.dependsOn} @> \${JSON.stringify([taskId])}::jsonb\`,
    not(inArray(tasks.status, ['cancelled'])),
  );
}
`;

    // ── A completely unrelated, clean file. Must pass. ──
    const clean = `
export function add(a: number, b: number): number {
  return a + b;
}
`;

    // ── sql.raw() with a plain (non-interpolated) argument is fine. Must pass. ──
    const rawClean = `
import { sql } from 'drizzle-orm';
const STALE_AFTER = "'30 minutes'";
export const cond = sql\`updated_at < now() - interval \${sql.raw(STALE_AFTER)}\`;
`;

    // ── A non-'sql' tagged template using the same ANY(${...}) text must NOT flag —
    // e.g. postgres.js's own tag correctly casts arrays, this rule is 'sql'-specific. ──
    const otherTag = `
export async function query(memDb: any, ids: string[]) {
  return memDb\`SELECT id FROM memories WHERE id = ANY(\${ids}::text[])\`;
}
`;

    // ── A LOCAL variable named 'sql' that is NOT drizzle's tag must NOT flag,
    // even though the bare identifier is the same. Real case found scanning
    // this repo: scripts/prune-wildcard-deps.ts binds `const sql = neon(...)`,
    // and @neondatabase/serverless's tag (like postgres.js's) DOES cast a JS
    // array into a real Postgres array on interpolation — the file never
    // imports `sql` from drizzle-orm, so this must produce zero violations. ──
    const neonShadow = `
import { neon } from '@neondatabase/serverless';
async function run(DATABASE_URL: string, ACTIVE_STATUSES: string[]) {
  const sql = neon(DATABASE_URL);
  return await sql\`SELECT id FROM tasks WHERE status = ANY(\${ACTIVE_STATUSES})\`;
}
`;

    const fixtures: Record<string, string> = {
      'src/bug1-any-param-list.ts': bug1,
      'src/bug2-folded-identifier.ts': bug2,
      'src/fixed1-in-array.ts': fixed1,
      'src/fixed2-real-column-ref.ts': fixed2,
      'src/clean.ts': clean,
      'src/raw-clean.ts': rawClean,
      'src/other-tag.ts': otherTag,
      'src/neon-shadow.ts': neonShadow,
    };
    for (const [path, contents] of Object.entries(fixtures)) {
      writeFileSync(join(tmp, path), contents);
    }

    const findFor = (relName: string) => {
      const absPath = join(tmp, relName);
      const src = readFileSync(absPath, 'utf8');
      return findViolations(src, relName, riskyProps);
    };

    const bug1Violations = findFor('src/bug1-any-param-list.ts');
    ok =
      assert(
        'bug #1 (ANY(${array})) is caught',
        bug1Violations.some((v) => v.rule === 'any-param-list'),
        `violations: ${JSON.stringify(bug1Violations)}`,
      ) && ok;
    // bug1's SQL also correctly references ${tasks.dependsOn} (not bare), so rule 3 must NOT fire on it.
    ok =
      assert(
        'bug #1 fixture does not also spuriously trip rule 3',
        !bug1Violations.some((v) => v.rule === 'folded-identifier'),
        `violations: ${JSON.stringify(bug1Violations)}`,
      ) && ok;

    const bug2Violations = findFor('src/bug2-folded-identifier.ts');
    ok =
      assert(
        'bug #2 (bare dependsOn) is caught',
        bug2Violations.some((v) => v.rule === 'folded-identifier' && v.text === 'dependsOn'),
        `violations: ${JSON.stringify(bug2Violations)}`,
      ) && ok;
    ok =
      assert(
        'bug #2 (sql.raw with template interpolation) is caught',
        bug2Violations.some((v) => v.rule === 'raw-template-interpolation'),
        `violations: ${JSON.stringify(bug2Violations)}`,
      ) && ok;

    ok =
      assert('fixed form #1 (inArray) has zero violations', findFor('src/fixed1-in-array.ts').length === 0, `violations: ${JSON.stringify(findFor('src/fixed1-in-array.ts'))}`) &&
      ok;
    ok =
      assert('fixed form #2 (real column ref) has zero violations', findFor('src/fixed2-real-column-ref.ts').length === 0, `violations: ${JSON.stringify(findFor('src/fixed2-real-column-ref.ts'))}`) &&
      ok;
    ok = assert('unrelated clean file has zero violations', findFor('src/clean.ts').length === 0, 'expected 0') && ok;
    ok =
      assert('sql.raw() with a non-template argument has zero violations', findFor('src/raw-clean.ts').length === 0, `violations: ${JSON.stringify(findFor('src/raw-clean.ts'))}`) &&
      ok;
    ok =
      assert(
        "a non-'sql' tagged template (e.g. postgres.js) is not scanned by rule 1",
        findFor('src/other-tag.ts').length === 0,
        `violations: ${JSON.stringify(findFor('src/other-tag.ts'))}`,
      ) && ok;
    ok =
      assert(
        "a local 'sql' shadowing drizzle's (e.g. neon(...)) is not scanned — file never imports sql from drizzle-orm",
        findFor('src/neon-shadow.ts').length === 0,
        `violations: ${JSON.stringify(findFor('src/neon-shadow.ts'))}`,
      ) && ok;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  if (!ok) {
    console.log('ERROR: self-test failed — the check no longer detects hand-built SQL defects correctly.');
    return 1;
  }
  console.log('lint-hand-built-sql self-test: OK (both historical defects caught, both fixed/clean forms pass)');
  return 0;
}

const arg = process.argv[2];
const root = process.env.ROOT ?? '.';
if (arg === '--self-test') {
  process.exit(selfTest(root));
} else {
  const { exitCode } = lint(root);
  process.exit(exitCode);
}
