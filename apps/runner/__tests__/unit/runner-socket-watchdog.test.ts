/**
 * The runner socket's watchdog. A runner was seen accepting connections on
 * runner.sock and never answering any of them, /health included, while the
 * rest of the process heartbeated and claimed normally. `buildd top`, `hold`
 * and `stop` all lost the runner. /health awaits nothing, so the stall sat
 * below the handler: the runner now probes its own socket, says loudly which
 * requests are still open when it stops answering, and rebinds it.
 *
 * Every socket lives in a fresh temp dir; nothing here touches ~/.buildd or
 * starts a real runner.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  checkSocketHealth,
  createSocketWatchdog,
  enqueueEvent,
  runnerProcessFromProbe,
  serveRunnerSocket,
  SSE_MAX_QUEUED_EVENTS,
  socketHealthCheck,
  type RunnerSocketServer,
} from '../../src/runner-socket';

// Unix socket paths are capped near 104 bytes on macOS, so keep the dir short.
let dir: string;
let sock: string;
const servers: RunnerSocketServer[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rsw-'));
  sock = join(dir, 'runner.sock');
});

afterEach(() => {
  for (const s of servers.splice(0)) s.stop();
  rmSync(dir, { recursive: true, force: true });
});

function serve(fetch: (req: Request) => Response | Promise<Response>): RunnerSocketServer {
  const s = serveRunnerSocket(sock, fetch);
  servers.push(s);
  return s;
}

const never = () => new Promise<Response>(() => {});

describe('serveRunnerSocket in-flight requests', () => {
  test('lists a request whose handler has not answered, and drops it once it has', async () => {
    let release: (r: Response) => void = () => {};
    const s = serve((req) => {
      if (new URL(req.url).pathname === '/api/workers') return new Promise<Response>(r => { release = r; });
      return new Response('ok');
    });
    const pending = fetch('http://localhost/api/workers?view=top', { unix: sock } as RequestInit);
    const deadline = Date.now() + 2_000;
    while (s.inFlight().length === 0 && Date.now() < deadline) await Bun.sleep(10);
    const [open] = s.inFlight();
    expect(open).toMatchObject({ method: 'GET', path: '/api/workers' });
    expect(open.ageMs).toBeGreaterThanOrEqual(0);

    release(new Response('done'));
    expect(await (await pending).text()).toBe('done');
    expect(s.inFlight()).toEqual([]);
  });

  test('a handler that throws is not left in the list', async () => {
    const s = serveRunnerSocket(sock, async () => { throw new Error('boom'); }, {
      error: () => new Response('handled', { status: 500 }),
    });
    servers.push(s);
    const res = await fetch('http://localhost/x', { unix: sock } as RequestInit);
    expect(res.status).toBe(500);
    expect(s.inFlight()).toEqual([]);
  });
});

describe('serveRunnerSocket rebind', () => {
  test('closes the open connections and answers again on the same owner-only path', async () => {
    let wedged = true;
    const s = serve((req) => {
      const path = new URL(req.url).pathname;
      if (path === '/api/events') {
        return new Response(new ReadableStream({
          start(c) { c.enqueue(new TextEncoder().encode('data: {"type":"init"}\n\n')); },
        }), { headers: { 'Content-Type': 'text/event-stream' } });
      }
      if (wedged) return never();
      return Response.json({ alive: true });
    });

    const events = await fetch('http://localhost/api/events', { unix: sock } as RequestInit);
    const reader = events.body!.getReader();
    await reader.read();
    const hung = fetch('http://localhost/health', { unix: sock } as RequestInit).then(() => 'answered', () => 'closed');
    await Bun.sleep(50);

    wedged = false;
    s.rebind();

    // The stream and the hung request were cut, not left open on the old server.
    expect(await hung).toBe('closed');
    const end = await Promise.race([reader.read().then(r => r.done, () => true), Bun.sleep(2_000).then(() => 'still open')]);
    expect(end).toBe(true);

    expect(statSync(sock).mode & 0o777).toBe(0o600);
    expect(await (await fetch('http://localhost/health', { unix: sock } as RequestInit)).json()).toEqual({ alive: true });
    expect(s.inFlight()).toEqual([]);
  });

  test('stop after a rebind still removes the socket', () => {
    const s = serve(() => new Response('ok'));
    s.rebind();
    servers.splice(servers.indexOf(s), 1);
    s.stop();
    expect(existsSync(sock)).toBe(false);
  });
});

describe('checkSocketHealth', () => {
  test('answering, any status: the socket is serving', async () => {
    serve(() => Response.json({ error: 'starting' }, { status: 503 }));
    expect(await checkSocketHealth(sock, 1_000)).toMatchObject({ ok: true, status: 503 });
  });

  test('accepted but never answered is a timeout, within the timeout', async () => {
    serve(never);
    const started = Date.now();
    const result = await checkSocketHealth(sock, 300);
    expect(result).toMatchObject({ ok: false, reason: 'timeout' });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test('no socket at all is reported as such', async () => {
    expect(await checkSocketHealth(join(dir, 'gone.sock'), 300)).toMatchObject({ ok: false, reason: 'absent' });
  });
});

describe('createSocketWatchdog', () => {
  function fakeServer(open: Array<{ method: string; path: string; ageMs: number }> = []) {
    const calls = { rebind: 0 };
    return {
      calls,
      server: {
        path: '/tmp/fake.sock',
        stop() {},
        rebind() { calls.rebind++; },
        inFlight: () => open,
        pendingRequests: () => open.length,
      } satisfies RunnerSocketServer,
    };
  }

  function logs() {
    const lines: string[] = [];
    return { lines, log: (m: string) => lines.push(`log ${m}`), warn: (m: string) => lines.push(`warn ${m}`) };
  }

  test('a socket that answers is left alone and nothing is logged', async () => {
    const { server, calls } = fakeServer();
    const out = logs();
    const wd = createSocketWatchdog({ server, ...out, probe: async () => ({ ok: true, status: 200, ms: 3 }) });
    await wd.tick();
    await wd.tick();
    expect(calls.rebind).toBe(0);
    expect(out.lines).toEqual([]);
    expect(wd.state().consecutiveFailures).toBe(0);
  });

  test('one missed probe is reported loudly with the open requests, but not rebound yet', async () => {
    const { server, calls } = fakeServer([{ method: 'GET', path: '/api/events', ageMs: 3_600_000 }, { method: 'GET', path: '/health', ageMs: 5_000 }]);
    const out = logs();
    const wd = createSocketWatchdog({ server, ...out, failuresBeforeRebind: 2, probe: async () => ({ ok: false, reason: 'timeout', ms: 5_000 }) });
    await wd.tick();
    expect(calls.rebind).toBe(0);
    const line = out.lines.join('\n');
    expect(line).toContain('warn [runner-socket]');
    expect(line).toContain('/tmp/fake.sock');
    expect(line).toContain('timeout');
    expect(line).toContain('GET /api/events');
    expect(line).toContain('GET /health');
  });

  test('a socket that keeps not answering is rebound, then probed again', async () => {
    const { server, calls } = fakeServer();
    const out = logs();
    let answering = false;
    server.rebind = () => { calls.rebind++; answering = true; };
    const wd = createSocketWatchdog({
      server, ...out, failuresBeforeRebind: 2,
      probe: async () => answering ? { ok: true, status: 200, ms: 2 } : { ok: false, reason: 'timeout', ms: 5_000 },
    });
    await wd.tick();
    const result = await wd.tick();
    expect(calls.rebind).toBe(1);
    expect(result).toBe('rebound');
    expect(out.lines.join('\n')).toMatch(/rebound .* answers again/);
    expect(wd.state()).toMatchObject({ consecutiveFailures: 0, rebinds: 1 });
  });

  test('a rebind that does not help says so, and tries again after the next misses', async () => {
    const { server, calls } = fakeServer();
    const out = logs();
    const wd = createSocketWatchdog({ server, ...out, failuresBeforeRebind: 2, probe: async () => ({ ok: false, reason: 'timeout', ms: 5_000 }) });
    for (let i = 0; i < 4; i++) await wd.tick();
    expect(calls.rebind).toBe(2);
    expect(out.lines.join('\n')).toContain('still does not answer after the rebind');
  });

  test('a rebind that throws is logged, never thrown', async () => {
    const { server } = fakeServer();
    server.rebind = () => { throw new Error('EADDRINUSE'); };
    const out = logs();
    const wd = createSocketWatchdog({ server, ...out, failuresBeforeRebind: 1, probe: async () => ({ ok: false, reason: 'timeout', ms: 5_000 }) });
    expect(await wd.tick()).toBe('rebind-failed');
    expect(out.lines.join('\n')).toContain('EADDRINUSE');
  });

  test('recovering on its own is logged once', async () => {
    const { server } = fakeServer();
    const out = logs();
    let ok = false;
    const wd = createSocketWatchdog({ server, ...out, failuresBeforeRebind: 3, probe: async () => ok ? { ok: true, status: 200, ms: 1 } : { ok: false, reason: 'timeout', ms: 5_000 } });
    await wd.tick();
    ok = true;
    await wd.tick();
    await wd.tick();
    expect(out.lines.filter(l => l.includes('answers again'))).toHaveLength(1);
  });

  test('end to end: a wedged real socket is found and rebound', async () => {
    let wedged = true;
    const real = serve(() => wedged ? never() : Response.json({ alive: true }));
    const out = logs();
    const server: RunnerSocketServer = { ...real, rebind: () => { wedged = false; real.rebind(); } };
    const wd = createSocketWatchdog({ server, ...out, timeoutMs: 300, failuresBeforeRebind: 2 });
    expect(await wd.tick()).toBe('failed');
    expect(out.lines.join('\n')).toContain('GET /health');
    expect(await wd.tick()).toBe('rebound');
    expect(await checkSocketHealth(sock, 1_000)).toMatchObject({ ok: true, status: 200 });
  });
});

describe('socketHealthCheck (the doctor\'s runner-process line, in the runner)', () => {
  test('answering is ok and names the socket', () => {
    expect(socketHealthCheck({ socketPath: '/h/runner.sock', consecutiveFailures: 0, rebinds: 0, lastFailure: null })).toMatchObject({
      name: 'runner-process', status: 'ok',
    });
  });

  test('not answering is an error with the reason, and is not left to the doctor to "fix"', () => {
    const check = socketHealthCheck({ socketPath: '/h/runner.sock', consecutiveFailures: 2, rebinds: 1, lastFailure: 'timeout' });
    expect(check.status).toBe('error');
    expect(check.message).toContain('/h/runner.sock');
    expect(check.message).toContain('timeout');
    expect(check.fixable).toBeFalsy();
  });

  test('no socket served is a warning, not a missing process', () => {
    expect(socketHealthCheck(null)).toMatchObject({ name: 'runner-process', status: 'warn' });
  });
});

describe('runnerProcessFromProbe (buildd --doctor)', () => {
  test('a runner that answers with its pid is ok, however it was started', () => {
    expect(runnerProcessFromProbe({ state: 'live', pid: 77, version: '1' }, '/h/runner.sock')).toMatchObject({ status: 'ok', message: expect.stringContaining('pid 77') });
  });

  test('a socket held but not answered is named, with how to find its process', () => {
    const check = runnerProcessFromProbe({ state: 'live', pid: null, version: null }, '/h/runner.sock');
    expect(check.status).toBe('error');
    expect(check.message).toContain('lsof /h/runner.sock');
  });

  test('nothing there is an error, never auto-"fixed"', () => {
    for (const state of ['absent', 'stale'] as const) {
      const check = runnerProcessFromProbe({ state }, '/h/runner.sock');
      expect(check.status).toBe('error');
      expect(check.fixable).toBeFalsy();
    }
  });
});

describe('enqueueEvent (event stream readers)', () => {
  function controller(desiredSize: number | null) {
    const c = { closed: false, queued: 0, desiredSize, enqueue() { c.queued++; }, close() { c.closed = true; }, error() {} };
    return c;
  }

  test('a reader keeping up gets the event', () => {
    const c = controller(1);
    expect(enqueueEvent(c as unknown as ReadableStreamDefaultController, new Uint8Array([1]))).toBe(true);
    expect(c.queued).toBe(1);
  });

  test('a reader that stopped reading is closed once its queue passes the cap, not queued for forever', () => {
    const c = controller(-(SSE_MAX_QUEUED_EVENTS + 1));
    expect(enqueueEvent(c as unknown as ReadableStreamDefaultController, new Uint8Array([1]))).toBe(false);
    expect(c.closed).toBe(true);
    expect(c.queued).toBe(0);
  });

  test('a reader already gone is dropped', () => {
    const c = { desiredSize: 1, enqueue() { throw new TypeError('closed'); }, close() {} };
    expect(enqueueEvent(c as unknown as ReadableStreamDefaultController, new Uint8Array([1]))).toBe(false);
  });
});
