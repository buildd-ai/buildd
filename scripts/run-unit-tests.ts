const UNIT_TEST_ROOTS = [
  'apps/web/src/',
  'apps/runner/__tests__/unit/',
  'packages/core/',
  'scripts/run-unit-tests.test.ts',
  'scripts/sync-crons.test.ts',
  'scripts/cron-coverage.test.ts',
] as const;

export function isUnitTestFile(path: string): boolean {
  return (
    UNIT_TEST_ROOTS.some(root => path.startsWith(root)) &&
    (path.endsWith('.test.ts') || path.endsWith('.test.tsx'))
  );
}

/**
 * Sentinels emitted by scripts/affected-tests.sh instead of a file list.
 * ALL  → the change is broad enough to warrant the whole suite.
 * SKIP → nothing testable changed.
 */
const ALL_SENTINEL = 'ALL';
const SKIP_SENTINEL = 'SKIP';

/**
 * Resolves the files to run: an explicit list when CI names one, otherwise
 * everything discovered.
 *
 * Non-unit paths are dropped rather than trusted — CI pipes
 * affected-tests.sh output straight in, and an integration or e2e path in that
 * list would be run here without its live server or env file.
 */
export function selectTestFiles(named: readonly string[], discovered: readonly string[]): string[] {
  if (named.includes(SKIP_SENTINEL)) return [];
  const explicit = named.filter(arg => arg !== ALL_SENTINEL);
  if (explicit.length === 0) return [...discovered];
  return [...new Set(explicit.filter(isUnitTestFile))].sort();
}

async function discoverUnitTests(): Promise<string[]> {
  const files: string[] = [];
  for await (const path of new Bun.Glob('**/*.test.{ts,tsx}').scan({ cwd: '.', onlyFiles: true })) {
    if (isUnitTestFile(path)) files.push(path);
  }
  return files.sort();
}

/**
 * Directory roots (as opposed to the individually-named script test files) that
 * get the hidden-directory sweep below.
 */
const UNIT_TEST_DIR_ROOTS = UNIT_TEST_ROOTS.filter(root => root.endsWith('/'));

/**
 * The first dot-prefixed *directory* segment in a path, or null.
 * A dotfile name (`.eslintrc.test.ts`) is fine — only directories hide a file
 * from the scan, so the final segment is never considered.
 */
export function hiddenDirSegment(path: string): string | null {
  return path.split('/').slice(0, -1).find(segment => segment.startsWith('.')) ?? null;
}

/**
 * Find test files that live under a dot directory.
 *
 * `Bun.Glob` does not descend into dot directories unless `dot: true`, so the
 * discovery scan above returns ZERO matches for e.g.
 * `apps/web/src/app/api/.well-known/**\/*.test.ts`. Nothing rejects such a file —
 * it is simply never collected, which is indistinguishable from a green run.
 * (That is why the JWKS route's test sits one directory above the route.)
 *
 * The sweep is a second, narrow scan: only the unit-test roots, only paths that
 * contain a dot directory. Measured at ~10ms against this repo versus ~400ms for
 * turning `dot: true` on for the whole-repo discovery scan, and it cannot pick up
 * `node_modules/.bun` or a `.claude/worktrees/<name>/apps/...` sibling checkout,
 * neither of which is under a unit-test root.
 */
export async function discoverHiddenDirTests(
  roots: readonly string[] = UNIT_TEST_DIR_ROOTS,
  cwd = '.',
): Promise<string[]> {
  const found = new Set<string>();
  for (const root of roots) {
    const glob = new Bun.Glob(`${root}**/.*/**/*.test.{ts,tsx}`);
    for await (const path of glob.scan({ cwd, onlyFiles: true, dot: true })) {
      found.add(path);
    }
  }
  return [...found].sort();
}

/**
 * Loud, actionable failure text. The scan cannot run these files where they are,
 * so the only fix is to move them out of the dot directory.
 */
export function formatHiddenDirTestReport(files: readonly string[]): string {
  const out: string[] = [
    '',
    `${files.length} test file(s) live under a dot directory and are INVISIBLE to the unit-test scan:`,
    '',
  ];
  for (const file of files) {
    out.push(`::error file=${file}::Test file under dot directory "${hiddenDirSegment(file)}/" — Bun.Glob never collects it, so it silently never runs. Move the test out of the dot directory (e.g. one level up, importing the route under test) or the suite reports green while asserting nothing.`);
    out.push(`  ${file}   (hidden by "${hiddenDirSegment(file)}/")`);
  }
  out.push(
    '',
    'Bun.Glob skips dot directories, so these paths return zero matches from',
    "scripts/run-unit-tests.ts instead of failing — a silent gap, not a skip.",
    'Move each file to a non-dot directory and import the code under test.',
    '',
  );
  return out.join('\n');
}

type TestResult = {
  file: string;
  exitCode: number;
  output: string;
};

const DEFAULT_CONCURRENCY = 4;
const MAX_CONCURRENCY = 16;

export function getTestConcurrency(configured: string | undefined): number {
  if (configured === undefined || Number.isNaN(Number(configured))) {
    return DEFAULT_CONCURRENCY;
  }
  return Math.min(MAX_CONCURRENCY, Math.max(1, Math.floor(Number(configured))));
}

export async function runWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  run: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;

  async function worker(): Promise<void> {
    while (next < items.length) {
      await run(items[next++]);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );
}

type SpawnTestProcess = (
  command: string[],
  options: Bun.SpawnOptions.OptionsObject<'ignore', 'pipe', 'pipe'>,
) => {
  exited: Promise<number>;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
};

export async function runTestFile(
  file: string,
  spawn: SpawnTestProcess = (command, options) => Bun.spawn(command, options),
): Promise<TestResult> {
  try {
    const child = spawn([process.execPath, 'test', file], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: process.env,
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { file, exitCode, output: `${stdout}${stderr}` };
  } catch (error) {
    const detail = error instanceof Error ? error.stack ?? error.message : String(error);
    return {
      file,
      exitCode: 1,
      output: `Failed to launch Bun for ${file}:\n${detail}`,
    };
  }
}

export type FailureDigest = {
  file: string;
  failedTests: string[];
  truncatedTests: number;
  reason?: string;
};

const MAX_TESTS_PER_FILE = 5;
const MAX_FILES_IN_SUMMARY = 20;

/**
 * Reduce a failed file's raw Bun output to the few lines an agent needs to act,
 * so the digest stays readable when a tail-piped log truncates everything else.
 */
export function extractFailureDigest(file: string, output: string): FailureDigest {
  const lines = output.split('\n');
  const failedTests: string[] = [];

  for (const line of lines) {
    const match = line.match(/^\s*\(fail\)\s+(.*?)(?:\s+\[[\d.]+m?s\])?\s*$/);
    if (match) failedTests.push(match[1]);
  }

  if (failedTests.length > 0) {
    return {
      file,
      failedTests: failedTests.slice(0, MAX_TESTS_PER_FILE),
      truncatedTests: Math.max(0, failedTests.length - MAX_TESTS_PER_FILE),
    };
  }

  // No `(fail)` lines means the file never loaded (import crash, syntax error).
  const errorLine = lines
    .map(line => line.trim())
    .find(line => /^(error|SyntaxError|TypeError|ReferenceError)\b/i.test(line));

  return {
    file,
    failedTests: [],
    truncatedTests: 0,
    reason: errorLine ?? 'failed with no parseable test failures (see full log)',
  };
}

export function formatFailureSummary(
  digests: readonly FailureDigest[],
  totalFiles: number,
  logPath: string,
): string {
  const shown = digests.slice(0, MAX_FILES_IN_SUMMARY);
  const omitted = digests.length - shown.length;
  const out: string[] = ['', `${digests.length} of ${totalFiles} unit test files failed:`, ''];

  for (const digest of shown) {
    out.push(digest.file);
    for (const test of digest.failedTests) out.push(`  x ${test}`);
    if (digest.truncatedTests > 0) {
      out.push(`  ... +${digest.truncatedTests} more failing tests in this file`);
    }
    if (digest.reason) out.push(`  ${digest.reason}`);
    out.push('');
  }

  if (omitted > 0) out.push(`... ${omitted} more failing files omitted from this summary`, '');

  out.push(
    `Full output: ${logPath}`,
    `Do not re-run the suite to see more -- grep the log:  grep -A30 -F '${shown[0]?.file ?? '<file>'}' ${logPath}`,
  );

  return out.join('\n');
}

async function main(): Promise<void> {
  // Every file runs in its OWN process. That is load-bearing, not an
  // optimisation: `mock.module` replaces a module globally for the life of a
  // process and is never undone, so a single-process run lets one file's stub
  // delete another file's imports. Which file breaks then depends on load
  // order, which is why single-process runs report a rotating set of failures
  // that all pass individually. Keep CI pointed at this script.
  // Runs on every invocation, including CI's named-file runs: a test parked under
  // a dot directory is never collected by any code path, so this is the only place
  // the gap can be reported at all. Printed at the END of the run (like the failure
  // digest) because that is what agents and CI log tails actually read.
  const hiddenDirTests = await discoverHiddenDirTests();
  const reportHiddenDirTests = (): void => {
    if (hiddenDirTests.length === 0) return;
    console.error(formatHiddenDirTestReport(hiddenDirTests));
    process.exitCode = 1;
  };

  const files = selectTestFiles(Bun.argv.slice(2), await discoverUnitTests());
  if (files.length === 0) {
    console.log('No unit test files selected.');
    reportHiddenDirTests();
    return;
  }
  const concurrency = getTestConcurrency(process.env.BUILDD_TEST_CONCURRENCY);
  const failures: TestResult[] = [];
  let passed = 0;

  await runWithConcurrency(files, concurrency, async file => {
    const result = await runTestFile(file);
    if (result.exitCode === 0) {
      passed++;
    } else {
      failures.push(result);
    }
    // Carriage-return progress is unreadable once redirected to a file, and the
    // log is what agents grep. Only animate on a TTY.
    if (process.stdout.isTTY) {
      process.stdout.write(`\rUnit test files: ${passed} passed, ${failures.length} failed, ${files.length - passed - failures.length} remaining`);
    }
  });
  if (process.stdout.isTTY) process.stdout.write('\n');

  // Files finish out of order under concurrency; sort so the log and digest are
  // byte-stable across runs.
  failures.sort((a, b) => a.file.localeCompare(b.file));

  const logPath = process.env.BUILDD_TEST_LOG ?? '.test-report.log';
  const report = failures
    .map(failure => `--- ${failure.file} ---\n${failure.output.trim()}\n`)
    .join('\n');
  await Bun.write(logPath, report || `All ${files.length} unit test files passed.\n`);

  // Full detail first, digest last: agents tail this output, so the actionable
  // summary has to be the final thing printed.
  for (const failure of failures) {
    console.error(`\n--- ${failure.file} ---\n${failure.output.trim()}`);
  }

  if (failures.length > 0) {
    const digests = failures.map(failure => extractFailureDigest(failure.file, failure.output));
    console.error(formatFailureSummary(digests, files.length, logPath));
    process.exitCode = 1;
  } else {
    console.log(`All ${files.length} unit test files passed in isolated processes.`);
  }
  reportHiddenDirTests();
}

if (import.meta.main) {
  await main();
}
