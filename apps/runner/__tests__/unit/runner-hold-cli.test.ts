/**
 * `buildd hold` / `resume` / `stop` as a person types them (spec "Runner on
 * your terminal" R-32, R-36): the real entrypoint, a temp BUILDD_HOME, a dead
 * buildd server, and either no runner or a stand-in answering on the runner
 * socket. Never ~/.buildd, never a real runner.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { serveRunnerSocket, type RunnerSocketServer } from '../../src/runner-socket';

const ENTRY = join(import.meta.dir, '../../src/index.ts');
let home: string;
let cwd: string;
let server: RunnerSocketServer | null = null;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'buildd-hold-cli-'));
  cwd = mkdtempSync(join(tmpdir(), 'buildd-hold-cwd-'));
});
afterEach(() => {
  server?.stop();
  server = null;
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

async function buildd(...args: string[]) {
  const proc = Bun.spawn(['bun', ENTRY, ...args], {
    cwd,
    env: { PATH: process.env.PATH ?? '', HOME: home, BUILDD_HOME: home, BUILDD_SERVER: 'http://127.0.0.1:1', NO_COLOR: '1' },
    stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout: stdout.trim(), stderr: stderr.trim(), code };
}

const config = () => (existsSync(join(home, 'config.json')) ? JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')) : null);

describe('with no runner running', () => {
  test('hold saves it for the next start, resume clears it', async () => {
    const h = await buildd('hold');
    expect(h.code).toBe(0);
    expect(h.stdout).toBe('No runner is running on this machine. Saved: the next start is on hold until buildd resume.');
    expect(config().hold.until).toBeNull();
    const r = await buildd('resume');
    expect(r.code).toBe(0);
    expect(config().hold).toBeUndefined();
  }, 30_000);

  test('a bad --for is a usage error', async () => {
    const r = await buildd('hold', '--for', 'soon');
    expect(r.code).toBe(64);
    expect(config()).toBeNull();
  }, 30_000);
});

describe('with a runner answering on its socket', () => {
  test('hold and stop go to the runner; stop asks nothing with --yes', async () => {
    const seen: string[] = [];
    server = serveRunnerSocket(join(home, 'runner.sock'), async (req) => {
      const path = new URL(req.url).pathname + new URL(req.url).search;
      seen.push(`${req.method} ${path}`);
      if (path === '/api/runner') return Response.json({ pid: 4242, version: 'test' });
      if (path === '/api/hold') return Response.json({ hold: { since: new Date().toISOString(), until: null }, running: 1 });
      if (path === '/api/workers?view=top') return Response.json({ workers: [{ id: 'w1', taskTitle: 'name override', status: 'working' }] });
      if (path === '/api/workers/w1/pause' || path === '/api/workers/w1/stop') return Response.json({ ok: true });
      return Response.json({ error: 'Not found' }, { status: 404 });
    });
    const h = await buildd('hold');
    expect(h.stdout).toBe('On hold: nothing new starts. 1 agent still running finishes. buildd resume lifts it.');
    const s = await buildd('stop', '--yes');
    expect(s.code).toBe(0);
    expect(s.stdout).toBe('Paused "name override": it stops at its next safe point and keeps its session.\nOn hold: nothing new starts. buildd resume lifts it and continues the paused agents.');
    expect(seen).toContain('POST /api/workers/w1/pause');
    const a = await buildd('stop', '--abort', '--yes');
    expect(a.stdout).toBe('Stopped "name override".\nOn hold: nothing new starts until buildd resume.');
    expect(seen).toContain('POST /api/workers/w1/stop');
    // The runner keeps the hold; the CLI wrote nothing itself.
    expect(config()).toBeNull();
  }, 30_000);

  test('stop with no terminal and no --yes refuses and stops nothing', async () => {
    const seen: string[] = [];
    server = serveRunnerSocket(join(home, 'runner.sock'), async (req) => {
      const path = new URL(req.url).pathname + new URL(req.url).search;
      seen.push(`${req.method} ${path}`);
      if (path === '/api/runner') return Response.json({ pid: 4242, version: 'test' });
      if (path === '/api/workers?view=top') return Response.json({ workers: [{ id: 'w1', taskTitle: 'name override', status: 'working' }] });
      return Response.json({ ok: true });
    });
    const s = await buildd('stop');
    expect(s.code).toBe(1);
    expect(s.stderr).toContain('add --yes');
    expect(seen.filter(x => x.startsWith('POST'))).toEqual([]);
  }, 30_000);
});
