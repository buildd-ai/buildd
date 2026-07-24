const UNIT_TEST_ROOTS = [
  'apps/web/src/',
  'apps/runner/__tests__/unit/',
  'packages/core/',
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

async function runTestFile(file: string): Promise<TestResult> {
  const child = Bun.spawn(['bun', 'test', file], {
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
}

async function main(): Promise<void> {
  const files = await discoverUnitTests();
  const concurrency = Math.max(1, Number(process.env.BUILDD_TEST_CONCURRENCY) || 8);
  const failures: TestResult[] = [];
  let next = 0;
  let passed = 0;

  async function worker(): Promise<void> {
    while (next < files.length) {
      const file = files[next++];
      const result = await runTestFile(file);
      if (result.exitCode === 0) {
        passed++;
      } else {
        failures.push(result);
      }
      process.stdout.write(`\rUnit test files: ${passed} passed, ${failures.length} failed, ${files.length - passed - failures.length} remaining`);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, () => worker()));
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
