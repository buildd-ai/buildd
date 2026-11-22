/**
 * `buildd acp` end to end: the real entry (src/acp/main.ts) as a child process,
 * an ACP client on its stdio, and a stand-in runner on a real unix socket
 * serving the routes the bridge uses (/api/workers, /api/events SSE, worker
 * actions). Covers what the in-process tests cannot: framing on real stdio,
 * the socket client, SSE parsing, and an elicitation round trip.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const MAIN = join(import.meta.dir, '..', '..', 'src', 'acp', 'main.ts');

type Worker = Record<string, any>;

function fakeRunner(socketPath: string, initial: Worker | null, opts: { workspaces?: Worker[] } = {}) {
  let worker = initial;
  const streams = new Set<ReadableStreamDefaultController>();
  const posts: Array<{ path: string; body: any }> = [];
  const enc = new TextEncoder();
  const server = Bun.serve({
    unix: socketPath,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === '/api/workers') return Response.json({ workers: worker ? [worker] : [] });
      if (path === '/api/workspaces') return Response.json({ workspaces: opts.workspaces ?? [] });
      if (path === '/api/tasks' && req.method === 'POST') {
        const body = await req.json();
        posts.push({ path, body });
        return Response.json({ task: { id: 't-new', title: body.title } });
      }
      if (path === '/api/claim' && req.method === 'POST') {
        const body = await req.json();
        posts.push({ path, body });
        worker = { id: 'w-new', taskId: body.taskId, workspaceName: 'shop', status: 'working', messages: [] };
        return Response.json({ worker });
      }
      if (path === '/api/events') {
        let ctrl!: ReadableStreamDefaultController;
        const stream = new ReadableStream({
          start(c) { ctrl = c; streams.add(c); c.enqueue(enc.encode(`data: ${JSON.stringify({ type: 'init', workers: [worker] })}\n\n`)); },
          cancel() { streams.delete(ctrl); },
        });
        return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
      }
      if (req.method === 'POST') {
        posts.push({ path, body: await req.json().catch(() => ({})) });
        return Response.json({ ok: true });
      }
      return new Response('not found', { status: 404 });
    },
  });
  return {
    posts,
    subscribers: () => streams.size,
    push(next: Worker) {
      worker = next;
      // split one frame across two writes: the client must reassemble it
      const frame = `data: ${JSON.stringify({ type: 'worker_update', worker })}\n\n`;
      for (const c of streams) { c.enqueue(enc.encode(frame.slice(0, 7))); c.enqueue(enc.encode(frame.slice(7))); }
    },
    stop() { server.stop(true); },
  };
}

function acpClient(socketPath: string, home: string, answerForm: (params: any) => any) {
  const proc = Bun.spawn(['bun', 'run', MAIN], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    // A test runtime must never touch the real runner home (buildd-home.ts).
    env: { ...process.env, BUILDD_HOME: home, BUILDD_RUNNER_SOCKET: socketPath },
  });
  const pending = new Map<number, (m: any) => void>();
  // If the bridge dies, fail every open call with its stderr instead of timing out.
  void proc.exited.then(async (code) => {
    const err = await new Response(proc.stderr).text().catch(() => '');
    for (const [, resolve] of pending) resolve({ error: { message: `bridge exited ${code}: ${err.slice(-500)}` } });
    pending.clear();
  });
  const updates: any[] = [];
  const forms: any[] = [];
  const stray: string[] = [];
  let id = 0;
  const write = (msg: unknown) => { proc.stdin.write(`${JSON.stringify(msg)}\n`); proc.stdin.flush(); };
  void (async () => {
    let buf = '';
    const dec = new TextDecoder();
    for await (const chunk of proc.stdout) {
      buf += dec.decode(chunk);
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let m: any;
        try { m = JSON.parse(line); } catch { stray.push(line); continue; }
        if (m.method === 'session/update') updates.push(m.params);
        else if (m.method === 'elicitation/create') { forms.push(m.params); write({ jsonrpc: '2.0', id: m.id, result: answerForm(m.params) }); }
        else if (m.id != null && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); }
      }
    }
  })();
  return {
    proc,
    updates,
    forms,
    stray,
    call(method: string, params: unknown): Promise<any> {
      const n = ++id;
      return new Promise((resolve) => { pending.set(n, resolve); write({ jsonrpc: '2.0', id: n, method, params }); });
    },
  };
}

async function until(cond: () => boolean, ms = 5_000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await Bun.sleep(10);
  }
}

let cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.reverse()) { try { fn(); } catch {} } cleanup = []; });

describe('buildd acp end to end', () => {
  test('follow a run, answer its question in a form, see it finish', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'acp-'));
    const sock = join(dir, 'r.sock');
    const runner = fakeRunner(sock, {
      id: 'w1', status: 'working', taskTitle: 'Pick a database', workspaceName: 'app',
      worktreePath: join(dir, 'app'), lastActivity: 1, messages: [{ type: 'text', content: 'Starting', timestamp: 1 }],
    });
    const client = acpClient(sock, dir, () => ({ action: 'accept', content: { answer: 'SQLite' } }));
    cleanup.push(() => runner.stop(), () => client.proc.kill(), () => rmSync(dir, { recursive: true, force: true }));

    const init = await client.call('initialize', { protocolVersion: 1, clientCapabilities: { elicitation: { form: {} } } });
    expect(init.result.agentCapabilities.loadSession).toBe(true);

    const list = await client.call('session/list', { cwd: dir });
    expect(list.result.sessions.map((s: any) => s.sessionId)).toEqual(['w1']);

    await client.call('session/load', { sessionId: 'w1', cwd: dir, mcpServers: [] });
    expect(client.updates.some(u => u.update.content?.text === 'Starting')).toBe(true);

    const turn = client.call('session/prompt', { sessionId: 'w1', prompt: [{ type: 'text', text: '/watch' }] });
    await until(() => runner.subscribers() === 1);

    runner.push({ id: 'w1', status: 'working', messages: [
      { type: 'text', content: 'Starting', timestamp: 1 },
      { type: 'tool_use', name: 'Edit', input: { file_path: '/app/db.ts', old_string: 'pg', new_string: '?' }, timestamp: 2 },
    ] });
    await until(() => client.updates.some(u => u.update.sessionUpdate === 'tool_call'));
    const tool = client.updates.find(u => u.update.sessionUpdate === 'tool_call').update;
    expect(tool).toMatchObject({ kind: 'edit', status: 'in_progress', content: [{ type: 'diff', path: '/app/db.ts' }] });

    runner.push({ id: 'w1', status: 'waiting', waitingFor: { type: 'question', prompt: 'Which DB?', options: [{ label: 'Postgres' }, { label: 'SQLite' }] }, messages: [] });
    await until(() => runner.posts.length === 1);
    expect(client.forms[0]).toMatchObject({ sessionId: 'w1', mode: 'form', message: 'Which DB?' });
    expect(runner.posts[0]).toEqual({ path: '/api/workers/w1/answer', body: { message: 'SQLite' } });

    runner.push({ id: 'w1', status: 'working', messages: [{ type: 'text', content: 'Going with SQLite', timestamp: 3 }] });
    runner.push({ id: 'w1', status: 'done', prUrl: 'https://example.test/pr/1', tokenTally: { inputTokens: 3, outputTokens: 2 }, messages: [{ type: 'text', content: 'Going with SQLite', timestamp: 3 }] });

    const res = await turn;
    expect(res.result.stopReason).toBe('end_turn');
    expect(res.result.usage).toEqual({ inputTokens: 3, outputTokens: 2, totalTokens: 5 });
    const said = client.updates.filter(u => u.update.sessionUpdate === 'agent_message_chunk').map(u => u.update.content.text);
    expect(said).toContain('Going with SQLite');
    expect(said.at(-1)).toBe('Finished. PR: https://example.test/pr/1');
    // the turn's event stream closes with the turn
    await until(() => runner.subscribers() === 0);
    // nothing but protocol frames on stdout
    expect(client.stray).toEqual([]);
  }, 20_000);

  test('a new thread starts a task, and a restarted bridge still knows the thread is that worker', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'acp-'));
    const sock = join(dir, 'r.sock');
    const project = join(dir, 'shop');
    const runner = fakeRunner(sock, null, { workspaces: [{ id: 'ws-shop', name: 'shop', repo: 'acme/shop' }, { id: 'ws-other', name: 'other' }] });
    let client = acpClient(sock, dir, () => ({ action: 'cancel' }));
    cleanup.push(() => runner.stop(), () => client.proc.kill(), () => rmSync(dir, { recursive: true, force: true }));

    await client.call('initialize', { protocolVersion: 1, clientCapabilities: {} });
    const created = await client.call('session/new', { cwd: project, mcpServers: [] });
    const sessionId = created.result.sessionId;
    const turn = client.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Add a coupon field' }] });
    await until(() => runner.subscribers() === 1);
    expect(runner.posts).toEqual([
      { path: '/api/tasks', body: { workspaceId: 'ws-shop', title: 'Add a coupon field', description: 'Add a coupon field', reserve: true } },
      { path: '/api/claim', body: { taskId: 't-new' } },
    ]);
    runner.push({ id: 'w-new', workspaceName: 'shop', status: 'done', messages: [{ type: 'text', content: 'Added it', timestamp: 2 }] });
    expect((await turn).result.stopReason).toBe('end_turn');

    // T3 restarts its agent: a new bridge process, the same buildd home
    client.proc.kill();
    await client.proc.exited;
    client = acpClient(sock, dir, () => ({ action: 'cancel' }));
    await client.call('initialize', { protocolVersion: 1, clientCapabilities: {} });
    const listed = await client.call('session/list', { cwd: project });
    expect(listed.result.sessions.map((s: any) => s.sessionId)).toEqual([sessionId]);
    await client.call('session/load', { sessionId, cwd: project, mcpServers: [] });
    expect(client.updates.some(u => u.update.content?.text === 'Added it')).toBe(true);
    const again = client.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Add a coupon field' }] });
    await until(() => runner.posts.length === 3);
    expect(runner.posts[2]).toEqual({ path: '/api/workers/w-new/send', body: { message: 'Add a coupon field' } });
    runner.push({ id: 'w-new', status: 'working', messages: [] });
    runner.push({ id: 'w-new', status: 'done', messages: [] });
    await again;
  }, 20_000);

  test('cancel pauses the run through the runner', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'acp-'));
    const sock = join(dir, 'r.sock');
    const runner = fakeRunner(sock, { id: 'w1', status: 'working', worktreePath: join(dir, 'app'), messages: [] });
    const client = acpClient(sock, dir, () => ({ action: 'cancel' }));
    cleanup.push(() => runner.stop(), () => client.proc.kill(), () => rmSync(dir, { recursive: true, force: true }));

    await client.call('initialize', { protocolVersion: 1, clientCapabilities: {} });
    await client.call('session/load', { sessionId: 'w1', cwd: dir, mcpServers: [] });
    const turn = client.call('session/prompt', { sessionId: 'w1', prompt: [{ type: 'text', text: '/watch' }] });
    await until(() => runner.subscribers() === 1);
    client.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 'w1' } })}\n`);
    client.proc.stdin.flush();
    const res = await turn;
    expect(res.result.stopReason).toBe('cancelled');
    await until(() => runner.posts.length === 1);
    expect(runner.posts[0]).toEqual({ path: '/api/workers/w1/pause', body: {} });
  }, 20_000);
});
