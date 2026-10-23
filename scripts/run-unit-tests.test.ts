import { describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import {
  attributeStoreReaches,
  storeGuardPath,
  getFileWallTimeoutMs,
  getTestTimeoutMs,
  STORE_REACH_MARKER,
  diffStoreSnapshots,
  discoverHiddenDirTests,
  formatHiddenDirTestReport,
  formatStoreTripwireReport,
  hiddenDirSegment,
  isStoreLikelyLive,
  realWorkerStoreDir,
  selectTestFiles,
  extractFailureDigest,
  formatFailureSummary,
  getTestConcurrency,
  isUnitTestFile,
  runTestFile,
  runWithConcurrency,
  admissionLimit,
  waitForHostRoom,
  startGateWaitMs,
  snapshotStore,
  storeDiffIsFatal,
  DURATION_HINT_MIN_MS,
  DURATIONS_PATH,
  UPDATE_DURATIONS_FLAG,
  formatDurationHintsFile,
  formatDurations,
  formatHeartbeat,
  summarizeHostBusy,
  mergeDurationHints,
  orderByDuration,
  parseRunnerArgs,
  readDurationHints,
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

  it('treats a directory argument as a prefix over discovered files', () => {
    // packages/ai-kit's `test` script passes `packages/ai-kit/`. That used to be
    // dropped as "not a unit test file" and the run selected nothing, green.
    expect(selectTestFiles(['apps/web/src/'], discovered))
      .toEqual(['apps/web/src/lib/a.test.ts', 'apps/web/src/lib/b.test.ts']);
    expect(selectTestFiles(['packages/core'], discovered)).toEqual(['packages/core/__tests__/c.test.ts']);
    expect(selectTestFiles(['./packages/core/'], discovered)).toEqual(['packages/core/__tests__/c.test.ts']);
  });

  it('matches a directory prefix on a path-segment boundary', () => {
    expect(() => selectTestFiles(['apps/web/src/li'], discovered)).toThrow(/apps\/web\/src\/li/);
  });

  it('mixes directory and file arguments without duplicates', () => {
    expect(selectTestFiles(['apps/web/src/lib/', 'apps/web/src/lib/a.test.ts', 'packages/core/__tests__/c.test.ts'], discovered))
      .toEqual(discovered);
  });

  it('fails loudly on a directory argument that selects nothing', () => {
    // An empty selection exits 0 ("No unit test files selected."), so a typo'd
    // or uncollected directory would otherwise report green over zero tests.
    expect(() => selectTestFiles(['apps/nope/'], discovered)).toThrow(/apps\/nope/);
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
      durationMs: expect.any(Number),
    });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('uses the current Bun executable and converts launch errors into file failures', async () => {
    let command: string[] | undefined;
    const result = await runTestFile('example.test.ts', cmd => {
      command = cmd;
      throw new Error("ENOENT: posix_spawn 'bun'");
    });

    expect(command).toEqual([
      process.execPath,
      'test',
      '--preload',
      storeGuardPath(),
      '--timeout',
      String(getTestTimeoutMs(process.env.BUILDD_TEST_TIMEOUT_MS)),
      'example.test.ts',
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Failed to launch Bun");
    expect(result.output).toContain("ENOENT: posix_spawn 'bun'");
  });
});

describe('runTestFile spawn denied', () => {
  it('names the sandbox and the remote workflow on EPERM', async () => {
    const result = await runTestFile('example.test.ts', () => {
      throw new Error('EPERM: operation not permitted, uv_spawn bun.exe');
    });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('inconclusive');
    expect(result.output).toContain('Verify Unit Tests');
  });

  it('adds no hint for other launch failures', async () => {
    const result = await runTestFile('example.test.ts', () => {
      throw new Error("ENOENT: posix_spawn 'bun'");
    });
    expect(result.output).not.toContain('inconclusive');
  });
});

describe('runTestFile wall-clock cap', () => {
  it('kills a hung file and says why', async () => {
    process.env.BUILDD_TEST_FILE_TIMEOUT_MS = '50';
    try {
      let killed = false;
      let resolveExit!: (n: number) => void;
      const exited = new Promise<number>(r => (resolveExit = r));
      const empty = () => new ReadableStream<Uint8Array>({ start: c => void exited.then(() => c.close()) });
      const result = await runTestFile('hang.test.ts', () => ({
        exited,
        kill: () => { killed = true; resolveExit(137); },
        stdout: empty(),
        stderr: empty(),
      }));
      expect(killed).toBe(true);
      expect(result.exitCode).toBe(137);
      expect(result.output).toContain('wall-clock');
    } finally {
      delete process.env.BUILDD_TEST_FILE_TIMEOUT_MS;
    }
  });

  it('resolves even when an orphan keeps stdout open after the kill', async () => {
    process.env.BUILDD_TEST_FILE_TIMEOUT_MS = '50';
    try {
      const result = await runTestFile('orphan.test.ts', () => ({
        exited: new Promise<number>(() => {}),
        kill: () => {},
        stdout: new ReadableStream<Uint8Array>({ start: () => {} }),
        stderr: new ReadableStream<Uint8Array>({ start: () => {} }),
      }));
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain('wall-clock');
    } finally {
      delete process.env.BUILDD_TEST_FILE_TIMEOUT_MS;
    }
  });
});

describe('getFileWallTimeoutMs', () => {
  it('falls back to the default for unset, blank, invalid and <1 values', () => {
    const def = getFileWallTimeoutMs(undefined);
    expect(def).toBeGreaterThan(0);
    for (const v of ['', '   ', 'abc', '0', '-5', '0.5']) expect(getFileWallTimeoutMs(v)).toBe(def);
  });
  it('uses a valid value', () => {
    expect(getFileWallTimeoutMs('1234')).toBe(1234);
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

/**
 * On a live buildd runner host, the store the tripwire watches is also the
 * live runner's own store — a co-resident session can be rewriting
 * heartbeat/activity records in it for the whole run, and a byte-diff cannot
 * tell that apart from an isolation leak. `isStoreLikelyLive` is the signal
 * that lets the tripwire downgrade to advisory there instead of failing the
 * build on someone else's traffic.
 */
describe('isStoreLikelyLive', () => {
  it('is false for a missing store', () => {
    expect(isStoreLikelyLive(null)).toBe(false);
  });

  it('is false when every entry is old relative to the snapshot time', () => {
    const now = 1_000_000;
    const snapshot = { 'a.json': `120@${now - 5 * 60_000}`, 'b.json': `80@${now - 10 * 60_000}` };
    expect(isStoreLikelyLive(snapshot, now)).toBe(false);
  });

  it('is true when an entry changed within the freshness window', () => {
    const now = 1_000_000;
    const snapshot = { 'a.json': `120@${now - 5 * 60_000}`, 'b.json': `80@${now - 1_000}` };
    expect(isStoreLikelyLive(snapshot, now)).toBe(true);
  });

  it('is true for an entry that raced a mid-scan stat, regardless of age', () => {
    const now = 1_000_000;
    expect(isStoreLikelyLive({ 'a.json': 'unreadable' }, now)).toBe(true);
  });

  it('respects a custom freshness window', () => {
    const now = 1_000_000;
    const snapshot = { 'a.json': `120@${now - 5_000}` };
    expect(isStoreLikelyLive(snapshot, now, 1_000)).toBe(false);
    expect(isStoreLikelyLive(snapshot, now, 10_000)).toBe(true);
  });
});

describe('storeDiffIsFatal', () => {
  it('is false when nothing changed, live or not', () => {
    expect(storeDiffIsFatal([], false)).toBe(false);
    expect(storeDiffIsFatal([], true)).toBe(false);
  });

  it('fails the build for a diff on a quiescent host', () => {
    expect(storeDiffIsFatal(['added: leaked.json'], false)).toBe(true);
  });

  it('does not fail the build for a diff the host was already live for', () => {
    expect(storeDiffIsFatal(['modified: w-1.json'], true)).toBe(false);
  });
});

describe('formatStoreTripwireReport advisory mode', () => {
  it('defaults to the fatal ::error:: report', () => {
    const report = formatStoreTripwireReport('/some/store', ['added: leaked.json']);
    expect(report).toContain('::error::');
    expect(report).toContain('leaked.json');
  });

  it('explains the live-host carve-out and omits ::error:: when advisory', () => {
    const report = formatStoreTripwireReport('/some/store', ['modified: w-1.json'], { advisory: true });
    expect(report).not.toContain('::error::');
    expect(report).toContain('w-1.json');
    expect(report).toContain('live runner is active on this host');
    expect(report).toContain('Not failing the build');
  });

  it('still gates, with attribution, when the guard named a culprit on a live host', () => {
    // A refused write belongs to one process, so co-resident churn cannot
    // explain it: the live-host carve-out must not swallow it.
    const report = formatStoreTripwireReport('/some/store', ['modified: w-1.json'], {
      advisory: true,
      culprits: ['apps/runner/__tests__/unit/offender.test.ts'],
    });
    expect(report).toContain('::error::');
    expect(report).toContain('offender.test.ts');
    expect(report).not.toContain('Not failing the build');
  });
});

/**
 * The tripwire above proves the store moved; it cannot say which of 800+
 * concurrently-running files moved it, which is a full bisect for whoever
 * reads the failure. `test-store-guard.ts` is preloaded into every child so
 * the reach is refused and named in the process that attempts it.
 */
describe('real-home reach attribution', () => {
  it('keeps its marker literal in step with the guard module', () => {
    const guard = readFileSync(storeGuardPath(), 'utf8');
    expect(guard).toContain(`STORE_REACH_MARKER = '${STORE_REACH_MARKER}'`);
  });

  it('names the files whose output carries the marker, and only those', () => {
    expect(attributeStoreReaches([
      { file: 'b.test.ts', output: `boom ${STORE_REACH_MARKER} /home/u/.buildd/workers/w.json` },
      { file: 'a.test.ts', output: 'ordinary failure' },
      { file: 'c.test.ts', output: `${STORE_REACH_MARKER} again` },
    ])).toEqual(['b.test.ts', 'c.test.ts']);
  });

  it('attributes a passing file too, because the persist paths swallow the throw', () => {
    expect(attributeStoreReaches([
      { file: 'green.test.ts', output: `1 pass 0 fail ${STORE_REACH_MARKER} /home/u/.buildd/x` },
    ])).toEqual(['green.test.ts']);
  });

  it('puts the culprit in the report instead of leaving the reader to bisect', () => {
    const report = formatStoreTripwireReport(
      '/some/store',
      ['modified: worker-1.json'],
      { culprits: ['apps/runner/__tests__/unit/offender.test.ts'] },
    );
    expect(report).toContain('Attributed to:');
    expect(report).toContain('apps/runner/__tests__/unit/offender.test.ts');
    expect(report).toContain('modified: worker-1.json');
  });

  it('says so plainly when nothing could be attributed', () => {
    const report = formatStoreTripwireReport('/some/store', ['modified: worker-1.json']);
    expect(report).toContain('No test file could be attributed');
    expect(report).not.toContain('Attributed to:');
  });

  it('reports a refused write without claiming the store changed', () => {
    const report = formatStoreTripwireReport('/some/store', [], { culprits: ['offender.test.ts'] });
    expect(report).toContain('tried to write inside the REAL runner home');
    expect(report).toContain('the store itself is unchanged');
    expect(report).not.toContain('The unit suite changed');
    expect(report).toContain('offender.test.ts');
  });

  it('refuses a write under the real home from inside a child, and allows one outside it', async () => {
    const probe = mkdtempSync(join(tmpdir(), 'buildd-guard-probe-'));
    try {
      const testFile = join(probe, 'probe.test.ts');
      // Written as a real child so the assertion covers the preload wiring --
      // the patch has to be installed before the module under test imports fs.
      writeFileSync(testFile, [
        "import { test, expect } from 'bun:test';",
        "import { writeFileSync } from 'fs';",
        "import { homedir, tmpdir } from 'os';",
        "import { join } from 'path';",
        "test('reaching the real home throws', () => {",
        "  expect(() => writeFileSync(join(homedir(), '.buildd', 'workers', 'probe.json'), '{}')).toThrow();",
        '});',
        "test('writing under tmpdir is untouched', () => {",
        "  const p = join(tmpdir(), 'buildd-guard-allowed.json');",
        "  expect(() => writeFileSync(p, '{}')).not.toThrow();",
        '});',
      ].join('\n'));

      const result = await runTestFile(testFile);

      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('2 pass');
    } finally {
      rmSync(probe, { recursive: true, force: true });
    }
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

describe('getTestTimeoutMs', () => {
  it('defaults well above Bun\'s 5s so CPU contention does not fail fast tests', () => {
    expect(getTestTimeoutMs(undefined)).toBeGreaterThan(5_000);
    expect(getTestTimeoutMs('')).toBe(getTestTimeoutMs(undefined));
  });

  it('honours a valid override and ignores garbage', () => {
    expect(getTestTimeoutMs('60000')).toBe(60_000);
    expect(getTestTimeoutMs('abc')).toBe(getTestTimeoutMs(undefined));
    expect(getTestTimeoutMs('0')).toBe(getTestTimeoutMs(undefined));
    expect(getTestTimeoutMs('-5')).toBe(getTestTimeoutMs(undefined));
  });
});

describe('orderByDuration', () => {
  it('runs the slowest hinted files first, then unhinted files alphabetically', () => {
    const files = ['a.test.ts', 'b.test.ts', 'slow.test.ts', 'slower.test.ts', 'z.test.ts'];
    const hints = { 'slow.test.ts': 30_000, 'slower.test.ts': 60_000, 'z.test.ts': 12_000 };
    expect(orderByDuration(files, hints)).toEqual([
      'slower.test.ts',
      'slow.test.ts',
      'z.test.ts',
      'a.test.ts',
      'b.test.ts',
    ]);
  });

  it('with no hints at all, is plain alphabetical (the order before hints existed)', () => {
    expect(orderByDuration(['c.test.ts', 'a.test.ts', 'b.test.ts'], {})).toEqual(['a.test.ts', 'b.test.ts', 'c.test.ts']);
  });

  it('breaks equal hints alphabetically, so the order is deterministic', () => {
    expect(orderByDuration(['y.test.ts', 'x.test.ts'], { 'x.test.ts': 5_000, 'y.test.ts': 5_000 })).toEqual(['x.test.ts', 'y.test.ts']);
  });

  it('only reorders: hints for files not selected add nothing, and no selected file is dropped', () => {
    const files = ['b.test.ts', 'a.test.ts'];
    const ordered = orderByDuration(files, { 'gone.test.ts': 99_000, 'b.test.ts': 3_000 });
    expect(ordered).toEqual(['b.test.ts', 'a.test.ts']);
    expect([...ordered].sort()).toEqual([...files].sort());
  });

  it('ignores a nonsense hint rather than scheduling by it', () => {
    const hints = { 'a.test.ts': -5, 'b.test.ts': Number.NaN } as Record<string, number>;
    expect(orderByDuration(['b.test.ts', 'a.test.ts'], hints)).toEqual(['a.test.ts', 'b.test.ts']);
  });

  it('the committed hints put the slowest known file first and unhinted files last', () => {
    const hints = readDurationHints();
    expect(Object.keys(hints).length).toBeGreaterThan(0);
    const ordered = orderByDuration([...Object.keys(hints), 'aaa-unhinted.test.ts'], hints);
    expect(ordered.at(-1)).toBe('aaa-unhinted.test.ts');
    expect(hints[ordered[0]!]).toBe(Math.max(...Object.values(hints)));
  });
});

describe('duration hints file', () => {
  it('parseRunnerArgs strips the update flag so it is never mistaken for a directory', () => {
    expect(parseRunnerArgs(['apps/web/src', UPDATE_DURATIONS_FLAG])).toEqual({ named: ['apps/web/src'], updateDurations: true, shard: null });
    expect(parseRunnerArgs(['ALL'])).toEqual({ named: ['ALL'], updateDurations: false, shard: null });
  });

  it('every committed hint names an existing unit test file and is over the threshold', () => {
    const hints = readDurationHints(DURATIONS_PATH);
    for (const [file, ms] of Object.entries(hints)) {
      expect(isUnitTestFile(file)).toBe(true);
      expect(existsSync(file)).toBe(true);
      expect(ms).toBeGreaterThanOrEqual(DURATION_HINT_MIN_MS);
    }
  });

  it('a missing or malformed hint file falls back to no hints', () => {
    const dir = mkdtempSync(join(tmpdir(), 'durations-'));
    try {
      expect(readDurationHints(join(dir, 'absent.json'))).toEqual({});
      writeFileSync(join(dir, 'bad.json'), '{not json');
      expect(readDurationHints(join(dir, 'bad.json'))).toEqual({});
      writeFileSync(join(dir, 'array.json'), '{"files": [1, 2]}');
      expect(readDurationHints(join(dir, 'array.json'))).toEqual({});
      writeFileSync(join(dir, 'mixed.json'), '{"files": {"a.test.ts": 3000, "b.test.ts": "slow"}}');
      expect(readDurationHints(join(dir, 'mixed.json'))).toEqual({ 'a.test.ts': 3000 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('round-trips through the file format', () => {
    const dir = mkdtempSync(join(tmpdir(), 'durations-'));
    try {
      const path = join(dir, 'd.json');
      writeFileSync(path, formatDurationHintsFile({ 'a.test.ts': 3_000, 'b.test.ts': 45_000 }));
      expect(readDurationHints(path)).toEqual({ 'a.test.ts': 3_000, 'b.test.ts': 45_000 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('merge: measured files replace their hint, unmeasured keep it, deleted and now-fast files drop out', () => {
    const previous = { 'kept.test.ts': 9_000, 'remeasured.test.ts': 9_000, 'deleted.test.ts': 9_000, 'got-fast.test.ts': 9_000 };
    const merged = mergeDurationHints(
      previous,
      [
        { file: 'remeasured.test.ts', durationMs: 31_449 },
        { file: 'got-fast.test.ts', durationMs: DURATION_HINT_MIN_MS - 1 },
        { file: 'new-slow.test.ts', durationMs: 4_260 },
        { file: 'new-fast.test.ts', durationMs: 120 },
      ],
      ['kept.test.ts', 'remeasured.test.ts', 'got-fast.test.ts', 'new-slow.test.ts', 'new-fast.test.ts'],
    );
    expect(merged).toEqual({ 'kept.test.ts': 9_000, 'new-slow.test.ts': 4_300, 'remeasured.test.ts': 31_400 });
    // Keys sorted, so a refresh diffs cleanly.
    expect(Object.keys(merged)).toEqual(['kept.test.ts', 'new-slow.test.ts', 'remeasured.test.ts']);
  });

  it('formatDurations lists slowest first and honours the limit', () => {
    const lines = formatDurations([
      { file: 'a.test.ts', durationMs: 1_000 },
      { file: 'b.test.ts', durationMs: 57_250 },
      { file: 'c.test.ts', durationMs: 4_000 },
    ], 2);
    expect(lines).toEqual(['   57.3s  b.test.ts', '    4.0s  c.test.ts']);
  });

  it('summarizeHostBusy names foreign CPU hogs and skips this run\'s own tree', () => {
    const ps = [
      '  100     1  3.0 bun run scripts/run-unit-tests.ts',
      '  101   100 95.0 bun test /x/a.test.ts',
      '  200     1 129.0 next-build (v16.3.6)',
      '  201   200 63.0 /usr/bin/node /tmp/ci/node_modules/typescript/bin/tsc --noEmit',
      '  300     1  2.0 sleep 5',
    ].join('\n');
    expect(summarizeHostBusy(ps, 100)).toBe('next-build 129%, tsc 63%');
    expect(summarizeHostBusy('garbage', 100)).toBe('');
    const line = formatHeartbeat({ done: 1, total: 2, failed: 0, running: [], elapsedMs: 1000, load1: 9, cpus: 4, remainingHintMs: null, hostBusy: 'next-build 129%' });
    expect(line).toContain('host busy: next-build 129%');
    expect(formatHeartbeat({ done: 1, total: 2, failed: 0, running: [], elapsedMs: 1000, load1: 1, cpus: 4, remainingHintMs: null, hostBusy: 'x 50%' })).not.toContain('host busy');
  });

  it('formatHeartbeat reports progress, flags an oversubscribed host, and omits unknown ETA', () => {
    const base = { done: 10, total: 40, failed: 1, running: ['a.test.ts'], elapsedMs: 61_000, cpus: 4 };
    const calm = formatHeartbeat({ ...base, load1: 2, remainingHintMs: 90_000 });
    expect(calm).toContain('10/40 files done (1 failed)');
    expect(calm).toContain('61s elapsed');
    expect(calm).toContain('~90s of hinted work left');
    expect(calm).not.toContain('oversubscribed');
    const busy = formatHeartbeat({ ...base, load1: 9.5, remainingHintMs: null });
    expect(busy).toContain('oversubscribed');
    expect(busy).not.toContain('hinted work');
  });
});

describe('host-aware admission', () => {
  it('keeps full concurrency on a calm host and halves it when oversubscribed', () => {
    expect(admissionLimit(4, 2, 4)).toBe(4);
    expect(admissionLimit(4, 6, 4)).toBe(4);
    expect(admissionLimit(4, 6.5, 4)).toBe(2);
    expect(admissionLimit(1, 100, 4)).toBe(1);
  });

  it('quarters concurrency when the host is severely oversubscribed', () => {
    expect(admissionLimit(8, 12.4, 4)).toBe(2);
    expect(admissionLimit(8, 12, 4)).toBe(4);
    expect(admissionLimit(2, 50, 4)).toBe(1);
  });

  it('never runs more files than the live limit, but always makes progress', async () => {
    let active = 0;
    let peak = 0;
    await runWithConcurrency([1, 2, 3, 4, 5], 4, async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise(r => setTimeout(r, 5));
      active--;
    }, { limit: () => 0, pollMs: 1 });
    expect(peak).toBe(1);
  });
});

describe('start gate', () => {
  it('waits until load falls under the severe line, bounded', async () => {
    const loads = [20, 20, 5];
    let slept = 0;
    const waited = await waitForHostRoom({
      load1: () => loads.shift() ?? 1, cpuCount: 4, maxWaitMs: 60_000, pollMs: 10,
      sleep: async () => { slept++; },
    });
    expect(slept).toBe(2);
    expect(waited).toBe(20);
  });

  it('gives up at the bound and does not wait on an idle host', async () => {
    const stuck = await waitForHostRoom({ load1: () => 50, cpuCount: 4, maxWaitMs: 30, pollMs: 10, sleep: async () => {} });
    expect(stuck).toBe(30);
    const idle = await waitForHostRoom({ load1: () => 1, cpuCount: 4, maxWaitMs: 30, pollMs: 10, sleep: async () => {} });
    expect(idle).toBe(0);
  });

  it('parses the wait bound', () => {
    expect(startGateWaitMs(undefined)).toBe(60_000);
    expect(startGateWaitMs('0')).toBe(0);
    expect(startGateWaitMs('abc')).toBe(60_000);
  });
});
