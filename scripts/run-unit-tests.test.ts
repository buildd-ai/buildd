import { describe, expect, it } from 'bun:test';
import {
  extractFailureDigest,
  formatFailureSummary,
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

describe('extractFailureDigest', () => {
  it('pulls failing test names out of Bun output and drops timings', () => {
    const digest = extractFailureDigest('route.test.ts', [
      'bun test v1.3.10',
      '(pass) GET /api/secrets > lists secrets [1.20ms]',
      '(fail) POST /api/secrets > returns 401 when no auth [0.67ms]',
      '  expected 401, got 500',
      '(fail) POST /api/secrets > rejects duplicates [2.01ms]',
      '',
      ' 1 pass',
      ' 2 fail',
    ].join('\n'));

    expect(digest).toEqual({
      file: 'route.test.ts',
      failedTests: [
        'POST /api/secrets > returns 401 when no auth',
        'POST /api/secrets > rejects duplicates',
      ],
      truncatedTests: 0,
    });
  });

  it('caps the per-file test list and reports how many were dropped', () => {
    const lines = Array.from({ length: 9 }, (_, i) => `(fail) suite > case ${i} [1ms]`);
    const digest = extractFailureDigest('many.test.ts', lines.join('\n'));

    expect(digest.failedTests).toHaveLength(5);
    expect(digest.failedTests[0]).toBe('suite > case 0');
    expect(digest.truncatedTests).toBe(4);
  });

  it('falls back to the first error line when the file never loaded', () => {
    const digest = extractFailureDigest('crash.test.ts', [
      'bun test v1.3.10',
      '',
      "error: Cannot find module '@buildd/core/db' from 'packages/core/foo.ts'",
      'Bun v1.3.10 (macOS arm64)',
    ].join('\n'));

    expect(digest.failedTests).toEqual([]);
    expect(digest.reason).toBe("error: Cannot find module '@buildd/core/db' from 'packages/core/foo.ts'");
  });

  it('reports an unparseable failure rather than looking like a pass', () => {
    const digest = extractFailureDigest('silent.test.ts', 'no useful output here');

    expect(digest.failedTests).toEqual([]);
    expect(digest.reason).toBe('failed with no parseable test failures (see full log)');
  });
});

describe('formatFailureSummary', () => {
  it('lists failing files last so a tailed log still shows what broke', () => {
    const summary = formatFailureSummary(
      [
        { file: 'a.test.ts', failedTests: ['suite > one'], truncatedTests: 0 },
        { file: 'b.test.ts', failedTests: [], truncatedTests: 0, reason: 'error: boom' },
      ],
      218,
      '.test-report.log',
    );

    expect(summary).toContain('2 of 218 unit test files failed');
    expect(summary).toContain('a.test.ts');
    expect(summary).toContain('suite > one');
    expect(summary).toContain('b.test.ts');
    expect(summary).toContain('error: boom');
    expect(summary).toContain('.test-report.log');
  });

  it('states the truncation instead of silently listing fewer files', () => {
    const digests = Array.from({ length: 25 }, (_, i) => ({
      file: `f${i}.test.ts`,
      failedTests: ['suite > case'],
      truncatedTests: 0,
    }));

    const summary = formatFailureSummary(digests, 300, '.test-report.log');

    expect(summary).toContain('f19.test.ts');
    expect(summary).not.toContain('f20.test.ts');
    expect(summary).toContain('5 more failing files omitted');
  });

  it('shows dropped per-file tests', () => {
    const summary = formatFailureSummary(
      [{ file: 'a.test.ts', failedTests: ['suite > one'], truncatedTests: 4 }],
      10,
      '.test-report.log',
    );

    expect(summary).toContain('+4 more failing tests in this file');
  });
});
