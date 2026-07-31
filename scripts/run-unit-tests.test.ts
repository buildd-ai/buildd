import { describe, expect, it } from 'bun:test';
import {
  getTestConcurrency,
  isUnitTestFile,
  runTestFile,
  runWithConcurrency,
} from './run-unit-tests';

describe('isUnitTestFile', () => {
  it('includes the unit-suite roots and its own regression test', () => {
    expect(isUnitTestFile('apps/web/src/lib/team-access.test.ts')).toBe(true);
    expect(isUnitTestFile('apps/runner/__tests__/unit/workers.test.ts')).toBe(true);
    expect(isUnitTestFile('packages/core/__tests__/knowledge-store.test.ts')).toBe(true);
    expect(isUnitTestFile('scripts/run-unit-tests.test.ts')).toBe(true);
  });

  it('excludes integration and e2e tests', () => {
    expect(isUnitTestFile('apps/web/tests/integration/tasks.test.ts')).toBe(false);
    expect(isUnitTestFile('tests/e2e/dashboard.test.ts')).toBe(false);
  });
});

describe('getTestConcurrency', () => {
  it('uses a conservative default and caps configured parallelism', () => {
    expect(getTestConcurrency(undefined)).toBe(4);
    expect(getTestConcurrency('0')).toBe(1);
    expect(getTestConcurrency('not-a-number')).toBe(4);
    expect(getTestConcurrency('100')).toBe(16);
  });
});

describe('runWithConcurrency', () => {
  it('never runs more files than the configured concurrency', async () => {
    let active = 0;
    let maxActive = 0;
    const release: Array<() => void> = [];

    const work = runWithConcurrency(['a', 'b', 'c'], 2, async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>(resolve => release.push(resolve));
      active--;
    });

    await Bun.sleep(0);
    expect(maxActive).toBe(2);
    expect(release).toHaveLength(2);
    release.shift()?.();
    await Bun.sleep(0);
    expect(maxActive).toBe(2);
    expect(release).toHaveLength(2);
    release.splice(0).forEach(resolve => resolve());
    await work;
  });
});

describe('runTestFile', () => {
  it('preserves stdout and stderr from a failed child', async () => {
    const result = await runTestFile('example.test.ts', () => ({
      exited: Promise.resolve(1),
      stdout: new Response('assertion details\n').body!,
      stderr: new Response('stack trace\n').body!,
    }));

    expect(result).toEqual({
      file: 'example.test.ts',
      exitCode: 1,
      output: 'assertion details\nstack trace\n',
    });
  });

  it('uses the current Bun executable and converts launch errors into file failures', async () => {
    let command: string[] | undefined;
    const result = await runTestFile('example.test.ts', cmd => {
      command = cmd;
      throw new Error("ENOENT: posix_spawn 'bun'");
    });

    expect(command).toEqual([process.execPath, 'test', 'example.test.ts']);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Failed to launch Bun");
    expect(result.output).toContain("ENOENT: posix_spawn 'bun'");
  });
});
