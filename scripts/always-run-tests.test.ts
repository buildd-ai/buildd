import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { isUnitTestFile } from './run-unit-tests';

/**
 * `scripts/affected-tests.sh` selects tests by mapping a changed source file to
 * the test file NEXT TO IT. A handful of tests are not about the file next to
 * them at all — their input is `git ls-files`, i.e. the whole repository — so
 * the change that breaks one of them can never select it.
 *
 * That is not hypothetical. Over one recent week, 11 of 16 unit-test CI
 * failures were a single test — `scripts/cron-instrumentation.test.ts` — firing
 * on a branch that added a cron route. It ran only because some *other* part of
 * the diff (a `packages/core/` touch, or >20 files) tripped the `ALL` fan-out.
 * Every one of those was discoverable before the push.
 *
 * So: repo-wide invariant tests are listed in `scripts/always-run-tests.txt`
 * and appended to every non-`ALL` selection. This file guards the list in both
 * directions — a new `git ls-files` test cannot be added without registering
 * it, and a registered entry cannot rot.
 */
const MANIFEST = 'scripts/always-run-tests.txt';

function manifestEntries(): string[] {
  return readFileSync(MANIFEST, 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'));
}

function trackedTestFiles(): string[] {
  const ls = spawnSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return (ls.stdout ?? '')
    .split('\0')
    .filter(f => f.endsWith('.test.ts') || f.endsWith('.test.tsx'));
}

/**
 * The defining property of a repo-wide invariant test: it enumerates the
 * repository itself rather than importing the module beside it. `git ls-files`
 * is how all of them do it, and it is a cheap, honest proxy — a test that grows
 * that call becomes registerable the moment it is written.
 */
function isRepoWideInvariantTest(file: string): boolean {
  const src = readFileSync(file, 'utf8');
  return src.includes("'ls-files'") || src.includes('"ls-files"') || src.includes('git ls-files');
}

function runAffected(changed: string[]): string {
  const out = spawnSync('bash', ['scripts/affected-tests.sh'], {
    encoding: 'utf8',
    env: { ...process.env, AFFECTED_TESTS_CHANGED: changed.join('\n'), GITHUB_BASE_REF: '', GITHUB_EVENT_NAME: '' },
  });
  // The script logs reasoning to stderr; the selection is the last stdout line.
  return (out.stdout ?? '').trim().split('\n').at(-1) ?? '';
}

describe('always-run test manifest', () => {
  test('every listed entry exists, is tracked, and is collectable as a unit test', () => {
    const tracked = new Set(trackedTestFiles());
    for (const entry of manifestEntries()) {
      expect(existsSync(entry), `${entry} is listed but not on disk`).toBe(true);
      expect(tracked.has(entry), `${entry} is listed but not git-tracked`).toBe(true);
      // A listed file that run-unit-tests.ts refuses to collect is a no-op gate.
      expect(isUnitTestFile(entry), `${entry} is listed but isUnitTestFile() rejects it`).toBe(true);
    }
  });

  test('lists every repo-wide invariant test in the repo', () => {
    const listed = new Set(manifestEntries());
    const missing = trackedTestFiles()
      .filter(f => existsSync(f))
      .filter(isRepoWideInvariantTest)
      .filter(f => !listed.has(f));
    expect(
      missing,
      `these tests enumerate the repo via git ls-files, so no diff can select them. `
        + `Add them to ${MANIFEST}:\n  ${missing.join('\n  ')}`,
    ).toEqual([]);
  });
});

describe('affected-tests.sh honours the manifest', () => {
  test('a new cron route selects the cron instrumentation invariant', () => {
    const selection = runAffected(['apps/web/src/app/api/cron/some-new-sweep/route.ts']);
    expect(selection).not.toBe('SKIP');
    expect(selection.split(/\s+/)).toContain('scripts/cron-instrumentation.test.ts');
  });

  test('a change with no colocated test still runs the invariants instead of SKIP', () => {
    // CLAUDE.md has no colocated test, but skills-listed.test.ts asserts against it.
    const selection = runAffected(['CLAUDE.md']);
    expect(selection).not.toBe('SKIP');
    for (const entry of manifestEntries()) {
      expect(selection.split(/\s+/)).toContain(entry);
    }
  });

  test('a colocated selection keeps its own tests AND gains the invariants', () => {
    const selection = runAffected(['apps/web/src/lib/reviewer.ts']).split(/\s+/);
    expect(selection).toContain('apps/web/src/lib/reviewer.test.ts');
    expect(selection).toContain('scripts/cron-instrumentation.test.ts');
  });

  test('ALL still short-circuits — the manifest must not turn a full run into a list', () => {
    const many = Array.from({ length: 25 }, (_, i) => `apps/web/src/lib/f${i}.ts`);
    expect(runAffected(many)).toBe('ALL');
  });

  test('an empty diff is still SKIP — no changes means nothing to guard', () => {
    expect(runAffected([])).toBe('SKIP');
  });
});
