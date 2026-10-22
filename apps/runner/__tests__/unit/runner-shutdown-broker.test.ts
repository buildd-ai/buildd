/**
 * One handler owns the runner's exit on SIGTERM (PR #4928 review): the
 * credential broker used to install its own SIGTERM/SIGINT handler that
 * exit(0)ed as soon as its leases were released, which cut the agents' pause
 * short (no safe-point wait, no checkpoint commit, no server report).
 *
 * Spawns the REAL broker in a child bun process (temp HOME, dead server) with
 * the runner's stop handler, and checks the order of what it prints.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/runner-shutdown-broker.test.ts
 */
import { describe, test, expect, afterAll } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const HOME = mkdtempSync(join(tmpdir(), 'shutdown-broker-'));
afterAll(() => rmSync(HOME, { recursive: true, force: true }));
const PROBE = join(import.meta.dir, '../fixtures/shutdown-broker-probe.ts');

async function runProbe(env: Record<string, string>): Promise<{ lines: string[]; code: number | null }> {
  const proc = Bun.spawn(['bun', 'run', PROBE], {
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME,
      BUILDD_HOME: join(HOME, '.buildd'),
      BUILDD_SERVER: 'http://127.0.0.1:1',
      BUILDD_CLIENT_URL: 'http://127.0.0.1:1',
      BUILDD_BROKER_SOCKET: join(HOME, `broker-${Math.random().toString(36).slice(2)}.sock`),
      ...env,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  // One reader loop collects everything; the checks below only look at `out`.
  let out = '';
  const dec = new TextDecoder();
  const drained = (async () => {
    for await (const chunk of proc.stdout as unknown as AsyncIterable<Uint8Array>) out += dec.decode(chunk);
  })();
  const until = async (marker: string, ms: number) => {
    const deadline = Date.now() + ms;
    while (!out.includes(marker) && Date.now() < deadline) await new Promise(r => setTimeout(r, 25));
  };
  await until('ready', 10_000);
  proc.kill('SIGTERM');
  await until('exit', 10_000);
  const code = await Promise.race([proc.exited, new Promise<null>(res => setTimeout(() => res(null), 5_000))]);
  if (code === null) proc.kill('SIGKILL');
  await Promise.race([drained, new Promise(r => setTimeout(r, 1_000))]);
  return { lines: out.split('\n').filter(Boolean), code: code as number | null };
}

// Windows has no SIGTERM: kill() terminates the child outright, so no handler runs.
describe.skipIf(process.platform === 'win32')('SIGTERM with the real credential broker running', () => {
  test('the runner exits only after the pause finished, then the broker released its leases', async () => {
    const { lines, code } = await runProbe({});
    expect(lines).toContain('ready');
    const at = (l: string) => lines.indexOf(l);
    expect(at('pause start')).toBeGreaterThan(-1);
    expect(at('pause done')).toBeGreaterThan(at('pause start'));
    expect(at('broker released')).toBeGreaterThan(at('pause done'));
    expect(at('exit 0')).toBeGreaterThan(at('broker released'));
    expect(code).toBe(0);
  }, 30_000);

  test('the broker\'s own handler (what the runner had before) exits before the pause is done', async () => {
    const { lines } = await runProbe({ PROBE_BROKER_SIGNALS: '1' });
    expect(lines).toContain('pause start');
    expect(lines).not.toContain('pause done');
  }, 30_000);
});

describe('no other stop handler can race the runner\'s', () => {
  const SRC = join(import.meta.dir, '../../src');
  const files = (dir: string): string[] => readdirSync(dir).flatMap(n => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return files(p);
    return /\.ts$/.test(n) && !/\.test\.ts$/.test(n) ? [p] : [];
  });

  test('the runner starts the broker without its own signal handlers', () => {
    const index = readFileSync(join(SRC, 'index.ts'), 'utf-8');
    const starts = index.match(/credentialBroker\.start\([^\n]*\)/g) ?? [];
    expect(starts.length).toBeGreaterThan(0);
    for (const s of starts) expect(s).toContain('signalHandlers: false');
    expect(index).toContain('installRunnerShutdown(');
  });

  test('SIGTERM/SIGINT/beforeExit listeners live only in the stop handler, the broker (opt-out) and buildd top (its own process)', () => {
    const allowed = new Set(['restart-resume.ts', 'broker.ts', join('top', 'run.ts')]);
    const offenders: string[] = [];
    for (const f of files(SRC)) {
      const rel = f.slice(SRC.length + 1);
      const text = readFileSync(f, 'utf-8');
      if (/^\s*process\.(on|once)\(\s*['"](SIGTERM|SIGINT|beforeExit)['"]/m.test(text) && !allowed.has(rel)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});
