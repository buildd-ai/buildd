import { describe, expect, test } from 'bun:test';
import { RpcError } from '../../src/acp/bridge';
import { notification, rpcLineHandler, rpcPeer } from '../../src/acp/rpc';
import { githubRepoFromRemote, localPathFor, repoNamesFromRemote, socketRunnerPort } from '../../src/acp/runner-port';
import { fileSessionLinks } from '../../src/acp/links';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
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

  test('the agent can ask the client and gets the matching response back', async () => {
    const out: any[] = [];
    const peer = rpcPeer({ handle: async () => null }, (f) => out.push(JSON.parse(f)));
    const a = peer.request('elicitation/create', { q: 1 });
    const b = peer.request('elicitation/create', { q: 2 });
    expect(out.map(o => [o.method, o.params.q])).toEqual([['elicitation/create', 1], ['elicitation/create', 2]]);
    expect(out[0].id).not.toBe(out[1].id);
    // answered out of order, one with an error
    await peer.onLine(JSON.stringify({ jsonrpc: '2.0', id: out[1].id, error: { code: -32000, message: 'declined by client' } }));
    await peer.onLine(JSON.stringify({ jsonrpc: '2.0', id: out[0].id, result: { action: 'accept' } }));
    expect(await a).toEqual({ action: 'accept' });
    await expect(b).rejects.toThrow('declined by client');
  });

  test('a client request that reuses one of our ids is still handled as a request', async () => {
    const out: any[] = [];
    const peer = rpcPeer({ handle: async (m) => ({ m }) }, (f) => out.push(JSON.parse(f)));
    const mine = peer.request('elicitation/create', {});
    const id = out[0].id;
    await peer.onLine(JSON.stringify({ jsonrpc: '2.0', id, method: 'initialize' }));
    expect(out[1]).toEqual({ jsonrpc: '2.0', id, result: { m: 'initialize' } });
    await peer.onLine(JSON.stringify({ jsonrpc: '2.0', id, result: 'ok' }));
    expect(await mine).toBe('ok');
  });

  test('notification frames are one JSON line', () => {
    expect(notification('session/update', { sessionId: 's' })).toBe('{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s"}}\n');
  });
});

describe('fileSessionLinks', () => {
  test('links persist across instances and answer both ways', () => {
    const dir = mkdtempSync(join(tmpdir(), 'acp-links-'));
    try {
      const a = fileSessionLinks(join(dir, 'acp-sessions.json'));
      a.set('new-1', 'w1');
      const b = fileSessionLinks(join(dir, 'acp-sessions.json'));
      expect(b.get('new-1')).toBe('w1');
      expect(b.sessionFor!('w1')).toBe('new-1');
      expect(b.get('nope')).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('a missing or corrupt file is an empty store, and the oldest links go past the cap', () => {
    const dir = mkdtempSync(join(tmpdir(), 'acp-links-'));
    try {
      const path = join(dir, 'acp-sessions.json');
      writeFileSync(path, '{not json');
      const s = fileSessionLinks(path, { max: 2 });
      expect(s.get('x')).toBeNull();
      s.set('s1', 'w1'); s.set('s2', 'w2'); s.set('s3', 'w3');
      const again = fileSessionLinks(path, { max: 2 });
      expect([again.get('s1'), again.get('s2'), again.get('s3')]).toEqual([null, 'w2', 'w3']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('project identity', () => {
  test('repo names come from any origin URL shape', () => {
    expect(repoNamesFromRemote('git@github.com:acme/app.git')).toEqual(['app', 'acme/app']);
    expect(repoNamesFromRemote('https://github.com/acme/app')).toEqual(['app', 'acme/app']);
    expect(repoNamesFromRemote('https://github.com/acme/app.git/')).toEqual(['app', 'acme/app']);
    expect(repoNamesFromRemote('not a url')).toEqual([]);
  });

  test('the GitHub repo comes only from a github.com origin', () => {
    expect(githubRepoFromRemote('git@github.com:acme/app.git')).toBe('acme/app');
    expect(githubRepoFromRemote('https://github.com/Acme/app')).toBe('Acme/app');
    expect(githubRepoFromRemote('ssh://git@github.com/acme/app.git/')).toBe('acme/app');
    expect(githubRepoFromRemote('https://token@github.com/acme/app.git')).toBe('acme/app');
    expect(githubRepoFromRemote('git@gitlab.com:acme/app.git')).toBeNull();
    expect(githubRepoFromRemote('https://github.com.evil.example/acme/app')).toBeNull();
    expect(githubRepoFromRemote('not a url')).toBeNull();
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
