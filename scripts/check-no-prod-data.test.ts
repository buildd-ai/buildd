/**
 * Tests for the public-repo data check (scripts/check-no-prod-data.ts).
 *
 * Every MUST_PASS case below is a real false positive the first version of this
 * check produced, taken from a sweep of this repo's own commit history. Every
 * MUST_FAIL case is a disclosure shape that first version let straight through.
 * Both lists are the point of the file: the check was simultaneously too loud on
 * measurements and too quiet on the counts that actually matter.
 *
 * Ported case for case from the Python self-test this check started as, so
 * no-prod-data.yml runs it with Bun before the check it guards.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import {
  ALLOW_RE,
  COUNT_BIG,
  COUNT_SMALL_IN_CONTEXT,
  COUNT_TENANCY,
  diffAddedLines,
  hasProdContext,
  mask,
  pyRegex,
  pySplitlines,
  Report,
  UUID_RE,
} from './check-no-prod-data';

const SCRIPT = resolve(import.meta.dir, 'check-no-prod-data.ts');

function flags(line: string): boolean {
  const big = COUNT_BIG.test(line);
  const tenancy = COUNT_TENANCY.test(line);
  const small = COUNT_SMALL_IN_CONTEXT.test(line) && hasProdContext(line);
  return big || tenancy || small || UUID_RE.test(line);
}

const MUST_PASS = [
  // Measurements and limits — ordinary engineering prose.
  'chore: bump bundle budget to 1,024 KB',
  'fix: retry backoff now 2,000 ms instead of 30s',
  'docs: Postgres text limit is 1,073,741,824 bytes',
  'fix: handle HTTP 429 with Retry-After 3,600',
  'feat: cap Pusher payloads at 10,240 bytes',
  'test: benchmark over 10,000 iterations',
  'fix: correct currency formatting for $1,499 plans',
  'feat: paginate at 1,000 items per page',
  // Third-party public stats — a recurring commit genre in this repo.
  'docs: SDK scan — 82K+ stars, 10,913+ repos indexed',
  'docs: research scan — 43K stars, 9,600+ forks',
  'docs: Anthropic launch supports up to 1,000 parallel calls',
  // Our own repo's code-graph size is not customer data.
  'perf(cbm): index 63,861 nodes and 77,831 edges',
  // Ordinary text with no figures.
  'refactor: split the helper and tidy the imports',
  'fix: guard against a null workspace repo',
  'test: 517/517 unit test files pass',
  // Squash subjects always end in a PR reference — 162 FPs on real history.
  'fix(runner): isolate the per-worker daemon (#1964)',
  'fix(workers): write effectiveCost back to workers.costUsd (#1973)',
  'fix(budget-forecast): include null-workspace team missions (#1971)',
  'feat(missions): mission Structure tab (#1968)',
  // Zero-padded migration indices are identifiers, not counts.
  'Step D merged its own 0223 into the mission branch.',
  'fix: renumber 0224 workspaces migration',
  // Configuration limits and fixtures, not populations.
  'feat: cap at 60 workers per workspace',
  'test: scenario seeds 12 tasks and asserts ordering',
  'perf: keep just the last 100 calls per worker',
  'fix: rows use */30 in the cron expression',
  // `live` as a mode/identifier name in a code span is not prod context.
  "feat: seed 75 rows when `mode: 'live'` is selected",
  'fix: the `live` flag now covers 120 rows of fixtures',
  // Python's \w is Unicode: a figure glued to a non-ASCII letter is part of a
  // word there, so it is not a count. JS's ASCII \w would say otherwise.
  'é1234 rows',
];

const MUST_FAIL = [
  // Population counts — the thing that actually discloses.
  'prod has 487 teams and 62 workspaces', // sub-1000: missed before
  'migrated 3521 records from the old service', // noun 'records': missed before
  '12000 tasks in the queue backlog', // noun 'tasks': missed before
  'fix: verified 3,521/3,521 rows byte-identical', // the original leak shape
  'chore: 25 api keys minted across 9 teams', // tenancy
  'docs: 15k users affected by the outage', // k suffix: missed before
  'note: rows=4231 in the memories table', // noun before number
  'prod currently has 900 seats across all customers', // noun then number
  'seeded 1500 users in the load fixture',
  // Outside backticks 'live' still marks a production sentence, and a code
  // span does not excuse any other production word.
  'the live table has 75 rows',
  'the `prod` table has 75 rows',
  '`live` and the live table has 75 rows',
  // Row identifiers.
  'fix: scope to team d2cb1c29-3f92-4ea1-ba0c-fe8b41ccf3b5',
  'fix: worker D2CB1C29-3F92-4EA1-BA0C-FE8B41CCF3B5 stalled', // uppercase
];

describe('population count and UUID rules', () => {
  for (const line of MUST_PASS) test(`passes: ${line}`, () => expect(flags(line)).toBe(false));
  for (const line of MUST_FAIL) test(`flags: ${line}`, () => expect(flags(line)).toBe(true));
});

// The escape hatch must be usable without being triggerable by mention. An
// unanchored pattern matched its own documentation and disabled the check on the
// PR that introduced it.
describe('escape hatch', () => {
  const MUST_NOT_TRIGGER = [
    '- **`no-prod-data: allow <reason>` escape hatch.**',
    'documented at `no-prod-data: allow` in CLAUDE.md',
    'we could add a no-prod-data: allow marker later',
  ];
  const MUST_TRIGGER = ['no-prod-data: allow documenting the pattern itself', '  no-prod-data: allow third-party star counts'];
  for (const line of MUST_NOT_TRIGGER) test(`mention: ${line}`, () => expect(ALLOW_RE.test(line)).toBe(false));
  for (const line of MUST_TRIGGER) test(`use: ${line}`, () => expect(ALLOW_RE.test(line)).toBe(true));

  test('honoured on a later line of the body, as re.M does', () => {
    expect(ALLOW_RE.exec('intro\nno-prod-data: allow reason\nmore')?.[1]).toBe('reason');
  });
});

test('masking never leaks digits or hex', () => {
  expect(mask('3,521 rows and d2cb1c29-3f92-4ea1-ba0c-fe8b41ccf3b5')).not.toMatch(/[0-9a-f]/i);
});

// ── Guard-integrity cases ───────────────────────────────────────────────────
//
// These are not pattern tuning. They cover the ways this check could be
// *present and green while doing nothing*, which is the failure mode it actually
// hit: NO_PROD_DATA_IDENTIFIERS was never set on this repo, so from the day the
// check shipped until it was noticed, the identifier half — the only half that
// reads added code — ran on every PR and scanned nothing, warning into a log
// nobody reads and exiting 0.
describe('guard integrity', () => {
  let tmp: string;
  let empty: string;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'npd-guard-'));
    empty = join(tmp, 'empty.txt');
    writeFileSync(empty, '');
  });
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  /** Run the checker end to end, so the exit code is the thing under test. */
  function runMain(env: Record<string, string>, title = empty) {
    const r = spawnSync(process.execPath, [SCRIPT, 'HEAD', '--body', empty, '--title', title], {
      cwd: tmp,
      encoding: 'utf8',
      env: { ...process.env, NO_PROD_DATA_LOCAL: '', ...env },
    });
    return { status: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
  }

  // 1. An absent identifier list must FAIL. Skipping half the check and
  //    exiting 0 makes every PR green over an empty set. CI never sets
  //    NO_PROD_DATA_LOCAL, so this is also the regression guard on CI staying
  //    fail-closed now that local mode exists.
  test('unset identifiers fail closed', () => {
    expect(runMain({ NO_PROD_DATA_IDENTIFIERS: '' }).status).not.toBe(0);
  });

  // 2. With a list present the checker must run and say so, not fail open.
  test('set identifiers pass a clean tree', () => {
    const r = runMain({ NO_PROD_DATA_IDENTIFIERS: String.raw`\bzzzunlikelyhandle\b` });
    expect(r.status).toBe(0);
    expect(r.out).toContain('no-prod-data: clean');
  });

  // 3a. NO_PROD_DATA_LOCAL is the one exception to rule 1: a workstation never
  //     has the secret, so failing closed there trains people to ignore the
  //     check. It must downgrade the missing-secret case to a warning on an
  //     otherwise-clean tree...
  test('local mode warns, and says it skipped, over a missing secret', () => {
    const r = runMain({ NO_PROD_DATA_IDENTIFIERS: '', NO_PROD_DATA_LOCAL: '1' });
    expect(r.status).toBe(0);
    expect(r.out.toLowerCase()).toContain('skipped');
  });

  // 3b. ...but must NOT paper over a real finding. The count/UUID rules need
  //     no secret, so local mode has no excuse to go quiet on those.
  test('local mode still fails a real UUID finding', () => {
    const title = join(tmp, 'title.txt');
    writeFileSync(title, 'fix: scope to team d2cb1c29-3f92-4ea1-ba0c-fe8b41ccf3b5\n');
    const r = runMain({ NO_PROD_DATA_IDENTIFIERS: '', NO_PROD_DATA_LOCAL: '1' }, title);
    expect(r.status).toBe(1);
    expect(r.out).toContain('PR title: possible UUID at line 1');
    expect(r.out).not.toContain('d2cb1c29');
  });

  // 4. An identifier finding must never echo the match. mask() only redacts
  //    [0-9a-f], so a name made of other letters survives it almost intact —
  //    and Actions logs on a public repo are world-readable, so printing the
  //    excerpt republishes the private name the check exists to catch.
  test('an identifier finding never echoes the match', () => {
    const secret = 'some-private-repo-name';
    const lines: string[] = [];
    new Report((l) => lines.push(l)).hitIdentifier('added code', 7, `const repo = '${secret}';`);
    const out = lines.join('\n');
    for (const fragment of [secret, 'private-repo', 'some-private']) expect(out).not.toContain(fragment);
  });

  // 5. An identifier list that does not compile must fail without printing it.
  //    A JS SyntaxError quotes the whole pattern, and a translated pattern is
  //    no longer the exact string Actions masks.
  test('an invalid identifier list fails without echoing it', () => {
    const r = runMain({ NO_PROD_DATA_IDENTIFIERS: '(zzzunclosedhandle' });
    expect(r.status).toBe(2);
    expect(r.out).not.toContain('zzzunclosedhandle');
  });

  test('an identifier in the title is reported without the excerpt', () => {
    const title = join(tmp, 'ident-title.txt');
    writeFileSync(title, 'chore: mention zzzunlikelyhandle here\n');
    const r = runMain({ NO_PROD_DATA_IDENTIFIERS: String.raw`\bzzzunlikelyhandle\b` }, title);
    expect(r.status).toBe(1);
    expect(r.out).toContain('PR title: possible personal handle or private repo name at line 1');
    expect(r.out).not.toContain('zzzunlikelyhandle here');
  });

  test('no arguments is a usage error', () => {
    const r = spawnSync(process.execPath, [SCRIPT], { cwd: tmp, encoding: 'utf8' });
    expect(r.status).toBe(2);
  });
});

// ── Added-source UUID scan ────────────────────────────────────────────────────
// This half did not exist until a real workspace id sat in a committed .ts file
// for months: UUIDs were checked in the PR *description* and never in the change.
// Both directions matter — catching the source case is the point, and ignoring
// test fixtures is what keeps it switched on.
describe('added-source UUID scan', () => {
  const diffFor = (path: string, body: string, newStart = 1) =>
    `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -${newStart},1 +${newStart},1 @@\n+${body}\n`;
  const real = 'bf442fcb-6179-43b3-aa92-2564b1ad24b8';

  test('a UUID added to a source file is seen, with its path', () => {
    const got = diffAddedLines(diffFor('packages/core/scripts/seed.ts', `const WS = '${real}';`), { excludeTests: true });
    expect(got.some(([, , l]) => UUID_RE.test(l))).toBe(true);
    // The path must travel with the line, or the finding cannot name a file.
    expect(got[0]![0]).toBe('packages/core/scripts/seed.ts');
  });

  // Every real-looking UUID in the tree lives under a test path, so scanning
  // them would fire on dozens of existing files and the check would be disabled
  // within a week.
  for (const p of ['apps/web/src/lib/task-id.test.ts', 'packages/core/__tests__/foo.ts', 'tests/e2e/flow.test.ts']) {
    test(`test fixture not scanned: ${p}`, () => {
      expect(diffAddedLines(diffFor(p, `const id = '${real}';`), { excludeTests: true })).toEqual([]);
    });
  }

  test('a deletion does not count — removing a UUID is the fix', () => {
    const d = diffFor('packages/core/scripts/seed.ts', 'ok').replace('+ok', `-const WS = '${real}';`);
    expect(diffAddedLines(d, { excludeTests: true }).some(([, , l]) => UUID_RE.test(l))).toBe(false);
  });
});

// ── Line-number accuracy ─────────────────────────────────────────────────────
// A real bug, not a hypothetical: the reported line number used to be an index
// into the filtered `+`-only lines, which only equals the real file line when a
// diff is a single hunk starting at line 1. Any other shape pointed the
// reported line at the wrong place, which is exactly the shape a real PR's diff
// has.
describe('line-number accuracy', () => {
  const real = 'bf442fcb-6179-43b3-aa92-2564b1ad24b8';
  const head = 'diff --git a/packages/core/scripts/seed.ts b/packages/core/scripts/seed.ts\n--- a/packages/core/scripts/seed.ts\n+++ b/packages/core/scripts/seed.ts\n';
  const uuidLines = (diff: string) =>
    diffAddedLines(diff, { excludeTests: true })
      .filter(([, , l]) => UUID_RE.test(l))
      .map(([, n]) => n)
      .sort((a, b) => a - b);

  test('a hunk starting mid-file counts its context lines', () => {
    expect(uuidLines(`${head}@@ -48,2 +48,3 @@\n const untouched = 1;\n+const WS = '${real}';\n const alsoUntouched = 2;\n`)).toEqual([49]);
  });

  test('a second hunk resumes from its own header', () => {
    expect(uuidLines(`${head}@@ -5,1 +5,1 @@\n+const A = '${real}';\n@@ -200,1 +201,1 @@\n+const B = '${real}';\n`)).toEqual([5, 201]);
  });
});

// ── Python `re` semantics ────────────────────────────────────────────────────
// The patterns, and the identifier list from the secret, were written for
// Python's `re`. pyRegex compiles them to a JS RegExp that means the same thing.
describe('pyRegex', () => {
  test('a leading inline flag group applies to the whole pattern', () => {
    expect(pyRegex('(?i)abc').test('ABC')).toBe(true);
  });
  test('named groups and named backreferences', () => {
    const rx = pyRegex('(?P<w>ab)-(?P=w)');
    expect(rx.test('ab-ab')).toBe(true);
    expect(rx.test('ab-cd')).toBe(false);
  });
  test('\\A and \\Z anchor the whole input', () => {
    expect(pyRegex(String.raw`\Aab\Z`).test('ab')).toBe(true);
    expect(pyRegex(String.raw`ab\Z`).test('ab\n')).toBe(false);
  });
  test('$ without re.M also matches before a trailing newline', () => {
    expect(pyRegex('ab$').test('ab\n')).toBe(true);
    expect(pyRegex('ab$').test('ab\nc')).toBe(false);
  });
  test('re.M ^ and $ split on \\n only, not \\r', () => {
    expect(pyRegex('^b$', 'm').test('a\nb\nc')).toBe(true);
    expect(pyRegex('^b', 'm').test('a\rb')).toBe(false);
  });
  test('. does not cross \\n but does cross \\r', () => {
    expect(pyRegex('a.b').test('a\rb')).toBe(true);
    expect(pyRegex('a.b').test('a\nb')).toBe(false);
  });
  test('re.VERBOSE drops whitespace and comments outside classes', () => {
    expect(pyRegex('(?x) a b  # comment\n [ ]c').test('ab c')).toBe(true);
  });
  test('a literal brace that is not a quantifier', () => {
    expect(pyRegex('a{b}').test('a{b}')).toBe(true);
    expect(pyRegex('a{,2}b').test('aab')).toBe(true);
  });
  test('a ] outside a class, or [ inside one, is literal', () => {
    expect(pyRegex('[[]x]').test('[x]')).toBe(true);
    expect(pyRegex('[]a]').test(']')).toBe(true);
  });
  test('an ERE alternation with word boundaries', () => {
    const rx = pyRegex(String.raw`\bfoo\b|bar-baz`, 'i');
    expect(rx.test('a FOO here')).toBe(true);
    expect(rx.test('foobar')).toBe(false);
    expect(rx.test('x bar-baz')).toBe(true);
  });
  test('\\w and \\b are Unicode-aware', () => {
    expect(pyRegex(String.raw`\bx\b`).test('éxé')).toBe(false);
    expect(pyRegex(String.raw`^\w+$`).test('naïve')).toBe(true);
  });
  test('an invalid pattern throws', () => {
    expect(() => pyRegex('(a')).toThrow();
  });
});

test('pySplitlines matches str.splitlines()', () => {
  expect(pySplitlines('')).toEqual([]);
  expect(pySplitlines('a\n')).toEqual(['a']);
  expect(pySplitlines('\n')).toEqual(['']);
  expect(pySplitlines('a\r\nb\rc\x0cd\u2028e')).toEqual(['a', 'b', 'c', 'd', 'e']);
});
