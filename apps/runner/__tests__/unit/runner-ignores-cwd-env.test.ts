/**
 * Running `buildd` inside a project folder used to pull that folder's .env into
 * the runner twice over: Bun auto-loads a cwd .env, and the runner's import
 * graph reached @buildd/core/db → config.ts → dotenv.config(). A repo's API key
 * and server URL then pointed a runner at a live server.
 *
 * The launcher (install.sh) now runs bun with --no-env-file and the runner's
 * import graph must not load dotenv. This spawns the real entrypoint from a
 * temp cwd holding a fake .env and asserts nothing from it arrives.
 */
import { describe, test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const REPO = join(import.meta.dir, '../../../..');
const ENTRY = join(REPO, 'apps/runner/src/index.ts');
const PRELOAD = join(REPO, 'scripts/stub-server-only.ts');

function runFromProjectWithEnv(args: string[]) {
  const cwd = mkdtempSync(join(tmpdir(), 'buildd-cwd-env-'));
  writeFileSync(join(cwd, '.env'), 'BUILDD_API_KEY=bld_fake\nBUILDD_SERVER=http://127.0.0.1:9\nCWD_ENV_PROBE=leaked\n');
  const probe = join(cwd, 'probe.ts');
  writeFileSync(probe, "process.on('exit', () => console.error('PROBE=' + (process.env.CWD_ENV_PROBE ?? 'absent')));\n");
  const home = mkdtempSync(join(tmpdir(), 'buildd-home-'));
  const env: Record<string, string> = { PATH: process.env.PATH ?? '', HOME: home, BUILDD_HOME: join(home, '.buildd'),
    // Never a live server, even if a runner did start.
    BUILDD_SERVER: 'http://127.0.0.1:9', BUILDD_DISABLE_AUTO_UPDATE: '1' };
  const proc = Bun.spawnSync(['bun', '--no-env-file', 'run', '--preload', PRELOAD, '--preload', probe, ENTRY, ...args], {
    // A runner that actually started never exits on its own: the timeout kills
    // it and exitCode comes back null, failing every assertion below.
    cwd, env, stdout: 'pipe', stderr: 'pipe', timeout: 30_000,
  });
  return { code: proc.exitCode, out: proc.stdout.toString() + proc.stderr.toString() };
}

describe('runner never loads a cwd .env', () => {
  test('the runner module graph does not load dotenv', () => {
    const r = runFromProjectWithEnv(['--version']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('PROBE=absent');
    expect(r.out).not.toContain('injected env');
  }, 60_000);

  test('--help prints usage and exits 0 without starting', () => {
    const r = runFromProjectWithEnv(['--help']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Usage: buildd');
  }, 60_000);

  test('an unknown flag prints usage and exits 64 without starting', () => {
    const r = runFromProjectWithEnv(['--bogus']);
    expect(r.code).toBe(64);
    expect(r.out).toContain('Unknown argument: --bogus');
    expect(r.out).toContain('Usage: buildd');
  }, 60_000);
});
