/**
 * Regression: CBM seed outcomes were written to `seed.log`, but only as the raw
 * stdout/stderr of the detached seeder child — nothing structured, and nothing
 * anywhere read it back. The only trace of a FAILED run was a `console.warn`
 * pointing at the log path; a SUCCESSFUL run left no trace at all. Seed
 * success/failure was therefore undeterminable without a human tailing a file
 * on a specific runner host.
 *
 * `spawnCbmSeedRefresh` now appends one structured `SEED_OUTCOME` line per run
 * (success or failure) to the same log, and `parseSeedOutcomes` reads it back —
 * this is what `doctor.ts`'s `checkCbmSeedHealth` (apps/runner/src/doctor.ts)
 * consumes to report seed health as part of `runDiagnostics()`.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/cbm-seed-outcomes.test.ts
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  cbmSeedLogPath,
  parseSeedOutcomes,
  resetCbmSeedRefreshState,
  spawnCbmSeedRefresh,
} from '../../src/cbm-enforcement';

const REPO = '/home/coder/project/demo';

let shared: string;
let seedRoot: string;

beforeEach(() => {
  shared = mkdtempSync(join(tmpdir(), 'cbm-shared-'));
  seedRoot = mkdtempSync(join(tmpdir(), 'cbm-seedroot-'));
  process.env.BUILDD_CBM_SHARED_CACHE = shared;
  process.env.BUILDD_CBM_SEED_ROOT = seedRoot;
  resetCbmSeedRefreshState();
});
afterEach(() => {
  rmSync(shared, { recursive: true, force: true });
  rmSync(seedRoot, { recursive: true, force: true });
  delete process.env.BUILDD_CBM_SHARED_CACHE;
  delete process.env.BUILDD_CBM_SEED_ROOT;
});

function harness() {
  const exits: Array<(code: number | null) => void> = [];
  const spawnProcess = ((_cmd: string, _args: string[]) => ({
    unref: () => {},
    on: (ev: string, cb: (code: number | null) => void) => { if (ev === 'exit') exits.push(cb); },
  })) as any;
  return {
    finish: (code: number | null) => exits.splice(0).forEach(cb => cb(code)),
    deps: {
      spawnProcess,
      pathExists: () => true,
      scriptPath: '/runner/scripts/cbm-seed.ts',
      runtime: '/usr/bin/bun',
      openLogFd: () => null, // exercise the real appendFileSync path, not the child's own stdio fd
    },
  };
}

describe('spawnCbmSeedRefresh outcome recording', () => {
  test('a successful run appends a structured outcome with code 0', () => {
    const h = harness();
    spawnCbmSeedRefresh(REPO, h.deps);
    h.finish(0);

    expect(existsSync(cbmSeedLogPath())).toBe(true);
    const outcomes = parseSeedOutcomes(readFileSync(cbmSeedLogPath(), 'utf-8'));
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].repoPath).toBe(REPO);
    expect(outcomes[0].code).toBe(0);
    expect(typeof outcomes[0].exitedAt).toBe('string');
  });

  test('a failed run appends a structured outcome with the non-zero code, not just a warning', () => {
    const h = harness();
    spawnCbmSeedRefresh(REPO, h.deps);
    h.finish(3);

    const outcomes = parseSeedOutcomes(readFileSync(cbmSeedLogPath(), 'utf-8'));
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].code).toBe(3);
  });

  test('the base ref travels with the outcome when the seed was for a mission base', () => {
    const h = harness();
    spawnCbmSeedRefresh(REPO, { ...h.deps, baseRef: 'origin/mission/foo' });
    h.finish(0);

    const [outcome] = parseSeedOutcomes(readFileSync(cbmSeedLogPath(), 'utf-8'));
    expect(outcome.baseRef).toBe('origin/mission/foo');
  });

  test('multiple runs accumulate multiple parseable outcome lines', () => {
    const h = harness();
    spawnCbmSeedRefresh(REPO, h.deps);
    h.finish(0);
    resetCbmSeedRefreshState(); // bypass the in-flight/cooldown guard for a second attempt
    spawnCbmSeedRefresh(REPO, h.deps);
    h.finish(1);

    const outcomes = parseSeedOutcomes(readFileSync(cbmSeedLogPath(), 'utf-8'));
    expect(outcomes.map(o => o.code)).toEqual([0, 1]);
  });
});

describe('parseSeedOutcomes', () => {
  test('ignores non-outcome lines from the seeder\'s own stdout/stderr', () => {
    const text = [
      '[cbm-seed] indexing /home/coder/project/demo...',
      'SEED_OUTCOME {"repoPath":"/r","baseRef":null,"code":0,"exitedAt":"2026-01-01T00:00:00.000Z"}',
      'some other unrelated log noise',
    ].join('\n');
    expect(parseSeedOutcomes(text)).toEqual([
      { repoPath: '/r', baseRef: null, code: 0, exitedAt: '2026-01-01T00:00:00.000Z' },
    ]);
  });

  test('skips a malformed outcome line instead of losing every other one', () => {
    const text = [
      'SEED_OUTCOME {not valid json',
      'SEED_OUTCOME {"repoPath":"/r","baseRef":null,"code":0,"exitedAt":"2026-01-01T00:00:00.000Z"}',
    ].join('\n');
    expect(parseSeedOutcomes(text)).toHaveLength(1);
  });

  test('empty log yields an empty array', () => {
    expect(parseSeedOutcomes('')).toEqual([]);
  });
});
