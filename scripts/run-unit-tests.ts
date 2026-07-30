const UNIT_TEST_ROOTS = [
  'apps/web/src/',
  'apps/runner/__tests__/unit/',
  'packages/core/',
  'scripts/run-unit-tests.test.ts',
] as const;

export function isUnitTestFile(path: string): boolean {
  return (
    UNIT_TEST_ROOTS.some(root => path.startsWith(root)) &&
    (path.endsWith('.test.ts') || path.endsWith('.test.tsx'))
  );
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

async function main(): Promise<void> {
  const files = await discoverUnitTests();
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
    process.stdout.write(`\rUnit test files: ${passed} passed, ${failures.length} failed, ${files.length - passed - failures.length} remaining`);
  });
  process.stdout.write('\n');

  for (const failure of failures) {
    console.error(`\n--- ${failure.file} ---\n${failure.output.trim()}`);
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} of ${files.length} unit test files failed.`);
    process.exitCode = 1;
  } else {
    console.log(`All ${files.length} unit test files passed in isolated processes.`);
  }
}

if (import.meta.main) {
  await main();
}
