/**
 * One runner per machine (Living Spec "Runner on your terminal", R-11..R-13):
 * the socket probe, stale-socket removal, and the start/refuse decision.
 *
 * Every socket lives in a fresh temp dir; nothing here touches ~/.buildd or
 * starts a real runner.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, lstatSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  EXIT_ALREADY_RUNNING,
  alreadyRunningMessage,
  checkSingleInstance,
  decideStart,
  matchWorkerAction,
  ownerOnlyAclCommand,
  parseWhoamiSid,
  probeRunnerSocket,
  relayWorkerAction,
  restrictSocketToOwner,
  runnerSocketPath,
  serveRunnerSocket,
  type RunnerSocketServer,
} from '../../src/runner-socket';

// Unix socket paths are capped near 104 bytes on macOS, so keep the dir short.
let dir: string;
let sock: string;
const servers: RunnerSocketServer[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rs-'));
  sock = join(dir, 'runner.sock');
});

afterEach(() => {
  for (const s of servers.splice(0)) s.stop();
  rmSync(dir, { recursive: true, force: true });
});

function serveIdentity(pid = 4242): RunnerSocketServer {
  const s = serveRunnerSocket(sock, (req) => {
    const path = new URL(req.url).pathname;
    if (path === '/api/runner') return Response.json({ pid, version: '9.9.9' });
    return new Response('Not found', { status: 404 });
  });
  servers.push(s);
  return s;
}

/** A socket file left by a process that died without cleaning up. */
async function makeStaleSocket(path: string): Promise<void> {
  const child = Bun.spawn(['bun', '-e', `Bun.serve({ unix: ${JSON.stringify(path)}, fetch() { return new Response('x'); } }); setInterval(() => {}, 1000);`], {
    stdout: 'ignore', stderr: 'ignore',
  });
  const deadline = Date.now() + 10_000;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error('child never bound the socket');
    await Bun.sleep(25);
  }
  child.kill('SIGKILL');
  await child.exited;
  // Windows: Bun cannot lstat a socket (EACCES), so only check the file is left.
  if (process.platform === 'win32') expect(existsSync(path)).toBe(true);
  else expect(lstatSync(path).isSocket()).toBe(true);
}

describe('runnerSocketPath', () => {
  test('lives under BUILDD_HOME', () => {
    expect(runnerSocketPath('/h/.buildd', {})).toBe(join('/h/.buildd', 'runner.sock'));
  });
  test('BUILDD_RUNNER_SOCKET overrides it', () => {
    expect(runnerSocketPath('/h/.buildd', { BUILDD_RUNNER_SOCKET: '/x/r.sock' })).toBe('/x/r.sock');
  });
});

describe('serveRunnerSocket', () => {
  // Windows has no mode bits: chmod is a no-op there and `mode` says nothing.
  test.skipIf(process.platform === 'win32')('is owner-only (0600)', () => {
    serveIdentity();
    expect(statSync(sock).mode & 0o777).toBe(0o600);
  });

  test('stop removes the socket', () => {
    const s = serveIdentity();
    servers.splice(servers.indexOf(s), 1);
    s.stop();
    expect(existsSync(sock)).toBe(false);
  });

  test('serves the handler, SSE included', async () => {
    const s = serveRunnerSocket(sock, (req) => {
      if (new URL(req.url).pathname === '/api/events') {
        return new Response(new ReadableStream({
          start(c) { c.enqueue(new TextEncoder().encode('data: {"type":"init"}\n\n')); },
        }), { headers: { 'Content-Type': 'text/event-stream' } });
      }
      return new Response('Not found', { status: 404 });
    });
    servers.push(s);
    const res = await fetch('http://localhost/api/events', { unix: sock } as RequestInit);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toContain('"type":"init"');
    await reader.cancel();
  });

  test('a second serve on a live socket fails and leaves the first runner answering', async () => {
    serveIdentity(4242);
    expect(() => serveRunnerSocket(sock, () => Response.json({ pid: 5151 }))).toThrow();
    expect(await probeRunnerSocket(sock)).toEqual({ state: 'live', pid: 4242, version: '9.9.9' });
  });
});

// Windows AF_UNIX connect needs write access in the socket file's DACL, the way
// POSIX connect needs the w bit. chmod does nothing there, so without an
// explicit ACL the socket inherits its directory's: a BUILDD_HOME or
// BUILDD_RUNNER_SOCKET outside the profile (C:\ gives BUILTIN\Users Modify on
// new folders) would let every local account drive the runner.
describe('owner-only socket on Windows', () => {
  const SID = 'S-1-5-21-1-2-3-1001';

  test('reads the SID from whoami /user /fo csv /nh', () => {
    expect(parseWhoamiSid('"host\\someone","S-1-5-21-1-2-3-1001"\r\n')).toBe('S-1-5-21-1-2-3-1001');
    expect(parseWhoamiSid('')).toBeNull();
    expect(parseWhoamiSid('"host\\someone","not-a-sid"')).toBeNull();
  });

  test('the ACL drops inheritance and grants the owner alone', () => {
    expect(ownerOnlyAclCommand('C:\\h\\runner.sock', SID)).toEqual([
      'icacls', 'C:\\h\\runner.sock', '/inheritance:r', '/grant:r', `*${SID}:(F)`,
    ]);
  });

  test('POSIX: chmod 0600, no icacls', () => {
    const calls: string[] = [];
    restrictSocketToOwner('/h/runner.sock', {
      platform: 'linux',
      chmod: (p, m) => { calls.push(`chmod ${p} ${m.toString(8)}`); },
      run: (argv) => { calls.push(argv.join(' ')); return { exitCode: 0, output: '' }; },
      sid: () => SID,
    });
    expect(calls).toEqual(['chmod /h/runner.sock 600']);
  });

  test('POSIX: a failed chmod is not fatal (the 0177 umask already applied)', () => {
    expect(() => restrictSocketToOwner('/h/runner.sock', {
      platform: 'darwin',
      chmod: () => { throw new Error('EPERM'); },
    })).not.toThrow();
  });

  test('Windows: runs icacls with the owner SID', () => {
    const calls: string[][] = [];
    restrictSocketToOwner('C:\\h\\runner.sock', {
      platform: 'win32',
      chmod: () => { throw new Error('chmod must not be the boundary on Windows'); },
      run: (argv) => { calls.push(argv); return { exitCode: 0, output: 'Successfully processed 1 files' }; },
      sid: () => SID,
    });
    expect(calls).toEqual([ownerOnlyAclCommand('C:\\h\\runner.sock', SID)]);
  });

  test('Windows: an icacls failure throws, so the socket is never served open', () => {
    expect(() => restrictSocketToOwner('C:\\h\\runner.sock', {
      platform: 'win32',
      run: () => ({ exitCode: 5, output: 'Access is denied.' }),
      sid: () => SID,
    })).toThrow(/Access is denied/);
  });

  test('Windows: no SID throws', () => {
    expect(() => restrictSocketToOwner('C:\\h\\runner.sock', {
      platform: 'win32',
      run: () => ({ exitCode: 0, output: '' }),
      sid: () => null,
    })).toThrow(/SID/);
  });

  test('a socket that cannot be restricted is not left behind, and the path stays free', async () => {
    expect(() => serveRunnerSocket(sock, () => new Response('x'), {
      restrict: () => { throw new Error('icacls failed'); },
    })).toThrow(/icacls failed/);
    expect(existsSync(sock)).toBe(false);
    serveIdentity();
    // Fetch, not probeRunnerSocket: Bun cannot lstat a socket on Windows.
    expect((await fetch('http://localhost/api/runner', { unix: sock } as RequestInit)).status).toBe(200);
  });

  test.skipIf(process.platform !== 'win32')('Windows: in a directory every user may write, the socket grants only its owner', async () => {
    // Make the temp dir behave like C:\buildd: BUILTIN\Users may modify what is created in it.
    expect(Bun.spawnSync(['icacls', dir, '/grant', '*S-1-5-32-545:(OI)(CI)(M)']).exitCode).toBe(0);
    serveIdentity();
    const acl = new TextDecoder().decode(Bun.spawnSync(['icacls', sock]).stdout);
    const aces = acl.split(/\r?\n/).filter(l => /:\(/.test(l));
    expect(aces).toHaveLength(1);
    expect(acl).not.toContain('(I)');
    expect(acl).not.toMatch(/BUILTIN\\Users/i);
    // The owner still connects.
    expect((await fetch('http://localhost/api/runner', { unix: sock } as RequestInit)).status).toBe(200);
  });
});

// On Windows Bun's lstatSync/statSync throw EACCES on an AF_UNIX socket, even
// a live one its caller owns, so "lstat threw" must not read as "absent".
describe('a socket Bun cannot lstat (Windows)', () => {
  const eacces = () => { throw Object.assign(new Error('EACCES: permission denied, lstat'), { code: 'EACCES' }); };

  test('a live runner is live, with its pid', async () => {
    serveIdentity(4242);
    expect(await probeRunnerSocket(sock, { lstat: eacces })).toEqual({ state: 'live', pid: 4242, version: '9.9.9' });
  });

  test('a socket file with no process behind it is stale, and checkSingleInstance clears it', async () => {
    await makeStaleSocket(sock);
    expect(await probeRunnerSocket(sock, { lstat: eacces })).toEqual({ state: 'stale' });
    const { decision } = await checkSingleInstance({ socketPath: sock, isTTY: false, foreground: false, lstat: eacces });
    expect(decision).toEqual({ action: 'start' });
    expect(existsSync(sock)).toBe(false);
  });

  test('nothing at the path is still absent', async () => {
    expect(await probeRunnerSocket(join(dir, 'gone.sock'), { lstat: eacces })).toEqual({ state: 'absent' });
  });

  test('ENOENT is absent without a connect', async () => {
    const enoent = () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };
    serveIdentity();
    expect(await probeRunnerSocket(sock, { lstat: enoent })).toEqual({ state: 'absent' });
  });

  test('stop removes the socket even when its inode cannot be read', () => {
    const s = serveRunnerSocket(sock, () => new Response('x'), { stat: eacces });
    s.stop();
    expect(existsSync(sock)).toBe(false);
  });
});

describe('probeRunnerSocket', () => {
  test('absent when there is no file', async () => {
    expect(await probeRunnerSocket(sock)).toEqual({ state: 'absent' });
  });

  test('live, with the pid, when a runner answers', async () => {
    serveIdentity(4242);
    expect(await probeRunnerSocket(sock)).toEqual({ state: 'live', pid: 4242, version: '9.9.9' });
  });

  test('live without a pid when an older runner answers 404', async () => {
    servers.push(serveRunnerSocket(sock, () => new Response('Not found', { status: 404 })));
    expect(await probeRunnerSocket(sock)).toEqual({ state: 'live', pid: null, version: null });
  });

  test('stale when the socket file has no process behind it', async () => {
    await makeStaleSocket(sock);
    expect(await probeRunnerSocket(sock)).toEqual({ state: 'stale' });
  });

  test('stale when the path is not a socket at all', async () => {
    writeFileSync(sock, 'not a socket');
    expect(await probeRunnerSocket(sock)).toEqual({ state: 'stale' });
  });

  test('a process that accepts but never answers counts as live, not stale', async () => {
    const listener = Bun.listen({ unix: sock, socket: { data() { /* never answer */ } } });
    try {
      expect(await probeRunnerSocket(sock, { timeoutMs: 300 })).toEqual({ state: 'live', pid: null, version: null });
    } finally {
      listener.stop(true);
    }
  });
});

describe('decideStart', () => {
  const live = { state: 'live' as const, pid: 77, version: null };

  test('starts when nothing answers', () => {
    expect(decideStart({ probe: { state: 'absent' }, isTTY: true, foreground: false })).toEqual({ action: 'start' });
    expect(decideStart({ probe: { state: 'stale' }, isTTY: false, foreground: true })).toEqual({ action: 'start' });
  });

  test('in a terminal: starts nothing and attaches buildd top (R-12)', () => {
    expect(decideStart({ probe: live, isTTY: true, foreground: false })).toEqual({
      action: 'attach',
      message: 'The background runner is already running (pid 77). This is buildd top, watching it; q leaves it running.',
    });
  });

  test('without a terminal: same message, non-zero', () => {
    const d = decideStart({ probe: live, isTTY: false, foreground: false });
    expect(d).toEqual({ action: 'exit', code: EXIT_ALREADY_RUNNING, stream: 'stderr', message: alreadyRunningMessage(77) });
    expect(EXIT_ALREADY_RUNNING).not.toBe(0);
    // install.sh's launcher restarts on 75 ("update applied"); a refusal must end it.
    expect(EXIT_ALREADY_RUNNING).not.toBe(75);
  });

  test('--foreground is refused the same way, terminal or not', () => {
    for (const isTTY of [true, false]) {
      expect(decideStart({ probe: live, isTTY, foreground: true })).toEqual({
        action: 'exit', code: EXIT_ALREADY_RUNNING, stream: 'stderr', message: alreadyRunningMessage(77),
      });
    }
  });

  test('a runner whose pid is unknown is still named', () => {
    expect(alreadyRunningMessage(null)).toBe('The background runner is already running. Watch it with: buildd top');
  });

  test('a runner that accepts but never answers is named by its socket path', () => {
    expect(alreadyRunningMessage(null, '/h/.buildd/runner.sock')).toBe(
      'The background runner is already running (it holds /h/.buildd/runner.sock but did not answer). Watch it with: buildd top',
    );
    // A known pid is the better name; the path is only the fallback.
    expect(alreadyRunningMessage(77, '/h/.buildd/runner.sock')).toBe(alreadyRunningMessage(77));
  });

  test('decideStart names the socket when the live runner gave no pid', () => {
    const d = decideStart({ probe: { state: 'live', pid: null, version: null }, isTTY: false, foreground: false, socketPath: '/s.sock' });
    expect(d).toMatchObject({ action: 'exit', message: alreadyRunningMessage(null, '/s.sock') });
  });

  test('in a terminal, a runner that never answered is named, not attached (top would show nothing)', () => {
    const d = decideStart({ probe: { state: 'live', pid: null, version: null }, isTTY: true, foreground: false, socketPath: '/s.sock' });
    expect(d).toEqual({ action: 'exit', code: EXIT_ALREADY_RUNNING, stream: 'stderr', message: alreadyRunningMessage(null, '/s.sock') });
  });
});

describe('checkSingleInstance', () => {
  test('a stale socket is removed and the start goes ahead', async () => {
    await makeStaleSocket(sock);
    const logs: string[] = [];
    const r = await checkSingleInstance({ socketPath: sock, isTTY: false, foreground: false, log: m => logs.push(m) });
    expect(r.decision).toEqual({ action: 'start' });
    expect(existsSync(sock)).toBe(false);
    expect(logs.join('\n')).toContain('stale');
  });

  test('a live runner is left alone and the start is refused', async () => {
    serveIdentity(4242);
    const r = await checkSingleInstance({ socketPath: sock, isTTY: false, foreground: false });
    expect(r.decision).toMatchObject({ action: 'exit', code: EXIT_ALREADY_RUNNING });
    expect(existsSync(sock)).toBe(true);
  });

  test('a second runner can bind once the stale socket is cleared', async () => {
    await makeStaleSocket(sock);
    await checkSingleInstance({ socketPath: sock, isTTY: false, foreground: false });
    serveIdentity(99);
    expect(await probeRunnerSocket(sock)).toMatchObject({ state: 'live', pid: 99 });
  });
});

describe('worker actions', () => {
  test('match only the action routes', () => {
    expect(matchWorkerAction('/api/workers/w1/answer')).toEqual({ workerId: 'w1', action: 'answer' });
    expect(matchWorkerAction('/api/workers/w1/stop')).toEqual({ workerId: 'w1', action: 'stop' });
    expect(matchWorkerAction('/api/workers/w1/send')).toBeNull();
    expect(matchWorkerAction('/api/workers/w1/answer/x')).toBeNull();
  });

  test('each action goes to the dashboard route for the same button', async () => {
    const calls: Array<[string, unknown]> = [];
    const send = async (endpoint: string, body: Record<string, unknown>) => { calls.push([endpoint, body]); return { status: 200, body: { ok: true } }; };
    await relayWorkerAction('w1', 'answer', { message: ' yes ' }, send);
    await relayWorkerAction('w1', 'message', { message: 'look at x', priority: 'urgent' }, send);
    await relayWorkerAction('w1', 'pause', {}, send);
    await relayWorkerAction('w1', 'stop', {}, send);
    expect(calls).toEqual([
      ['/api/workers/w1/respond', { message: 'yes' }],
      // /instruct needs a session or admin key and refuses a runner key, so a
      // message rides /cmd, which accepts the key that claimed the worker.
      ['/api/workers/w1/cmd', { action: 'message', text: 'look at x' }],
      ['/api/workers/w1/pause', {}],
      ['/api/workers/w1/cmd', { action: 'abort' }],
    ]);
  });

  test('answer and message need text and never reach the server without it', async () => {
    let sent = false;
    const send = async () => { sent = true; return { status: 200, body: {} }; };
    expect(await relayWorkerAction('w1', 'answer', { message: '  ' }, send)).toEqual({ status: 400, body: { error: 'message required' } });
    expect(await relayWorkerAction('w1', 'message', {}, send)).toMatchObject({ status: 400 });
    expect(sent).toBe(false);
  });

  test('a server refusal comes back untouched', async () => {
    const send = async () => ({ status: 409, body: { error: 'Worker is not running' } });
    expect(await relayWorkerAction('w1', 'pause', {}, send)).toEqual({ status: 409, body: { error: 'Worker is not running' } });
  });
});

describe('BuilddClient.relayDashboardAction', () => {
  test('posts with the runner key and returns a refusal as-is, never throwing', async () => {
    const { BuilddClient } = await import('../../src/buildd');
    const seen: Array<{ path: string; auth: string | null; body: unknown }> = [];
    const srv = Bun.serve({
      port: 0,
      async fetch(req) {
        seen.push({ path: new URL(req.url).pathname, auth: req.headers.get('authorization'), body: await req.json() });
        return Response.json({ error: 'Worker is not waiting' }, { status: 400 });
      },
    });
    try {
      const client = new BuilddClient({ builddServer: `http://127.0.0.1:${srv.port}`, apiKey: 'bld_test' } as any);
      const r = await client.relayDashboardAction('/api/workers/w1/respond', { message: 'yes' });
      expect(r).toEqual({ status: 400, body: { error: 'Worker is not waiting' } });
      expect(seen).toEqual([{ path: '/api/workers/w1/respond', auth: 'Bearer bld_test', body: { message: 'yes' } }]);
    } finally {
      srv.stop(true);
    }
  });

  test('an unreachable server is a 502 with a reason', async () => {
    const { BuilddClient } = await import('../../src/buildd');
    const client = new BuilddClient({ builddServer: 'http://127.0.0.1:1', apiKey: 'bld_test' } as any);
    const r = await client.relayDashboardAction('/api/workers/w1/pause', {});
    expect(r.status).toBe(502);
    expect(String((r.body as any).error)).toContain('unreachable');
  });
});
