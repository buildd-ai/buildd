import { describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import {
  diffStoreSnapshots,
  discoverHiddenDirTests,
  formatHiddenDirTestReport,
  formatStoreTripwireReport,
  hiddenDirSegment,
  realWorkerStoreDir,
  selectTestFiles,
  extractFailureDigest,
  formatFailureSummary,
  getTestConcurrency,
  isUnitTestFile,
  runTestFile,
  runWithConcurrency,
  snapshotStore,
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

describe('selectTestFiles', () => {
  const discovered = [
    'apps/web/src/lib/a.test.ts',
    'apps/web/src/lib/b.test.ts',
    'packages/core/__tests__/c.test.ts',
  ];

  it('falls back to discovery when no files are named', () => {
    expect(selectTestFiles([], discovered)).toEqual(discovered);
  });

  it('uses the explicitly named files, sorted', () => {
    expect(selectTestFiles(['apps/web/src/lib/b.test.ts', 'apps/web/src/lib/a.test.ts'], discovered))
      .toEqual(['apps/web/src/lib/a.test.ts', 'apps/web/src/lib/b.test.ts']);
  });

  it('drops named paths that are not unit tests', () => {
    // CI passes affected-tests.sh output straight through; an integration or e2e
    // path in that list must not be pulled into the unit run.
    expect(selectTestFiles(
      ['apps/web/src/lib/a.test.ts', 'tests/e2e/dashboard.test.ts', 'apps/web/tests/integration/x.test.ts'],
      discovered,
    )).toEqual(['apps/web/src/lib/a.test.ts']);
  });

  it('deduplicates repeated paths', () => {
    expect(selectTestFiles(['apps/web/src/lib/a.test.ts', 'apps/web/src/lib/a.test.ts'], discovered))
      .toEqual(['apps/web/src/lib/a.test.ts']);
  });

  it('ignores the ALL and SKIP sentinels affected-tests.sh emits', () => {
    expect(selectTestFiles(['ALL'], discovered)).toEqual(discovered);
    expect(selectTestFiles(['SKIP'], discovered)).toEqual([]);
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

/**
 * Seven runner modules resolve BUILDD_HOME when they are first imported
 * (worker-store, history-store, session-logger, outbox, doctor, updater,
 * index), so a test that sets it in a `beforeAll` is already too late. Injecting it here --
 * the single place that spawns every test process -- is the only point that
 * covers all of them regardless of when they read it. Without it the suite
 * wrote fixture records into the operator's real ~/.buildd/workers, where they
 * were counted as fleet data.
 */
describe('runTestFile BUILDD_HOME isolation', () => {
  function capturedEnv(file: string): Record<string, string | undefined> {
    let env: Record<string, string | undefined> = {};
    void runTestFile(file, (_cmd, options) => {
      env = (options.env ?? {}) as Record<string, string | undefined>;
      return {
        exited: Promise.resolve(0),
        stdout: new Response('').body!,
        stderr: new Response('').body!,
      };
    });
    return env;
  }

  it('gives the child a BUILDD_HOME under tmpdir(), never the real store', () => {
    const env = capturedEnv('example.test.ts');
    expect(env.BUILDD_HOME).toBeTruthy();
    expect(env.BUILDD_HOME!.startsWith(tmpdir())).toBe(true);
    expect(env.BUILDD_HOME).not.toBe(join(homedir(), '.buildd'));
    expect(realWorkerStoreDir().startsWith(env.BUILDD_HOME!)).toBe(false);
  });

  it('gives two files two different homes', () => {
    // A shared home would let one file's leftovers satisfy another's assertion.
    const a = capturedEnv('a.test.ts').BUILDD_HOME;
    const b = capturedEnv('b.test.ts').BUILDD_HOME;
    expect(a).not.toBe(b);
  });

  it('still passes the rest of the parent environment through', () => {
    const env = capturedEnv('example.test.ts');
    expect(env.PATH).toBe(process.env.PATH);
  });

  it('removes the temp home after the child exits', async () => {
    let home: string | undefined;
    await runTestFile('example.test.ts', (_cmd, options) => {
      home = (options.env as Record<string, string>).BUILDD_HOME;
      return {
        exited: Promise.resolve(0),
        stdout: new Response('').body!,
        stderr: new Response('').body!,
      };
    });
    expect(home).toBeTruthy();
    expect(existsSync(home!)).toBe(false);
  });

  it('cleans up even when the spawn throws', async () => {
    let home: string | undefined;
    await runTestFile('example.test.ts', (_cmd, options) => {
      home = (options.env as Record<string, string>).BUILDD_HOME;
      throw new Error("ENOENT: posix_spawn 'bun'");
    });
    expect(home).toBeTruthy();
    expect(existsSync(home!)).toBe(false);
  });
});

/**
 * The layer that would actually have caught the leak: snapshot the real worker
 * store before the first spawn and after the last one, and fail the run on any
 * difference. Works on CI (directory absent, snapshot null) and on a developer
 * or runner host (directory present and full of real records).
 */
describe('real-worker-store tripwire', () => {
  let dir: string;

  function makeDir(): string {
    return mkdtempSync(join(tmpdir(), 'buildd-tripwire-'));
  }

  it('snapshots a missing directory as null', () => {
    expect(snapshotStore(join(tmpdir(), 'buildd-tripwire-does-not-exist'))).toBeNull();
  });

  it('reports no difference when nothing changed', () => {
    dir = makeDir();
    try {
      writeFileSync(join(dir, 'a.json'), '{"a":1}');
      const before = snapshotStore(dir);
      expect(diffStoreSnapshots(before, snapshotStore(dir))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports an added file', () => {
    dir = makeDir();
    try {
      const before = snapshotStore(dir);
      writeFileSync(join(dir, 'leaked.json'), '{"a":1}');
      const diffs = diffStoreSnapshots(before, snapshotStore(dir));
      expect(diffs).toHaveLength(1);
      expect(diffs[0]).toContain('leaked.json');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports a removed file and a rewritten one', () => {
    dir = makeDir();
    try {
      writeFileSync(join(dir, 'kept.json'), '{"a":1}');
      writeFileSync(join(dir, 'reaped.json'), '{"a":1}');
      const before = snapshotStore(dir);
      rmSync(join(dir, 'reaped.json'));
      writeFileSync(join(dir, 'kept.json'), '{"a":1,"b":2}');
      const diffs = diffStoreSnapshots(before, snapshotStore(dir));
      expect(diffs.some(d => d.includes('reaped.json'))).toBe(true);
      expect(diffs.some(d => d.includes('kept.json'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('treats the suite creating the directory as the failure', () => {
    // A missing store must snapshot null and STAY null. The suite calling
    // mkdirSync on it is exactly the leak, not a clean slate.
    const missing = join(tmpdir(), 'buildd-tripwire-created');
    rmSync(missing, { recursive: true, force: true });
    try {
      const before = snapshotStore(missing);
      expect(before).toBeNull();
      mkdirSync(missing, { recursive: true });
      writeFileSync(join(missing, 'fixture.json'), '{}');
      const diffs = diffStoreSnapshots(before, snapshotStore(missing));
      expect(diffs.length).toBeGreaterThan(0);
      expect(diffs.join('\n')).toContain('fixture.json');
    } finally {
      rmSync(missing, { recursive: true, force: true });
    }
  });

  it('names the offending entries in the failure text', () => {
    const report = formatStoreTripwireReport('/some/store', ['added: leaked.json']);
    expect(report).toContain('/some/store');
    expect(report).toContain('leaked.json');
  });

  it('watches the store the runner actually uses', () => {
    expect(realWorkerStoreDir()).toBe(join(homedir(), '.buildd', 'workers'));
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

describe('hidden dot-directory tests', () => {
  it('names the dot directory that hides a test file', () => {
    expect(hiddenDirSegment('apps/web/src/app/api/.well-known/jwks.json/route.test.ts')).toBe('.well-known');
    expect(hiddenDirSegment('apps/web/src/lib/team-access.test.ts')).toBeNull();
    // A dotted *filename* is visible to the scan — only directories hide a file.
    expect(hiddenDirSegment('apps/web/src/lib/.eslintrc.test.ts')).toBeNull();
  });

  it('finds dot-directory tests that the ordinary scan cannot see', async () => {
    // Pins the Bun.Glob behaviour the guard exists for: without `dot: true` the
    // ordinary `**/*.test.ts` pattern returns ZERO matches under a dot directory,
    // so the file is never collected and the run still reports green.
    const base = mkdtempSync(join(tmpdir(), 'buildd-hidden-'));
    try {
      mkdirSync(join(base, 'pkg/src/.well-known/jwks.json'), { recursive: true });
      writeFileSync(join(base, 'pkg/src/.well-known/jwks.json/route.test.ts'), '');
      writeFileSync(join(base, 'pkg/src/visible.test.ts'), '');

      const ordinary: string[] = [];
      for await (const path of new Bun.Glob('**/*.test.{ts,tsx}').scan({ cwd: base, onlyFiles: true })) {
        ordinary.push(path);
      }
      expect(ordinary).toEqual(['pkg/src/visible.test.ts']);

      expect(await discoverHiddenDirTests(['pkg/'], base)).toEqual([
        'pkg/src/.well-known/jwks.json/route.test.ts',
      ]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('reports the offending file loudly enough to act on', () => {
    const report = formatHiddenDirTestReport([
      'apps/web/src/app/api/.well-known/jwks.json/route.test.ts',
    ]);

    expect(report).toContain('INVISIBLE');
    expect(report).toContain('::error file=apps/web/src/app/api/.well-known/jwks.json/route.test.ts::');
    expect(report).toContain('.well-known');
    expect(report).toContain('Move each file to a non-dot directory');
  });
});
