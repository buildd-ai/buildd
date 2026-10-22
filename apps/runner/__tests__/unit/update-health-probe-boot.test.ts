import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { delimiter, join, resolve } from 'path';
import { HEALTH_PROBE_ENV, buildHealthProbeSpawn } from '../../src/updater';

/**
 * The probe child only has to prove the build loads and binds its port. On a
 * machine whose project root is a whole home directory the repo scan took
 * longer than the probe's deadline, rolling back healthy updates. These boot the
 * real entry with a `git` that sleeps and records its calls (a slow scan).
 */
const REPO_ROOT = resolve(import.meta.dir, '../../../..');
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });

async function bootAndWaitForHealth(port: number, probe: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'probe-boot-'));
  const bin = join(dir, 'bin');
  const root = join(dir, 'projects');
  const gitLog = join(dir, 'git.log');
  mkdirSync(bin); mkdirSync(join(root, 'repo-a', '.git'), { recursive: true });
  // On Windows this extensionless sh shim is never exec'd, so the scan runs the
  // real git there: the boot and /health are still proven, the slow scan is not.
  writeFileSync(join(bin, 'git'), `#!/bin/sh\necho "$PWD: $@" >> ${gitLog}\nsleep 20\n`);
  chmodSync(join(bin, 'git'), 0o755);

  const home = join(dir, 'home');
  mkdirSync(home);
  const spec = buildHealthProbeSpawn({
    installDir: REPO_ROOT, probePort: port, probeHome: home, configFile: join(home, 'config.json'),
    baseEnv: { PATH: `${bin}${delimiter}${process.env.PATH}`, PROJECTS_ROOT: root, HOME: dir },
  });
  if (!probe) delete spec.env[HEALTH_PROBE_ENV];
  const proc = Bun.spawn(spec.cmd, { cwd: spec.cwd, env: spec.env, stdout: 'ignore', stderr: 'ignore' });
  cleanup.push(async () => {
    try { proc.kill('SIGKILL'); } catch { /* gone */ }
    // Windows keeps the dir locked until the killed child has actually exited.
    await proc.exited;
    // Best effort: a grandchild (the scan's git) can still hold the dir on Windows;
    // it is a temp dir, so a leftover must not fail an otherwise passing test.
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* temp dir */ }
  });

  const start = Date.now();
  let ok = false;
  while (Date.now() - start < 15_000 && proc.exitCode === null) {
    try { ok = (await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) })).ok; } catch { /* not yet */ }
    if (ok) break;
    await new Promise(r => setTimeout(r, 200));
  }
  const gitCalls = existsSync(gitLog) ? readFileSync(gitLog, 'utf8') : '';
  return { ok, gitCalls };
}

describe('health probe child boot', () => {
  test('spawn spec marks the child as a probe', () => {
    const spec = buildHealthProbeSpawn({ installDir: '/x', probePort: 1, probeHome: '/h', configFile: '/c' });
    expect(spec.env[HEALTH_PROBE_ENV]).toBe('1');
  });

  test('serves /health while a repo scan would still be running, and never starts one', async () => {
    const { ok, gitCalls } = await bootAndWaitForHealth(18931, true);
    expect(ok).toBe(true);
    expect(gitCalls).not.toContain('remote get-url');
  }, 30_000);

  test('a normal boot also answers /health before its slow repo scan completes', async () => {
    const { ok } = await bootAndWaitForHealth(18932, false);
    expect(ok).toBe(true);
  }, 30_000);
});
