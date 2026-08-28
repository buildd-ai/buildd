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
  const files = selectTestFiles(Bun.argv.slice(2), await discoverUnitTests());
  if (files.length === 0) {
    console.log('No unit test files selected.');
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
}

if (import.meta.main) {
  await main();
}
