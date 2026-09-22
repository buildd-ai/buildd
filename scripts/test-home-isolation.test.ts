import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { spawnSync } from 'child_process';

/**
 * No tracked test file may reach the operator's home directory.
 *
 * Why this gate exists: one test file computed its store path from the home
 * directory and called the real `saveWorker`/`loadAllWorkers`, so `bun run test`
 * wrote fixture records into the live runner store. There they were
 * indistinguishable from fleet data — they read back as `error`-status workers,
 * they skewed the status mix, and the running runner logged a bogus "not found
 * remotely" reconcile line for each of them. Analyses built on that store had
 * to be retracted. The suite was green throughout:
 * writing to the wrong place is not a test failure, which is exactly why it
 * needs a check on the checks.
 *
 * Every test process now gets its own `BUILDD_HOME` under `tmpdir()`
 * (`runTestFile` in `scripts/run-unit-tests.ts`), and that run also snapshots
 * the real store before and after. This file is the third layer: it stops the
 * pattern being reintroduced, by name, at review time.
 *
 * **Why `git ls-files` and not the filesystem** — the same reason
 * `skills-listed.test.ts` uses it: a checkout legitimately holds untracked
 * scratch files, and a gate that punished those would fail for one developer
 * and pass in CI. The claim being checked is about what the repo ships.
 *
 * Modelled on `collector-coverage.test.ts`: bidirectional (no unaccounted file,
 * and no dead allow-list entry) with a non-vacuous corpus assertion, because a
 * gate over an empty set reports the same "0 problems" as a healthy one.
 */

/**
 * Ways a test reaches the real home. Deliberately narrow — every entry here is
 * a value that resolves, at runtime, to a path outside the test's temp home.
 *
 * A bare `'~/.buildd'` string literal is NOT on this list: neither `path.join`
 * nor `fs` expands a tilde, so such a literal cannot reach the home directory.
 * Including it would force an allow-list entry for every test that asserts on a
 * path-predicate's *input* (the credential read-jail tests, for instance),
 * which would dilute the list until nobody reads it.
 */
const HOME_ESCAPES: RegExp[] = [
  /\bhomedir\s*\(/,
  /\bos\.homedir\b/,
  /\bprocess\.env\.HOME\b/,
  /\bprocess\.env\.USERPROFILE\b/,
];

/**
 * A readable name for a pattern, DERIVED from the pattern rather than written
 * out beside it.
 *
 * Not cosmetic: a literal label spelling the thing out (`what: 'homedir' + '()'`)
 * is itself a match, so the first version of this file flagged its own pattern
 * table. The escaped regex sources above do not match — `homedir` is followed by
 * a backslash, not by `(` — so deriving the label keeps the file clean by
 * construction instead of by an allow-list entry licensing the guard to break
 * its own rule.
 */
function label(re: RegExp): string {
  return re.source.replace(/\\b/g, '').replace(/\\s\*/g, '').replace(/\\/g, '');
}

/**
 * Tracked test files permitted to reference the real home, each with the reason
 * it is safe. "It only reads" is a reason; "it cleans up afterwards" is not —
 * the leak this gate exists for had a cleanup hook.
 */
const MAY_REFERENCE_THE_REAL_HOME: Array<[path: string, why: string]> = [
  [
    'apps/runner/__tests__/unit/read-jail.test.ts',
    'pure path-math: builds expected strings for the read-jail predicate, never touches the filesystem',
  ],
  [
    'apps/runner/__tests__/unit/workspace.test.ts',
    'asserts tilde expansion returns the home path; computes strings only, never writes',
  ],
  [
    'scripts/run-unit-tests.test.ts',
    'asserts the injected BUILDD_HOME is NOT the real store — it has to name the real store to do that; read-only',
  ],
  [
    'apps/runner/__tests__/unit/worker-store-integrity.test.ts',
    'readdir-only: asserts the real store is byte-identical before and after it saves into its own temp home; the regression test for this very gate',
  ],
];

function trackedTestFiles(): string[] {
  const ls = spawnSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return (ls.stdout ?? '')
    .split('\0')
    .filter(f => /\.test\.tsx?$/.test(f));
}

/**
 * Lines that are purely a comment are ignored: a doc comment explaining why a
 * path is denied is not a filesystem access, and flagging prose would push
 * people to delete the explanations rather than fix the code.
 */
function isCommentLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

type Hit = { file: string; line: number; what: string; text: string };

function homeEscapes(file: string): Hit[] {
  let body: string;
  try {
    body = readFileSync(file, 'utf8');
  } catch {
    return []; // tracked but not present in this checkout
  }
  const hits: Hit[] = [];
  body.split('\n').forEach((line, i) => {
    if (isCommentLine(line)) return;
    for (const re of HOME_ESCAPES) {
      if (re.test(line)) hits.push({ file, line: i + 1, what: label(re), text: line.trim() });
    }
  });
  return hits;
}

const allowed = new Set(MAY_REFERENCE_THE_REAL_HOME.map(([path]) => path));

describe('test-home isolation', () => {
  it('found a corpus of tracked test files to check', () => {
    // Guard the guard: an empty corpus would make everything below vacuously true.
    expect(trackedTestFiles().length).toBeGreaterThan(400);
  });

  it('detects a home reference at all', () => {
    // If the patterns matched nothing anywhere, the gate would pass by being
    // blind rather than by the corpus being clean.
    const detected = MAY_REFERENCE_THE_REAL_HOME
      .map(([path]) => path)
      .filter(path => homeEscapes(path).length > 0);
    expect(detected.length).toBeGreaterThan(0);
  });

  it('no test file outside the allow-list reaches the real home directory', () => {
    const offenders = trackedTestFiles()
      .filter(f => !allowed.has(f))
      .flatMap(f => homeEscapes(f))
      .map(h => `${h.file}:${h.line}  ${h.what}  ${h.text}`);
    expect(offenders).toEqual([]);
  });

  it('every allow-list entry is still a tracked test file', () => {
    const tracked = new Set(trackedTestFiles());
    const missing = MAY_REFERENCE_THE_REAL_HOME
      .filter(([path]) => !tracked.has(path))
      .map(([path, why]) => `${path} (claimed: ${why})`);
    expect(missing).toEqual([]);
  });

  it('every allow-list entry still references the real home', () => {
    // The other direction: an entry whose file has since been fixed is a
    // standing licence nobody needs, and it makes the list look longer than the
    // problem is.
    const dead = MAY_REFERENCE_THE_REAL_HOME
      .filter(([path]) => homeEscapes(path).length === 0)
      .map(([path, why]) => `${path} (claimed: ${why})`);
    expect(dead).toEqual([]);
  });

  it('does not trip its own rule', () => {
    // Pins the property the derived labels above exist for. A guard that has to
    // allow-list itself has already conceded the rule it enforces.
    expect(homeEscapes('scripts/test-home-isolation.test.ts')).toEqual([]);
    expect(allowed.has('scripts/test-home-isolation.test.ts')).toBe(false);
  });

  it('derives a label that its own pattern matches', () => {
    // Round-trip property instead of expected literals: spelling the labels out
    // here would put four fresh matches in this very file. If the unescaping in
    // `label` ever drifts, the pattern stops matching its own name and this
    // fails -- without the test needing to name any of them.
    for (const re of HOME_ESCAPES) {
      expect(re.test(label(re))).toBe(true);
      expect(label(re)).not.toContain('\\');
    }
  });

  it('gives every allow-list entry a stated reason', () => {
    const unexplained = MAY_REFERENCE_THE_REAL_HOME
      .filter(([, why]) => why.trim().length < 20)
      .map(([path]) => path);
    expect(unexplained).toEqual([]);
  });
});
