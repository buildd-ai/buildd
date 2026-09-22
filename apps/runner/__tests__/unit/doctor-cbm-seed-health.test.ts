/**
 * Regression: CBM seed outcomes were written to `seed.log` but nothing ever
 * read it back — seed success/failure was undeterminable short of a human
 * tailing a file on a specific runner host. `checkCbmSeedHealth` is the
 * doctor.ts check that closes the loop: it reads the same structured
 * `SEED_OUTCOME` lines `spawnCbmSeedRefresh` now appends (cbm-enforcement.ts)
 * and reports them through `runDiagnostics()`, the same surface every other
 * runner health signal (bwrap, disk, stale worktrees) already goes through.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/doctor-cbm-seed-health.test.ts
 */
import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const shared = mkdtempSync(join(tmpdir(), 'cbm-shared-doctor-'));
process.env.BUILDD_CBM_SHARED_CACHE = shared;
process.env.BUILDD_HOME = mkdtempSync(join(tmpdir(), 'buildd-home-doctor-cbm-'));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { checkCbmSeedHealth } = require('../../src/doctor');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { cbmSeedLogPath } = require('../../src/cbm-enforcement');

afterAll(() => {
  delete process.env.BUILDD_CBM_SHARED_CACHE;
  delete process.env.BUILDD_HOME;
  rmSync(shared, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(cbmSeedLogPath(), { force: true });
});

function writeOutcomes(lines: string[]) {
  const { mkdirSync, writeFileSync } = require('fs') as typeof import('fs');
  const { dirname } = require('path') as typeof import('path');
  const path = cbmSeedLogPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, lines.map(l => `SEED_OUTCOME ${l}\n`).join(''));
}

describe('checkCbmSeedHealth', () => {
  test('no log file at all: ok, not an error (seeding may just not have run yet)', () => {
    const result = checkCbmSeedHealth();
    expect(result.status).toBe('ok');
    expect(result.name).toBe('cbm-seed');
  });

  test('most recent outcome succeeded: ok, names the repo', () => {
    writeOutcomes([
      JSON.stringify({ repoPath: '/repo/a', baseRef: null, code: 0, exitedAt: '2026-01-01T00:00:00.000Z' }),
    ]);
    const result = checkCbmSeedHealth();
    expect(result.status).toBe('ok');
    expect(result.message).toContain('/repo/a');
  });

  test('most recent outcome failed: warn, names the exit code', () => {
    writeOutcomes([
      JSON.stringify({ repoPath: '/repo/a', baseRef: null, code: 0, exitedAt: '2026-01-01T00:00:00.000Z' }),
      JSON.stringify({ repoPath: '/repo/a', baseRef: null, code: 1, exitedAt: '2026-01-02T00:00:00.000Z' }),
    ]);
    const result = checkCbmSeedHealth();
    expect(result.status).toBe('warn');
    expect(result.message).toContain('1');
    expect(result.message).toContain('/repo/a');
  });
});
