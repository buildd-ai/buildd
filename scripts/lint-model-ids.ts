#!/usr/bin/env bun
/**
 * Fail if model-ID literals (claude-opus-5, gpt-5-codex, …) appear outside the
 * allowlist. Run in CI after checkout to stop new hardcoded model IDs creeping
 * in: everything else must route through the tier system (premium / standard /
 * budget), so a model change is a registry row and not a deploy.
 *
 * This is a real tokenizer, not a line-based grep: it walks each file
 * character by character tracking whether it is inside a line comment, a
 * block comment, a string, or a template literal (including a `${...}`
 * interpolation, which is code again). Comment text is blanked out before
 * matching; string and template-literal text is left intact and IS matched,
 * including a `//` or `/*` sequence that appears inside a string — those are
 * data, not comment syntax, and must not suppress a real violation later on
 * the same line (see the self-test's `urlThenViolation` fixture).
 *
 * Decision: a model id inside a comment — including one that reads like
 * commented-out code, e.g. `// model: 'claude-opus-5'` — is NOT flagged. It
 * cannot execute, cannot retarget a tier, and cannot go stale in any way this
 * check exists to prevent. This is a deliberate choice, not an oversight.
 *
 * History (C30): the allowlist once carried the bare prefix `apps/web/src/app`,
 * which excluded the ENTIRE Next.js app tree — every route, page and
 * component — and left only apps/runner, packages/* and apps/web/src/lib
 * policed. The pattern also missed `gpt-5*`, `gpt-4.1` and bare `gpt-4`. The
 * gate passed because it was measuring almost nothing. Every entry below is
 * file-specific and carries the reason it is allowed; the run prints what it
 * measured so a future coverage collapse is visible instead of silent.
 *
 * History (2026-09): rewritten from a `grep`-based line scan (which matched
 * inside comments and JSDoc — a model id in prose was flagged the same as one
 * in a string) to this tokenizer, after it broke CI on a JSDoc sentence
 * naming a model id. Comments stopped being scanned; strings and template
 * literals — the actual risk — still are.
 *
 * Usage:
 *   bun run scripts/lint-model-ids.ts              # lint the repo
 *   bun run scripts/lint-model-ids.ts --self-test  # prove the check can fail
 */

import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';

// File-specific allowlist. Directories are NOT allowed here — a directory
// entry is how this gate lost its coverage (see C30 above). Each entry
// states why.
const ALLOWLIST: string[] = [
  'packages/core/model-aliases.ts', // the alias table: model IDs are its content
  'packages/core/model-prices.ts', // price book keyed by model ID
  'packages/core/model-tier-registry.ts', // tier → model resolution
  'packages/core/model-tier-defaults.ts', // code-level fallback tiers
  'packages/core/model-tier-liveness.ts', // audits tier IDs; the IDs in its docstrings ARE the spec of the parser
  'packages/core/model-display.ts', // humanises model IDs; the IDs in its docstrings ARE the spec of the parser
  'packages/core/model-catalog.ts', // normalises vendor model IDs; every hit is prose in a docstring, the code itself contains no ID literal
  'packages/core/mcp-tools.ts', // help/param documentation strings only
  'apps/runner/src/index.ts', // runner UI model dropdown
  'apps/runner/src/backends/codex-backend.ts', // brokers OpenAI/codex model IDs for the SDK
  'apps/web/src/lib/config-helpers.ts', // mission-config UI dropdown options
  'apps/web/src/app/api/models/route.ts', // filters legacy generations out of the live catalog
  'packages/core/model-capability-requirements.ts', // min-CLI-version floor per model: a registry keyed by model ID
  'scripts/lint-model-ids.ts', // this file: self-test fixtures deliberately contain literal model IDs to exercise the matcher
];

// claude-<family>-<n>, claude-<n>, any gpt-<n> (covers gpt-4, gpt-4o, gpt-4.1,
// gpt-5, gpt-5-codex, gpt-3.5), and the o-series reasoning models.
const PATTERN = /claude-(haiku|sonnet|opus|fable|mythos)-[0-9]|claude-[0-9]|gpt-[0-9]|o[0-9]-(mini|preview)/;

// Excluded from the scan, deliberately and visibly (counts are printed):
//   - build output and vendored code
//   - tests: fixtures and assertions legitimately name concrete model IDs
const EXCLUDE_DIRS = new Set(['node_modules', '.next', 'dist', '.git']);
const TEST_FILE_RE = /__tests__|\.test\.|\.spec\./;
const SOURCE_FILE_RE = /\.tsx?$/;

interface Match {
  file: string; // repo-relative, no leading ./
  line: number;
  text: string;
}

/**
 * Blank out comment text (line comments, block comments, JSDoc) while
 * leaving code, string literals, and template literals — including their
 * `${...}` interpolations — untouched. Newlines are always preserved so line
 * numbers of the result line up with the source.
 */
function maskComments(src: string): string {
  const out: string[] = [];
  // Stack of open template-literal `${...}` interpolation frames, each
  // tracking its own brace depth so a nested object literal's `}` doesn't
  // get mistaken for the end of the interpolation.
  const templateExprDepths: number[] = [];
  type Mode = 'code' | 'linecomment' | 'blockcomment' | 'sq' | 'dq' | 'template';
  let mode: Mode = 'code';

  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const next = i + 1 < n ? src[i + 1] : '';

    if (mode === 'linecomment') {
      out.push(c === '\n' ? '\n' : ' ');
      if (c === '\n') mode = 'code';
      i++;
      continue;
    }

    if (mode === 'blockcomment') {
      if (c === '*' && next === '/') {
        out.push('  ');
        i += 2;
        mode = 'code';
        continue;
      }
      out.push(c === '\n' ? '\n' : ' ');
      i++;
      continue;
    }

    if (mode === 'sq' || mode === 'dq') {
      out.push(c);
      if (c === '\\' && i + 1 < n) {
        out.push(src[i + 1]);
        i += 2;
        continue;
      }
      if ((mode === 'sq' && c === "'") || (mode === 'dq' && c === '"')) mode = 'code';
      i++;
      continue;
    }

    if (mode === 'template') {
      out.push(c);
      if (c === '\\' && i + 1 < n) {
        out.push(src[i + 1]);
        i += 2;
        continue;
      }
      if (c === '`') {
        mode = 'code';
        i++;
        continue;
      }
      if (c === '$' && next === '{') {
        out.push('{');
        templateExprDepths.push(0);
        mode = 'code';
        i += 2;
        continue;
      }
      i++;
      continue;
    }

    // mode === 'code' (also covers a template-literal `${...}` interpolation)
    if (c === '/' && next === '/') {
      out.push('  ');
      i += 2;
      mode = 'linecomment';
      continue;
    }
    if (c === '/' && next === '*') {
      out.push('  ');
      i += 2;
      mode = 'blockcomment';
      continue;
    }
    if (c === "'") {
      out.push(c);
      mode = 'sq';
      i++;
      continue;
    }
    if (c === '"') {
      out.push(c);
      mode = 'dq';
      i++;
      continue;
    }
    if (c === '`') {
      out.push(c);
      mode = 'template';
      i++;
      continue;
    }
    if (templateExprDepths.length > 0) {
      if (c === '{') {
        templateExprDepths[templateExprDepths.length - 1]++;
      } else if (c === '}') {
        const depth = templateExprDepths[templateExprDepths.length - 1];
        if (depth === 0) {
          templateExprDepths.pop();
          out.push(c);
          mode = 'template';
          i++;
          continue;
        }
        templateExprDepths[templateExprDepths.length - 1] = depth - 1;
      }
    }
    out.push(c);
    i++;
  }

  return out.join('');
}

function scanFile(absPath: string, repoRoot: string): Match[] {
  const content = readFileSync(absPath, 'utf8');
  const masked = maskComments(content);
  const lines = masked.split('\n');
  const relPath = relative(repoRoot, absPath).split('\\').join('/');
  const matches: Match[] = [];
  for (let idx = 0; idx < lines.length; idx++) {
    if (PATTERN.test(lines[idx])) {
      matches.push({ file: relPath, line: idx + 1, text: lines[idx].trim() });
    }
  }
  return matches;
}

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
    if (entry.endsWith('/')) {
      console.log(`ERROR: allowlist entry '${entry}' is a directory; only file paths are allowed.`);
      return { exitCode: 1 };
    }
    if (!/\.tsx?$/.test(entry)) {
      console.log(`ERROR: allowlist entry '${entry}' is not a .ts/.tsx file; directory prefixes silence whole trees.`);
      return { exitCode: 1 };
    }
  }

  const files = walk(root);
  let scanned = 0;
  let testHits = 0;
  let allowedHits = 0;
  const violations: Match[] = [];

  for (const absPath of files) {
    scanned++;
    const relPath = relative(root, absPath).split('\\').join('/');
    const matches = scanFile(absPath, root);
    if (matches.length === 0) continue;

    if (TEST_FILE_RE.test(relPath)) {
      testHits += matches.length;
      continue;
    }
    if (isAllowlisted(relPath)) {
      allowedHits += matches.length;
      continue;
    }
    violations.push(...matches);
  }

  const total = violations.length + allowedHits;
  console.log(
    `lint-model-ids: scanned ${scanned} source file(s); ${total} non-test match(es); ` +
      `${allowedHits} allowlisted; ${testHits} test-file match(es) excluded; ${violations.length} violation(s)`
  );

  if (violations.length > 0) {
    console.log('ERROR: hardcoded model IDs found outside the allowlist:');
    for (const v of violations) {
      console.log(`${v.file}:${v.line}: ${v.text}`);
    }
    console.log('');
    console.log("Use tier ('premium'/'standard'/'budget') in create_task, or add a");
    console.log('FILE-SPECIFIC allowlist entry to scripts/lint-model-ids.ts with a comment');
    console.log('explaining why that file legitimately names a model ID.');
    return { exitCode: 1 };
  }

  console.log('lint-model-ids: OK');
  return { exitCode: 0 };
}

function assert(name: string, condition: boolean, detail: string): boolean {
  console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${name}${condition ? '' : ` — ${detail}`}`);
  return condition;
}

function selfTest(): number {
  const tmp = mkdtempSync(join(tmpdir(), 'lint-model-ids-'));
  let ok = true;
  try {
    mkdirSync(join(tmp, 'src'), { recursive: true });

    const fixtures: Record<string, string> = {
      'src/canary-string.ts': `export const M = "claude-opus-5";\n`,
      'src/canary-gpt.tsx': `export const G = 'gpt-5-codex';\n`,
      'src/clean.ts': `export const OK = "premium";\n`,
      'src/line-comment.ts': `// mentions claude-opus-5 in prose\nexport const OK = 1;\n`,
      'src/block-comment.ts': `/* claude-opus-5 */\nexport const OK = 1;\n`,
      'src/block-comment-multiline.ts': `/*\n * claude-opus-5\n */\nexport const OK = 1;\n`,
      'src/jsdoc-2416.ts':
        "/**\n * CLI predated `claude-fable-5-1`'s floor and nothing checked at claim time.\n */\nexport const OK = 1;\n",
      'src/single-quote-string.ts': `export const M = 'claude-opus-5';\n`,
      'src/double-quote-string.ts': `export const M = "claude-opus-5";\n`,
      'src/template-literal.ts': 'export const M = `claude-opus-5`;\n',
      'src/template-literal-multiline.ts': 'export const M = `\n  claude-opus-5\n`;\n',
      'src/url-then-violation.ts':
        'export const U = "https://api.example.com"; export const M = "claude-opus-5";\n',
      'src/slashes-in-string-then-violation.ts':
        'export const U = "http://x//y"; export const M = "claude-opus-5";\n',
    };
    for (const [path, contents] of Object.entries(fixtures)) {
      writeFileSync(join(tmp, path), contents);
    }

    const files = walk(tmp);
    const matchesFor = (relName: string) => {
      const abs = files.find((f) => f.endsWith(relName));
      if (!abs) return [];
      return scanFile(abs, tmp);
    };

    ok = assert('canary string literal flags', matchesFor('canary-string.ts').length === 1, 'expected 1 match') && ok;
    ok = assert('canary gpt literal flags', matchesFor('canary-gpt.tsx').length === 1, 'expected 1 match') && ok;
    ok = assert('clean file has no matches', matchesFor('clean.ts').length === 0, 'expected 0 matches') && ok;
    ok = assert('line comment does NOT flag', matchesFor('line-comment.ts').length === 0, 'expected 0 matches') && ok;
    ok =
      assert('block comment does NOT flag', matchesFor('block-comment.ts').length === 0, 'expected 0 matches') && ok;
    ok =
      assert(
        'multi-line block comment does NOT flag',
        matchesFor('block-comment-multiline.ts').length === 0,
        'expected 0 matches'
      ) && ok;
    ok =
      assert(
        'JSDoc (#2416 line) does NOT flag',
        matchesFor('jsdoc-2416.ts').length === 0,
        'expected 0 matches'
      ) && ok;
    ok =
      assert(
        'single-quote string literal flags',
        matchesFor('single-quote-string.ts').length === 1,
        'expected 1 match'
      ) && ok;
    ok =
      assert(
        'double-quote string literal flags',
        matchesFor('double-quote-string.ts').length === 1,
        'expected 1 match'
      ) && ok;
    ok =
      assert('template literal flags', matchesFor('template-literal.ts').length === 1, 'expected 1 match') && ok;
    ok =
      assert(
        'multi-line template literal flags',
        matchesFor('template-literal-multiline.ts').length === 1,
        'expected 1 match'
      ) && ok;
    ok =
      assert(
        "URL '//' followed by a real violation on the same line still flags",
        matchesFor('url-then-violation.ts').length === 1,
        'expected 1 match'
      ) && ok;
    ok =
      assert(
        "'//' inside a string followed by a real violation still flags",
        matchesFor('slashes-in-string-then-violation.ts').length === 1,
        'expected 1 match'
      ) && ok;

    // Allowlist filtering: same content, one path allowlisted, one not.
    ok =
      assert(
        'allowlisted file with a real literal is excluded from violations',
        isAllowlisted('packages/core/model-prices.ts'),
        'expected packages/core/model-prices.ts to be allowlisted'
      ) && ok;
    ok =
      assert(
        'non-allowlisted file with the same literal is NOT excluded',
        !isAllowlisted('packages/core/some-other-file.ts'),
        'expected an arbitrary path to not be allowlisted'
      ) && ok;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  if (!ok) {
    console.log('ERROR: self-test failed — the check no longer detects hardcoded model IDs correctly.');
    return 1;
  }
  console.log('lint-model-ids self-test: OK (the check can fail, and comments are correctly ignored)');
  return 0;
}

const arg = process.argv[2];
if (arg === '--self-test') {
  process.exit(selfTest());
} else {
  const root = process.env.ROOT ?? '.';
  const { exitCode } = lint(root);
  process.exit(exitCode);
}
