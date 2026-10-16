/**
 * `buildd web` (spec c7410e76 R-15): open the running runner's local web UI.
 * A runner without one (the headless default, and the background service)
 * gets one line saying how to turn it on; nothing is restarted.
 *
 * The socket is a real unix socket under a temp dir; the browser opener is a
 * stub, so no browser and no real runner are ever touched.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { decideWeb, readRunnerHttpPort, runWebCommand, WEB_OFF_HINT } from '../../src/runner-web';
import { serveRunnerSocket, type RunnerSocketServer } from '../../src/runner-socket';

const dirs: string[] = [];
const servers: RunnerSocketServer[] = [];
afterAll(() => {
  for (const s of servers) s.stop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tempSocket(): string {
  const d = mkdtempSync(join(tmpdir(), 'bw-'));
  dirs.push(d);
  return join(d, 'runner.sock');
}

function serveIdentity(socketPath: string, httpPort: number | null): void {
  servers.push(serveRunnerSocket(socketPath, () =>
    Response.json({ pid: 4242, version: '0.0.0-test', startedAt: new Date().toISOString(), socket: socketPath, httpPort })));
}

describe('decideWeb', () => {
  test('no runner: says so, names how to start one, exits non-zero', () => {
    const d = decideWeb({ state: 'absent' }, 'darwin');
    expect(d.code).not.toBe(0);
    expect(d.open).toBeUndefined();
    expect(d.stderr).toContain('buildd service install');
  });

  test('a stale socket counts as no runner', () => {
    expect(decideWeb({ state: 'stale' }, 'linux').open).toBeUndefined();
  });

  test('a runner with a web UI: opens its localhost URL', () => {
    const d = decideWeb({ state: 'live', httpPort: 8766 }, 'darwin');
    expect(d.code).toBe(0);
    expect(d.open).toEqual(['open', 'http://localhost:8766']);
    expect(d.stdout).toContain('http://localhost:8766');
  });

  test('linux opens with xdg-open, another platform only prints the URL', () => {
    expect(decideWeb({ state: 'live', httpPort: 9000 }, 'linux').open).toEqual(['xdg-open', 'http://localhost:9000']);
    const other = decideWeb({ state: 'live', httpPort: 9000 }, 'win32');
    expect(other.open).toBeUndefined();
    expect(other.stdout).toContain('http://localhost:9000');
  });

  test('a runner without a web UI: one line on how to turn it on, nothing opened', () => {
    const d = decideWeb({ state: 'live', httpPort: null }, 'darwin');
    expect(d.open).toBeUndefined();
    expect(d.code).not.toBe(0);
    expect(d.stderr).toBe(WEB_OFF_HINT);
    expect(WEB_OFF_HINT.split('\n')).toHaveLength(1);
    expect(WEB_OFF_HINT).toContain('buildd service install --debug');
    // One runner per machine: a second `buildd --debug` would be refused, so it is not offered.
    expect(WEB_OFF_HINT).not.toContain('buildd --debug');
  });
});

describe('readRunnerHttpPort', () => {
  test('nothing at the path is absent', async () => {
    expect(await readRunnerHttpPort(tempSocket())).toEqual({ state: 'absent' });
  });

  test('a plain file is stale', async () => {
    const p = tempSocket();
    writeFileSync(p, '');
    expect(await readRunnerHttpPort(p)).toEqual({ state: 'stale' });
  });

  test('reads the port a live runner reports, or null when it serves none', async () => {
    const withUi = tempSocket();
    serveIdentity(withUi, 8766);
    expect(await readRunnerHttpPort(withUi)).toEqual({ state: 'live', httpPort: 8766 });

    const headless = tempSocket();
    serveIdentity(headless, null);
    expect(await readRunnerHttpPort(headless)).toEqual({ state: 'live', httpPort: null });
  });
});

describe('runWebCommand', () => {
  test('opens the browser through the injected opener, never restarts anything', async () => {
    const socketPath = tempSocket();
    serveIdentity(socketPath, 8766);
    const spawned: string[][] = [];
    const out: string[] = [];
    const code = await runWebCommand({ socketPath, platform: 'darwin', spawn: (cmd) => { spawned.push(cmd); }, log: (m) => out.push(m), error: (m) => out.push(m) });
    expect(code).toBe(0);
    expect(spawned).toEqual([['open', 'http://localhost:8766']]);
  });

  test('a headless runner: prints the hint and spawns nothing', async () => {
    const socketPath = tempSocket();
    serveIdentity(socketPath, null);
    const spawned: string[][] = [];
    const errs: string[] = [];
    const code = await runWebCommand({ socketPath, platform: 'darwin', spawn: (cmd) => { spawned.push(cmd); }, log: () => {}, error: (m) => errs.push(m) });
    expect(code).not.toBe(0);
    expect(spawned).toEqual([]);
    expect(errs).toEqual([WEB_OFF_HINT]);
  });

  test('a failing opener still leaves the URL on screen', async () => {
    const socketPath = tempSocket();
    serveIdentity(socketPath, 8766);
    const out: string[] = [];
    const code = await runWebCommand({ socketPath, platform: 'linux', spawn: () => { throw new Error('no xdg-open'); }, log: (m) => out.push(m), error: (m) => out.push(m) });
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('http://localhost:8766');
  });
});
