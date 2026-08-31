import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import { isUnitTestFile } from './run-unit-tests';

/**
 * Every tracked test file must be either collected by the unit runner or listed
 * below as a deliberate exclusion.
 *
 * This exists because the collector has silently dropped whole directories more
 * than once, and a dropped file looks exactly like a passing one:
 *   - `apps/runner/src/*.test.ts` (3 files) matched no root, so they never ran in
 *     CI, and one of them had been failing on macOS unnoticed.
 *   - `apps/runner/__tests__/standalone/*.test.ts` (4 files, 35 tests) matched no
 *     root AND no package script AND no workflow — nothing ran them at all.
 *   - `apps/runner/src/__tests__/mount-isolation.e2e.ts`, the only test that
 *     proves the sandbox denies a path, is `.e2e.ts` and so was uncollectable by
 *     construction; it now has its own CI job.
 *
 * A file appearing here is a claim that something ELSE runs it. Name what.
 */
const DELIBERATELY_NOT_IN_THE_UNIT_SUITE: Array<[pattern: RegExp, runBy: string]> = [
  [/^apps\/web\/tests\/integration\//, 'bun run test:integration (needs a live server + API key)'],
  [/^apps\/runner\/__tests__\/integration/, 'bun run test:integration (spawns real sessions)'],
  [/^tests\/e2e\//, 'bun run test:e2e (needs BUILDD_TEST_SERVER)'],
];

function trackedTestFiles(): string[] {
  const ls = spawnSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return (ls.stdout ?? '')
    .split('\0')
    .filter(f => /\.test\.tsx?$/.test(f));
}

describe('unit-test collector coverage', () => {
  test('every tracked test file is collected or explicitly excluded', () => {
    const files = trackedTestFiles();
    // Guard the guard: an empty corpus would make this vacuously true.
    expect(files.length).toBeGreaterThan(400);

    const unaccounted = files.filter(
      f => !isUnitTestFile(f) && !DELIBERATELY_NOT_IN_THE_UNIT_SUITE.some(([re]) => re.test(f)),
    );
    expect(unaccounted).toEqual([]);
  });

  test('every exclusion pattern still matches something', () => {
    const files = trackedTestFiles();
    const dead = DELIBERATELY_NOT_IN_THE_UNIT_SUITE
      .filter(([re]) => !files.some(f => re.test(f)))
      .map(([re, runBy]) => `${re} (claimed: ${runBy})`);
    expect(dead).toEqual([]);
  });

  test('an excluded file is not silently also collected', () => {
    // If a path matches both, the exclusion comment is a lie about where it runs.
    const files = trackedTestFiles();
    const both = files.filter(
      f => isUnitTestFile(f) && DELIBERATELY_NOT_IN_THE_UNIT_SUITE.some(([re]) => re.test(f)),
    );
    expect(both).toEqual([]);
  });
});
