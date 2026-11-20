import { describe, expect, test } from 'bun:test';
import { RpcError } from '../../src/acp/bridge';
import { notification, rpcLineHandler } from '../../src/acp/rpc';
import { localPathFor, repoNamesFromRemote, socketRunnerPort } from '../../src/acp/runner-port';
import type { SocketClient } from '../../src/top/client';

function rpc(handle: (method: string, params: any) => Promise<unknown>) {
  const out: any[] = [];
  const onLine = rpcLineHandler({ handle }, (frame) => {
    expect(frame.endsWith('\n')).toBe(true);
    out.push(JSON.parse(frame));
  });
  return { out, onLine };
}

describe('rpcLineHandler', () => {
  test('a request gets its result under the same id', async () => {
    const { out, onLine } = rpc(async (m, p) => ({ echoed: m, p }));
    await onLine(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'initialize', params: { a: 1 } }));
    expect(out).toEqual([{ jsonrpc: '2.0', id: 7, result: { echoed: 'initialize', p: { a: 1 } } }]);
  });

  test('a notification is handled and answered with nothing', async () => {
    const seen: string[] = [];
    const { out, onLine } = rpc(async (m) => { seen.push(m); return null; });
    await onLine(JSON.stringify({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 's' } }));
    expect(seen).toEqual(['session/cancel']);
    expect(out).toEqual([]);
  });

  test('errors keep their JSON-RPC code; anything else is internal', async () => {
    const { out, onLine } = rpc(async (m) => {
      if (m === 'nope') throw new RpcError(-32601, 'no such method');
      throw new Error('boom');
    });
    await onLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'nope' }));
    await onLine(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'x' }));
    expect(out[0]).toMatchObject({ id: 1, error: { code: -32601, message: 'no such method' } });
    expect(out[1]).toMatchObject({ id: 2, error: { code: -32603, message: 'boom' } });
  });

  test('a malformed line is a parse error; blank lines and stray responses are ignored', async () => {
    const { out, onLine } = rpc(async () => null);
    await onLine('{not json');
    await onLine('   ');
    await onLine(JSON.stringify({ jsonrpc: '2.0', id: 9, result: {} }));
    expect(out).toEqual([{ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }]);
  });

  test('requests run concurrently, so a cancel is not stuck behind an open prompt', async () => {
    let release!: () => void;
    const { out, onLine } = rpc(async (m) => {
      if (m === 'session/prompt') await new Promise<void>(r => { release = r; });
      return { m };
    });
    const prompt = onLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'session/prompt' }));
    await onLine(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'initialize' }));
    expect(out.map(o => o.id)).toEqual([2]);
    release();
    await prompt;
    expect(out.map(o => o.id)).toEqual([2, 1]);
  });

  test('notification frames are one JSON line', () => {
    expect(notification('session/update', { sessionId: 's' })).toBe('{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s"}}\n');
  });
});

describe('project identity', () => {
  test('repo names come from any origin URL shape', () => {
    expect(repoNamesFromRemote('git@github.com:acme/app.git')).toEqual(['app', 'acme/app']);
    expect(repoNamesFromRemote('https://github.com/acme/app')).toEqual(['app', 'acme/app']);
    expect(repoNamesFromRemote('https://github.com/acme/app.git/')).toEqual(['app', 'acme/app']);
    expect(repoNamesFromRemote('not a url')).toEqual([]);
  });

  test('a Windows path is read through /mnt on Linux, untouched on Windows', () => {
    expect(localPathFor('C:\\code\\app', 'linux')).toBe('/mnt/c/code/app');
    expect(localPathFor('C:\\code\\app', 'win32')).toBe('C:\\code\\app');
    expect(localPathFor('/home/me/app', 'linux')).toBe('/home/me/app');
  });
});

describe('socketRunnerPort', () => {
  function fakeClient() {
    const posts: Array<{ path: string; body: unknown }> = [];
    let emit: ((e: any) => void) | null = null;
    let streams = 0;
    const client: SocketClient = {
      async get(path) {
        expect(path).toBe('/api/workers');
        return { status: 200, body: { workers: [{ id: 'w1', status: 'working' }] } as any };
      },
      async post(path, body) { posts.push({ path, body }); return { status: 200, body: { ok: true } }; },
      events(onEvent, signal) {
        streams++;
        emit = onEvent;
        return new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
      },
    };
    return { client, posts, emit: (e: any) => emit?.(e), streams: () => streams };
  }

  test('actions go to the routes top uses; a follow-up goes to /send', async () => {
    const f = fakeClient();
    const port = socketRunnerPort('/unused', f.client);
    await port.act('w 1', 'answer', 'yes');
    await port.act('w1', 'pause');
    await port.act('w1', 'followup', 'again');
    expect(f.posts).toEqual([
      { path: '/api/workers/w%201/answer', body: { message: 'yes' } },
      { path: '/api/workers/w1/pause', body: {} },
      { path: '/api/workers/w1/send', body: { message: 'again' } },
    ]);
    expect(await port.listWorkers()).toEqual([{ id: 'w1', status: 'working' }] as any);
  });

  test('one event stream feeds every subscriber, and closes with the last one', async () => {
    const f = fakeClient();
    const port = socketRunnerPort('/unused', f.client);
    const a: string[] = [];
    const b: string[] = [];
    const offA = port.subscribe(w => a.push(`${w.id}:${w.status}`));
    const offB = port.subscribe(w => b.push(`${w.id}:${w.status}`));
    await Promise.resolve();
    f.emit({ type: 'init', workers: [{ id: 'w1', status: 'working' }] });
    f.emit({ type: 'worker_update', worker: { id: 'w1', status: 'done' } });
    f.emit({ type: 'slots', slots: 2 });
    expect(a).toEqual(['w1:working', 'w1:done']);
    expect(b).toEqual(a);
    expect(f.streams()).toBe(1);
    offA();
    offB();
    port.subscribe(() => {});
    await Promise.resolve();
    expect(f.streams()).toBe(2);
  });
});
