import { mkdtempSync, readdirSync, rmSync, statSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';

// Anything matching one of these prefixes and ending in .test.ts(x) is run.
//
// Prefixes, not a file list: the `scripts/` entries used to be enumerated one by
// one, so a new script test was silently uncollected until someone remembered to
// add it. Two whole directories were missing the same way -- `apps/runner/src/`
// (3 files, never run in CI) and `apps/runner/__tests__/standalone/` (4 files, 35
// tests, run by no script and no workflow at all). `collector-coverage.test.ts`
// now fails if a tracked test file is neither matched here nor listed there as a
// deliberate exclusion, so this cannot rot again.
const UNIT_TEST_ROOTS = [
  'apps/web/src/',
  'apps/runner/__tests__/unit/',
  'apps/runner/__tests__/standalone/',
  'apps/runner/src/',
  'packages/core/',
  'scripts/',
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

/**
 * Delete a throwaway BUILDD_HOME.
 *
 * Refuses anything outside `tmpdir()`: leaking one temp directory is strictly
 * better than recursively deleting a real one, so the guard fails closed.
 */
function discardTestHome(home: string): void {
  if (!home.startsWith(tmpdir())) return;
  try {
    rmSync(home, { recursive: true, force: true });
  } catch { /* a leaked temp dir is not worth failing a run over */ }
}

/**
 * Preloaded into every child so a reach for the real `~/.buildd` is refused
 * *and attributed* in the process that attempts it. See `test-store-guard.ts`:
 * the run-level tripwire below can only say the store changed, not which of
 * 800+ concurrently-running files changed it.
 */
export function storeGuardPath(): string {
  return join(import.meta.dir, 'test-store-guard.ts');
}

/**
 * Must stay identical to `STORE_REACH_MARKER` in `test-store-guard.ts`.
 * Duplicated rather than imported because importing the guard would run its
 * fs-patching side effect in this parent process too;
 * `run-unit-tests.test.ts` asserts the two literals still match.
 */
export const STORE_REACH_MARKER = '::buildd-real-home-write::';

/** Test files whose output shows they reached the real runner home. */
export function attributeStoreReaches(
  results: ReadonlyArray<{ file: string; output: string }>,
): string[] {
  return results
    .filter(r => r.output.includes(STORE_REACH_MARKER))
    .map(r => r.file)
    .sort();
}

export async function runTestFile(
  file: string,
  spawn: SpawnTestProcess = (command, options) => Bun.spawn(command, options),
): Promise<TestResult> {
  // Every test file gets its own throwaway BUILDD_HOME. Seven runner modules
  // resolve that env var when they are first imported (worker-store,
  // history-store, session-logger, outbox, doctor, updater, index), so a test
  // setting it in a `beforeAll` arrives after the path has already been baked in.
  // Injecting it at the single spawn point covers all of them regardless of
  // when they read it, and needs no change to 800+ test files. Without it the
  // suite wrote fixture records into the operator's real ~/.buildd/workers,
  // where they were counted as fleet data.
  const testHome = mkdtempSync(join(tmpdir(), 'buildd-test-home-'));
  try {
    const child = spawn([process.execPath, 'test', '--preload', storeGuardPath(), file], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, BUILDD_HOME: testHome },
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
  } finally {
    discardTestHome(testHome);
  }
}

/**
 * The store the runner actually persists worker state to. Watched, never
 * written, by the tripwire below.
 */
export function realWorkerStoreDir(): string {
  return join(homedir(), '.buildd', 'workers');
}

/**
 * Entry name -> a fingerprint of its content (size + mtime), or `null` when the
 * directory does not exist.
 *
 * `null` is load-bearing: on CI the store is absent, and the suite *creating*
 * it is itself the failure, so "absent" must be a distinguishable state rather
 * than an empty map.
 */
export type StoreSnapshot = Record<string, string> | null;

export function snapshotStore(dir: string): StoreSnapshot {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  const snapshot: Record<string, string> = {};
  for (const entry of entries.sort()) {
    try {
      const st = statSync(join(dir, entry));
      snapshot[entry] = `${st.size}@${st.mtimeMs}`;
    } catch {
      // Raced with the live runner mid-scan; record the disappearance itself.
      snapshot[entry] = 'unreadable';
    }
  }
  return snapshot;
}

/** Human-readable differences between two snapshots; empty means untouched. */
export function diffStoreSnapshots(before: StoreSnapshot, after: StoreSnapshot): string[] {
  if (before === null && after === null) return [];
  if (before === null) {
    const names = Object.keys(after ?? {});
    return [`the directory did not exist and was created${names.length ? ` with: ${names.join(', ')}` : ''}`];
  }
  if (after === null) return ['the directory existed before the run and is now gone'];

  const diffs: string[] = [];
  for (const name of Object.keys(after)) {
    if (!(name in before)) diffs.push(`added: ${name}`);
    else if (before[name] !== after[name]) diffs.push(`modified: ${name}`);
  }
  for (const name of Object.keys(before)) {
    if (!(name in after)) diffs.push(`removed: ${name}`);
  }
  return diffs.sort();
}

function parseFingerprintMtimeMs(fingerprint: string): number | null {
  const at = fingerprint.lastIndexOf('@');
  if (at === -1) return null;
  const value = Number(fingerprint.slice(at + 1));
  return Number.isFinite(value) ? value : null;
}

/** How recently an entry must have changed to count as evidence of a co-resident process. */
export const LIVE_RUNNER_FRESHNESS_WINDOW_MS = 60_000;

/**
 * True when `snapshot` already shows activity from something other than us —
 * an entry written within the freshness window, or one that raced a
 * mid-directory-listing stat (`'unreadable'`). Meant to be called on
 * `storeBefore`, taken before any test process has spawned: nothing of ours
 * has run yet, so only a co-resident process (the live runner) could have
 * caused that.
 *
 * This is what makes the run-level tripwire's byte-diff unattributable on a
 * runner host: a diff found after the suite could be either an isolation bug
 * in our own tests or ordinary heartbeat churn from that other process, and
 * there is no way to tell those apart from the diff alone. Observed directly:
 * on a live runner host, an 8-second idle wait with zero tests running showed
 * ~370 of 417 real worker files as "modified".
 */
export function isStoreLikelyLive(
  snapshot: StoreSnapshot,
  now: number = Date.now(),
  windowMs: number = LIVE_RUNNER_FRESHNESS_WINDOW_MS,
): boolean {
  if (snapshot === null) return false;
  return Object.values(snapshot).some(fingerprint => {
    if (fingerprint === 'unreadable') return true;
    const mtime = parseFingerprintMtimeMs(fingerprint);
    return mtime !== null && now - mtime < windowMs;
  });
}

/**
 * Whether a store diff should fail the build. Not just `diffs.length > 0`:
 * when the store was already live before the run started, the diff cannot be
 * attributed to the test suite, so it is reported but does not gate — the
 * injection and corpus-lint layers are what still catch a real regression
 * there. See `isStoreLikelyLive`.
 */
export function storeDiffIsFatal(diffs: readonly string[], storeWasLive: boolean): boolean {
  return diffs.length > 0 && !storeWasLive;
}

export function formatStoreTripwireReport(
  dir: string,
  diffs: readonly string[],
  opts: { advisory?: boolean; culprits?: readonly string[] } = {},
): string {
  const culprits = opts.culprits ?? [];
  // Advisory is only reachable when the guard named nobody: a refused write is
  // attributable to one process, so co-resident churn cannot explain it and it
  // gates regardless of how busy the host is.
  if (opts.advisory && culprits.length === 0) {
    return [
      '',
      `The real worker store at ${dir} changed during this run, but it was already`,
      'changing before the run started — a live runner is active on this host, so',
      'this byte-diff cannot tell its heartbeat/activity writes apart from a real',
      'isolation leak. Not failing the build on this alone:',
      '',
      ...diffs.map(d => `  ${d}`),
      '',
      'The injection (runTestFile) and corpus lint (scripts/test-home-isolation.test.ts)',
      'layers still gate on a real leak regardless of host activity. If you suspect',
      'this run actually wrote here, rerun on an idle host or check the entries above',
      'against what the suite\'s fixtures would have created.',
      '',
    ].join('\n');
  }
  // Naming the file is the whole point of the child-side guard. A detector that
  // fires without a culprit costs the next person the bisect it just cost the
  // last one, so say so explicitly when attribution is missing rather than
  // leaving the reader to wonder whether the list is empty or absent.
  const attribution = culprits.length > 0
    ? [
      'Attributed to:',
      ...culprits.map(f => `  ${f}`),
      '',
      'That file reached the real home directly. Its own output (above, and in',
      'the log) carries the fs call and the stack that got there.',
      '',
    ]
    : [
      'No test file could be attributed: the child-side guard in',
      'scripts/test-store-guard.ts saw no refused write. Either the write came',
      'from an fs call it does not wrap, or from a subprocess a test spawned',
      'with its own environment. Widen the guard rather than the allow-list.',
      '',
    ];
  // A refused write leaves the directory byte-identical, so "changed" would be
  // a false claim in exactly the case the guard is working.
  const headline = diffs.length > 0
    ? [`The unit suite changed the REAL worker store at ${dir}:`, '', ...diffs.map(d => `  ${d}`), '']
    : [`The unit suite tried to write inside the REAL runner home (${dir}).`, 'The guard refused the write, so the store itself is unchanged.', ''];
  return [
    '',
    ...headline,
    ...attribution,
    `::error::Unit tests must never touch ${dir}. Every test process gets its own`,
    'BUILDD_HOME under tmpdir() (see runTestFile). A test that reaches the real',
    'store is either resolving a path from homedir() directly or importing a',
    'module that resolved BUILDD_HOME before the injection — both are bugs, and',
    'both make the runner store useless as a measurement.',
    'scripts/test-home-isolation.test.ts names the tracked files allowed to',
    'reference homedir() at all.',
    '',
  ].join('\n');
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

  // Run-level tripwire. This is the layer that reproduces the original
  // measurement: on a quiescent host, the operator's worker store must look
  // identical before and after the run. A green suite that quietly added
  // fixture records to the live store was indistinguishable from a clean one,
  // for as long as nobody happened to look. On a runner host where something
  // else is actively writing the same store, the byte-diff can't tell that
  // churn apart from a leak, so it downgrades to advisory there instead of
  // failing the build on noise (see isStoreLikelyLive / storeDiffIsFatal).
  const storeDir = realWorkerStoreDir();
  const storeBefore = snapshotStore(storeDir);
  // Taken from storeBefore, before any test process spawns, so freshness here
  // can only come from something else running on this host.
  const storeWasLive = isStoreLikelyLive(storeBefore);

  // Scanned at collection time rather than by keeping every child's output:
  // a passing file can still have reached the real home (the persist paths
  // swallow the guard's throw), so the marker has to be checked for all of
  // them — but holding 800+ outputs in memory to do it is not worth it.
  const storeReaches: string[] = [];

  await runWithConcurrency(files, concurrency, async file => {
    const result = await runTestFile(file);
    if (result.output.includes(STORE_REACH_MARKER)) storeReaches.push(file);
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

  const storeDiffs = diffStoreSnapshots(storeBefore, snapshotStore(storeDir));
  // Two independent layers. The child-side guard is the authoritative one: it
  // attributes a reach to the process that made it, so co-resident runner churn
  // cannot produce it and it gates even on a live host — which is exactly the
  // case the byte-diff has to go advisory on. The guard also catches a reach the
  // byte-diff misses, since a refused write leaves the directory unchanged.
  const culprits = storeReaches.sort();
  if (culprits.length > 0) {
    console.error(formatStoreTripwireReport(storeDir, storeDiffs, { culprits }));
    process.exitCode = 1;
  } else if (storeDiffs.length > 0) {
    console.error(formatStoreTripwireReport(storeDir, storeDiffs, { advisory: storeWasLive }));
    if (storeDiffIsFatal(storeDiffs, storeWasLive)) {
      process.exitCode = 1;
    }
  }

  reportHiddenDirTests();
}

if (import.meta.main) {
  await main();
}
