/**
 * The failing tests of one CI job, read from its log (§6.10 signatures at test
 * level, `@buildd/workflow-kernel/trunk-signature`). Two failures of one
 * sharded job share its normalised name; only their tests say whether they
 * are the same failure.
 *
 * Recognised lines, after ANSI and Actions timestamps are stripped:
 *  - bun:         `(fail) suite > test [12.34ms]`
 *  - jest/vitest: `✕ test (12 ms)`, `× test 12ms`
 * Anything else is not a test line. A log with none of them is a job that
 * failed without failing a test (a lint, a type check, a gate).
 */
import { TEST_SEPARATOR, UNREAD_TESTS } from '@buildd/workflow-kernel/trunk-signature';

// Only what a test line needs: colours and the Actions timestamp prefix (the full cleaner,
// with redaction, is ci-failure-excerpts.ts, a module the kernel does not import).
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const LINE_PREFIX = /^\uFEFF?\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/;

const BUN_FAIL = /^\s*\(fail\)\s+(.+?)(?:\s+\[\d+(?:\.\d+)?\s*m?s\])?\s*$/;
const MARK_FAIL = /^\s*[✕×✗]\s+(.+?)(?:\s+\(?\d+(?:\.\d+)?\s*m?s\)?)?\s*$/;

export function failingTestsFromLog(raw: string): string[] {
  const out = new Set<string>();
  for (const rawLine of raw.split('\n')) {
    const line = rawLine.replace(/\r$/, '').replace(ANSI, '').replace(LINE_PREFIX, '');
    const m = line.match(BUN_FAIL) ?? line.match(MARK_FAIL);
    const name = m?.[1]?.trim();
    if (name) out.add(name);
  }
  return [...out].sort();
}

/**
 * One failing check's signature entries: one per failing test, the bare check
 * when its log was read and named no test, `<check>::?` when it was not read.
 */
export function failingEntries(check: string, tests: string[] | null): string[] {
  if (tests === null) return [`${check}${TEST_SEPARATOR}${UNREAD_TESTS}`];
  return tests.length ? tests.map((t) => `${check}${TEST_SEPARATOR}${t}`) : [check];
}
