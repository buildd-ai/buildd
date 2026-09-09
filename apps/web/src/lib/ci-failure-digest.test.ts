import { describe, it, expect } from 'bun:test';
import { extractFailureDigest, DIGEST_MAX_CHARS } from './ci-failure-digest';

/**
 * A CI-retry task used to carry job and step names only — "Job build failed:
 * Step Run tests failed" — and then instruct the agent to run
 * `gh run view <id> --log-failed`, which returns empty output and exit 0. So a
 * cold-start retry knew a step failed and had no working way to learn which
 * test. These fixtures are the shapes the runner actually emits.
 */

const UNIT_TEST_FAILURE = `
2026-09-07T06:17:05.5590006Z (pass) PATCH /api/workers/[id] > budget exhaustion > defers [0.48ms]
712 expect() calls
Ran 216 tests across 1 file. [332.00ms]

1 of 1 unit test files failed:

apps/web/src/app/api/workers/[id]/route.test.ts
  x PATCH /api/workers/[id] > reviewer outcome handling > approve: resolves the policy
  x PATCH /api/workers/[id] > reviewer outcome handling > approve: resolves the policy

Full output: .test-report.log
Do not re-run the suite to see more -- grep the log
2026-09-07T06:17:06.1000000Z ##[error]Process completed with exit code 1.
2026-09-07T06:17:06.2000000Z Post job cleanup.
2026-09-07T06:17:06.3000000Z [command]/usr/bin/git version
`.trim();

// Actions prefixes EVERY line with a timestamp, including its annotations —
// which is why the timestamp strip has to run before the ^##[error] match.
const ANNOTATION_ONLY_FAILURE = `
2026-09-05T14:01:52.1000000Z Run python3 scripts/check_no_prod_data.py
2026-09-05T14:01:52.2000000Z ##[error]PR body: possible UUID at line 21 — row identifiers must not enter a public repo
2026-09-05T14:01:52.3000000Z ##[error]Process completed with exit code 1.
2026-09-05T14:01:52.4000000Z Post job cleanup.
`.trim();

const TYPE_ERROR_FAILURE = `
2026-09-06T10:00:00.1000000Z $ cd apps/web && bunx tsc --noEmit
2026-09-06T10:00:00.2000000Z apps/web/src/lib/foo.ts(42,7): error TS2322: Type 'string' is not assignable to type 'number'.
2026-09-06T10:00:00.3000000Z ##[error]Process completed with exit code 2.
`.trim();

describe('extractFailureDigest', () => {
  it('pulls the unit-test digest, naming the file and the failing tests', () => {
    const d = extractFailureDigest(UNIT_TEST_FAILURE)!;
    expect(d).toContain('apps/web/src/app/api/workers/[id]/route.test.ts');
    expect(d).toContain('reviewer outcome handling');
    expect(d).toContain('1 of 1 unit test files failed');
  });

  it('starts at the digest marker, excluding the per-test output above it', () => {
    const d = extractFailureDigest(UNIT_TEST_FAILURE)!;
    expect(d).not.toContain('(pass)');
    expect(d).not.toContain('budget exhaustion');
    expect(d.startsWith('1 of 1 unit test files failed:')).toBe(true);
  });

  it('prefers the test digest over annotations when the log has both', () => {
    // A failing unit-test job emits its own ##[error] as well. The digest names
    // the tests; the annotation names the step. Reversing that precedence loses
    // the only part a retry agent can act on.
    const withBoth = UNIT_TEST_FAILURE.replace(
      'Full output: .test-report.log',
      '2026-09-07T06:17:05.9Z ##[error]The process bun exited with code 1.\nFull output: .test-report.log',
    );
    const d = extractFailureDigest(withBoth)!;
    expect(d).toContain('route.test.ts');
    expect(d.startsWith('1 of 1 unit test files failed:')).toBe(true);
  });

  it('does not carry the post-job cleanup tail', () => {
    // Everything after the digest is runner bookkeeping. Shipping it burns the
    // retry agent's context on `git config` lines.
    const d = extractFailureDigest(UNIT_TEST_FAILURE)!;
    expect(d).not.toContain('Post job cleanup');
    expect(d).not.toContain('/usr/bin/git');
  });

  it('falls back to ::error annotations when there is no test digest', () => {
    const d = extractFailureDigest(ANNOTATION_ONLY_FAILURE)!;
    expect(d).toContain('possible UUID at line 21');
  });

  it('drops the bare exit-code annotation, which says nothing', () => {
    const d = extractFailureDigest(ANNOTATION_ONLY_FAILURE)!;
    expect(d).not.toContain('Process completed with exit code');
  });

  it('surfaces a tsc error line', () => {
    const d = extractFailureDigest(TYPE_ERROR_FAILURE)!;
    expect(d).toContain('TS2322');
  });

  it('returns null on a log with nothing diagnostic in it', () => {
    expect(extractFailureDigest('Run actions/checkout@v7\nPost job cleanup.\n')).toBeNull();
  });

  it('returns null on empty input rather than an empty string', () => {
    expect(extractFailureDigest('')).toBeNull();
    expect(extractFailureDigest('   \n  ')).toBeNull();
  });

  it('caps its output — a task description is not a log viewer', () => {
    const huge = '1 of 900 unit test files failed:\n\n'
      + Array.from({ length: 5000 }, (_, i) => `  x suite > case number ${i}`).join('\n')
      + '\n\nFull output: .test-report.log';
    const d = extractFailureDigest(huge)!;
    expect(d.length).toBeLessThanOrEqual(DIGEST_MAX_CHARS);
    // Truncation must be visible, or the reader trusts a partial list as whole.
    expect(d).toContain('truncated');
  });

  it('strips ISO timestamp prefixes the Actions log adds to every line', () => {
    const d = extractFailureDigest(UNIT_TEST_FAILURE)!;
    expect(d).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});
