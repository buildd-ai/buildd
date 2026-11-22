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

/**
 * A stand-in runner for the matrix: several workers, a claim handler the test
 * chooses, and a restart that drops every event stream and comes back on the
 * same socket path.
 */
function matrixRunner(socketPath: string, opts: {
  workers?: Worker[];
  workspaces?: Worker[];
  claim?: (body: any) => { status: number; body: unknown };
} = {}) {
  const workers = new Map<string, Worker>((opts.workers ?? []).map(w => [w.id, w]));
  const streams = new Set<ReadableStreamDefaultController>();
  const posts: Array<{ path: string; body: any }> = [];
  const enc = new TextEncoder();
  let taskSeq = 0;
  const serve = () => Bun.serve({
    unix: socketPath,
    // an event stream is long-lived; the default 10 s idle timeout would cut it
    idleTimeout: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === '/api/workers') return Response.json({ workers: [...workers.values()] });
      if (path === '/api/workspaces') return Response.json({ workspaces: opts.workspaces ?? [] });
      if (path === '/api/tasks' && req.method === 'POST') {
        const body = await req.json();
        posts.push({ path, body });
        return Response.json({ task: { id: `t-${++taskSeq}`, title: body.title } });
      }
      if (path === '/api/claim' && req.method === 'POST') {
        const body = await req.json();
        posts.push({ path, body });
        const r = opts.claim?.(body) ?? { status: 200, body: { worker: { id: `w-${body.taskId}`, taskId: body.taskId, workspaceName: 'shop', status: 'working', messages: [] } } };
        const w = (r.body as any)?.worker;
        if (r.status < 400 && w) workers.set(w.id, w);
        return Response.json(r.body, { status: r.status });
      }
      if (path === '/api/events') {
        let ctrl!: ReadableStreamDefaultController;
        const stream = new ReadableStream({
          start(c) { ctrl = c; streams.add(c); c.enqueue(enc.encode(`data: ${JSON.stringify({ type: 'init', workers: [...workers.values()] })}\n\n`)); },
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
  let server: ReturnType<typeof Bun.serve> | null = serve();
  const down = () => {
    for (const c of streams) { try { c.close(); } catch {} }
    streams.clear();
    server?.stop(true);
    server = null;
    rmSync(socketPath, { force: true });
  };
  return {
    posts,
    workers,
    subscribers: () => streams.size,
    push(next: Worker) {
      workers.set(next.id, next);
      const frame = `data: ${JSON.stringify({ type: 'worker_update', worker: next })}\n\n`;
      for (const c of streams) c.enqueue(enc.encode(frame));
    },
    /** The runner process goes away: its socket closes and every stream drops. */
    down,
    up() { server = serve(); },
    stop() { if (server) down(); },
  };
}

function setup(runnerOpts: Parameters<typeof matrixRunner>[1] = {}, answerForm: (p: any) => any = () => ({ action: 'cancel' })) {
  const dir = mkdtempSync(join(tmpdir(), 'acp-m-'));
  const sock = join(dir, 'r.sock');
  const runner = matrixRunner(sock, runnerOpts);
  const clients: Array<ReturnType<typeof acpClient>> = [];
  const open = () => { const c = acpClient(sock, dir, answerForm); clients.push(c); return c; };
  cleanup.push(() => runner.stop(), () => clients.forEach(c => c.proc.kill()), () => rmSync(dir, { recursive: true, force: true }));
  return { dir, sock, runner, open };
}

const said = (client: ReturnType<typeof acpClient>, sessionId?: string) =>
  client.updates
    .filter(u => u.update.sessionUpdate === 'agent_message_chunk' && (sessionId === undefined || u.sessionId === sessionId))
    .map(u => u.update.content.text as string);

const sendCancel = (client: ReturnType<typeof acpClient>, sessionId: string) => {
  client.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } })}\n`);
  client.proc.stdin.flush();
};

/** Resolve with the turn's response, or with `timedOut` when the bridge never ends it. */
const within = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, Bun.sleep(ms).then(() => 'timedOut' as const)]);

const T3_ENVELOPE = (request: string) => [
  '<t3_code_instructions>',
  'You are running inside T3 Code. Use the T3 tools listed below.',
  '</t3_code_instructions>',
  '<runtime_info>',
  'platform: darwin; shell: zsh',
  '</runtime_info>',
  '<pull_request_linking>',
  'When you open a PR, link it with the T3 PR tool.',
  '</pull_request_linking>',
  '<user_request>',
  request,
  '</user_request>',
].join('\n');

/**
 * The T3 → buildd interaction matrix. One test per flow a T3 thread drives,
 * each tied to the requirement in docs/specs/acp-bridge.md it checks. A case
 * that fails today is `test.failing` with the requirement and what happens
 * instead; the follow-up fix flips it to `test`.
 */
describe('T3 → buildd interaction matrix (spec acp-bridge)', () => {
  // 1. Prompt envelope (AC-1, "userTextFrom", "taskTitleFrom") + Reservation
  //    ("filed reserved … then claimed by id", AC-9) + Follow-ups ("A turn lasts while
  //    the worker is working … end_turn").
  test('1. first prompt in a new thread: envelope stripped, task filed with the clean title, claimed here, turn streams, end_turn', async () => {
    const { dir, runner, open } = setup({ workspaces: [{ id: 'ws-shop', name: 'shop', repo: 'acme/shop' }] });
    const client = open();
    await client.call('initialize', { protocolVersion: 1, clientCapabilities: {} });
    const { result: { sessionId } } = await client.call('session/new', { cwd: join(dir, 'shop'), mcpServers: [] });
    expect(sessionId).toStartWith('new-');

    const request = 'Add a coupon field to checkout\n\nIt should accept codes like SAVE10.';
    const turn = client.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: T3_ENVELOPE(request) }] });
    await until(() => runner.subscribers() === 1);

    expect(runner.posts).toEqual([
      { path: '/api/tasks', body: { workspaceId: 'ws-shop', title: 'Add a coupon field to checkout', description: request, reserve: true } },
      { path: '/api/claim', body: { taskId: 't-1' } },
    ]);
    expect(said(client, sessionId)).toContain('Started a buildd task in shop: “Add a coupon field to checkout”.');

    runner.push({ id: 'w-t-1', status: 'working', messages: [{ type: 'text', content: 'Reading checkout.tsx', timestamp: 2 }] });
    runner.push({ id: 'w-t-1', status: 'working', messages: [
      { type: 'text', content: 'Reading checkout.tsx', timestamp: 2 },
      { type: 'tool_use', name: 'Edit', input: { file_path: '/shop/checkout.tsx', old_string: 'a', new_string: 'b' }, timestamp: 3 },
    ] });
    runner.push({ id: 'w-t-1', status: 'done', prUrl: 'https://example.test/pr/9', messages: [
      { type: 'text', content: 'Reading checkout.tsx', timestamp: 2 },
      { type: 'tool_use', name: 'Edit', input: { file_path: '/shop/checkout.tsx', old_string: 'a', new_string: 'b' }, timestamp: 3 },
    ] });
    expect((await turn).result.stopReason).toBe('end_turn');
    expect(said(client, sessionId)).toContain('Reading checkout.tsx');
    expect(client.updates.some(u => u.update.sessionUpdate === 'tool_call' && u.update.kind === 'edit')).toBe(true);
    expect(said(client, sessionId).at(-1)).toBe('Finished. PR: https://example.test/pr/9');
    // nothing from the envelope reached buildd
    expect(JSON.stringify(runner.posts)).not.toContain('t3_code_instructions');
    expect(client.stray).toEqual([]);
  }, 20_000);

  // 2. Follow-ups table: status `done` → route `followup` → local /send that resumes the
  //    worker's session (AC-3, done row).
  test('2. follow-up on a finished run resumes the worker session', async () => {
    const { dir, runner, open } = setup({ workers: [{ id: 'w1', status: 'done', worktreePath: '/x/app', workspaceName: 'app', messages: [{ type: 'text', content: 'Done first pass', timestamp: 1 }] }] });
    const client = open();
    await client.call('initialize', { protocolVersion: 1, clientCapabilities: {} });
    await client.call('session/load', { sessionId: 'w1', cwd: dir, mcpServers: [] });

    const turn = client.call('session/prompt', { sessionId: 'w1', prompt: [{ type: 'text', text: T3_ENVELOPE('Also handle expired codes') }] });
    await until(() => runner.posts.length === 1);
    expect(runner.posts[0]).toEqual({ path: '/api/workers/w1/send', body: { message: 'Also handle expired codes' } });
    // a settled worker that has not moved yet must not end the turn on its old state
    await until(() => runner.subscribers() === 1);
    await Bun.sleep(150);
    runner.push({ id: 'w1', status: 'working', messages: [{ type: 'text', content: 'Done first pass', timestamp: 1 }, { type: 'text', content: 'Handling expiry', timestamp: 5 }] });
    runner.push({ id: 'w1', status: 'done', messages: [{ type: 'text', content: 'Done first pass', timestamp: 1 }, { type: 'text', content: 'Handling expiry', timestamp: 5 }] });
    expect((await turn).result.stopReason).toBe('end_turn');
    const lines = said(client, 'w1');
    expect(lines).toContain('Handling expiry');
    expect(lines.filter(l => l === 'Done first pass')).toHaveLength(1); // replayed by load, not re-sent live
    expect(lines.at(-1)).toBe('Finished.');
  }, 20_000);

  // 3. "/stop, /pause, /watch": /pause and /stop relay the action and end that prompt with
  //    their line; /watch follows without sending anything. The watching turn ends when
  //    the worker settles (paused = waiting/pause, stopped = error).
  test('3. /stop mid-turn, /pause and /watch', async () => {
    const { dir, runner, open } = setup({ workers: [
      { id: 'w1', status: 'working', worktreePath: '/x/a', messages: [] },
      { id: 'w2', status: 'working', worktreePath: '/x/b', messages: [] },
    ] });
    const client = open();
    await client.call('initialize', { protocolVersion: 1, clientCapabilities: {} });
    await client.call('session/load', { sessionId: 'w1', cwd: dir, mcpServers: [] });
    await client.call('session/load', { sessionId: 'w2', cwd: dir, mcpServers: [] });

    // /watch sends nothing and keeps the turn open while the worker works
    const watch1 = client.call('session/prompt', { sessionId: 'w1', prompt: [{ type: 'text', text: '/watch' }] });
    await until(() => runner.subscribers() === 1);
    await Bun.sleep(100);
    expect(runner.posts).toEqual([]);

    // /stop while that turn is open
    const stop = await client.call('session/prompt', { sessionId: 'w1', prompt: [{ type: 'text', text: '/stop' }] });
    expect(stop.result.stopReason).toBe('end_turn');
    expect(runner.posts).toEqual([{ path: '/api/workers/w1/stop', body: {} }]);
    expect(said(client, 'w1')).toContain('Stopping the run.');
    runner.push({ id: 'w1', status: 'error', error: 'Aborted by user', messages: [] });
    expect((await watch1).result.stopReason).toBe('end_turn');
    expect(said(client, 'w1').at(-1)).toBe('Stopped with an error: Aborted by user');

    // /pause while another worker's turn is open
    const watch2 = client.call('session/prompt', { sessionId: 'w2', prompt: [{ type: 'text', text: '/watch' }] });
    await until(() => runner.subscribers() === 1);
    const pause = await client.call('session/prompt', { sessionId: 'w2', prompt: [{ type: 'text', text: '/pause' }] });
    expect(pause.result.stopReason).toBe('end_turn');
    expect(runner.posts.at(-1)).toEqual({ path: '/api/workers/w2/pause', body: {} });
    expect(said(client, 'w2')).toContain('Pausing at the next safe point.');
    runner.push({ id: 'w2', status: 'waiting', waitingFor: { type: 'pause', prompt: 'Paused', since: '2026-11-22T00:00:00Z', context: 'You paused this run.' }, messages: [] });
    expect((await watch2).result.stopReason).toBe('end_turn');
    expect(said(client, 'w2').at(-1)).toBe('Paused. Reply here to resume it.');
  }, 20_000);

  // 4. Follow-ups: "A question … that arises during a turn is asked as a form … and the
  //    run is followed on after the answer. A declined or unsupported form ends the turn
  //    on the question; the next typed reply answers it." (AC-3, waiting row)
  test('4. a waiting_input question shown as a form, answered, run continues; declined, the typed reply answers it', async () => {
    let decline = false;
    const { dir, runner, open } = setup(
      { workers: [{ id: 'w1', status: 'working', worktreePath: '/x/a', messages: [] }] },
      (p) => (decline ? { action: 'decline' } : { action: 'accept', content: { answer: p.requestedSchema.properties.answer.oneOf?.[1]?.const ?? 'yes' } }),
    );
    const client = open();
    await client.call('initialize', { protocolVersion: 1, clientCapabilities: { elicitation: { form: {} } } });
    await client.call('session/load', { sessionId: 'w1', cwd: dir, mcpServers: [] });

    // a steering message opens the turn (route `message`)
    const turn = client.call('session/prompt', { sessionId: 'w1', prompt: [{ type: 'text', text: 'Prefer the smaller change' }] });
    await until(() => runner.posts.length === 1);
    expect(runner.posts[0]).toEqual({ path: '/api/workers/w1/message', body: { message: 'Prefer the smaller change' } });
    await until(() => runner.subscribers() === 1);

    runner.push({ id: 'w1', status: 'waiting', waitingFor: { type: 'question', prompt: 'Which cache?', since: 's1', options: [{ label: 'Redis' }, { label: 'In-memory' }] }, messages: [] });
    await until(() => runner.posts.length === 2);
    expect(client.forms[0]).toMatchObject({ sessionId: 'w1', mode: 'form', message: 'Which cache?' });
    expect(runner.posts[1]).toEqual({ path: '/api/workers/w1/answer', body: { message: 'In-memory' } });
    // the runner echoes the answered wait once before moving on: no second form
    runner.push({ id: 'w1', status: 'waiting', waitingFor: { type: 'question', prompt: 'Which cache?', since: 's1', options: [{ label: 'Redis' }, { label: 'In-memory' }] }, messages: [] });
    runner.push({ id: 'w1', status: 'working', messages: [{ type: 'text', content: 'Using an in-memory cache', timestamp: 4 }] });
    await until(() => said(client, 'w1').includes('Using an in-memory cache'));
    expect(client.forms).toHaveLength(1);

    // a second question, declined: the turn ends on the question text
    decline = true;
    runner.push({ id: 'w1', status: 'waiting', waitingFor: { type: 'question', prompt: 'Ship now?', since: 's2' }, messages: [{ type: 'text', content: 'Using an in-memory cache', timestamp: 4 }] });
    const res = await turn;
    expect(res.result.stopReason).toBe('end_turn');
    expect(said(client, 'w1').at(-1)).toContain('**Question:** Ship now?');
    // the next typed reply answers that question
    const reply = client.call('session/prompt', { sessionId: 'w1', prompt: [{ type: 'text', text: 'Yes, ship it' }] });
    await until(() => runner.posts.length === 3);
    expect(runner.posts[2]).toEqual({ path: '/api/workers/w1/answer', body: { message: 'Yes, ship it' } });
    await until(() => runner.subscribers() === 1);
    runner.push({ id: 'w1', status: 'working', messages: [] });
    runner.push({ id: 'w1', status: 'done', messages: [] });
    expect((await reply).result.stopReason).toBe('end_turn');
  }, 20_000);

  // 5. "session/cancel on an open turn MUST send pause (not stop) and end the turn as
  //    cancelled with 'Pausing the run. Reply to resume it.' The next reply on a paused
  //    worker resumes it." (AC-5)
  test('5. session/cancel mid-turn: stopReason cancelled, worker paused, next reply resumes it', async () => {
    const { dir, runner, open } = setup({ workers: [{ id: 'w1', status: 'working', worktreePath: '/x/a', messages: [] }] });
    const client = open();
    await client.call('initialize', { protocolVersion: 1, clientCapabilities: {} });
    await client.call('session/load', { sessionId: 'w1', cwd: dir, mcpServers: [] });
    const turn = client.call('session/prompt', { sessionId: 'w1', prompt: [{ type: 'text', text: 'Keep going' }] });
    await until(() => runner.subscribers() === 1);
    sendCancel(client, 'w1');
    const res = await turn;
    expect(res.result.stopReason).toBe('cancelled');
    expect(said(client, 'w1').at(-1)).toBe('Pausing the run. Reply to resume it.');
    await until(() => runner.posts.length === 2);
    expect(runner.posts).toEqual([
      { path: '/api/workers/w1/message', body: { message: 'Keep going' } },
      { path: '/api/workers/w1/pause', body: {} },
    ]);
    expect(runner.posts.some(p => p.path.endsWith('/stop'))).toBe(false);

    // the runner pauses it; the next reply goes to the open wait (the pause) and resumes it
    runner.push({ id: 'w1', status: 'waiting', waitingFor: { type: 'pause', prompt: 'Paused', since: 'p1', options: [{ label: 'Resume' }] }, messages: [] });
    const resume = client.call('session/prompt', { sessionId: 'w1', prompt: [{ type: 'text', text: 'Resume' }] });
    await until(() => runner.posts.length === 3);
    expect(runner.posts[2]).toEqual({ path: '/api/workers/w1/answer', body: { message: 'Resume' } });
    await until(() => runner.subscribers() === 1);
    runner.push({ id: 'w1', status: 'working', messages: [] });
    runner.push({ id: 'w1', status: 'done', messages: [] });
    expect((await resume).result.stopReason).toBe('end_turn');
  }, 20_000);

  // 6. Session identity: each thread is its own worker; updates are routed by
  //    `session/update.sessionId`. Two threads streaming at once share one runner
  //    event stream and must not see each other's run.
  test('6. two concurrent sessions in different threads: no cross-talk', async () => {
    const { runner, open } = setup({ workers: [
      { id: 'wa', status: 'working', worktreePath: '/x/a', messages: [] },
      { id: 'wb', status: 'working', worktreePath: '/x/b', messages: [] },
    ] });
    const client = open();
    await client.call('initialize', { protocolVersion: 1, clientCapabilities: {} });
    await client.call('session/load', { sessionId: 'wa', cwd: '/x/a', mcpServers: [] });
    await client.call('session/load', { sessionId: 'wb', cwd: '/x/b', mcpServers: [] });
    const turnA = client.call('session/prompt', { sessionId: 'wa', prompt: [{ type: 'text', text: '/watch' }] });
    const turnB = client.call('session/prompt', { sessionId: 'wb', prompt: [{ type: 'text', text: '/watch' }] });
    // one shared stream from the runner, two listeners
    await until(() => runner.subscribers() === 1);

    runner.push({ id: 'wa', status: 'working', messages: [{ type: 'text', content: 'A: step 1', timestamp: 1 }] });
    runner.push({ id: 'wb', status: 'working', messages: [{ type: 'text', content: 'B: step 1', timestamp: 1 }] });
    runner.push({ id: 'wa', status: 'done', messages: [{ type: 'text', content: 'A: step 1', timestamp: 1 }] });
    expect((await turnA).result.stopReason).toBe('end_turn');
    // A's turn closing must not close the stream B is still reading
    await Bun.sleep(100);
    expect(runner.subscribers()).toBe(1);
    runner.push({ id: 'wb', status: 'working', messages: [{ type: 'text', content: 'B: step 1', timestamp: 1 }, { type: 'text', content: 'B: step 2', timestamp: 2 }] });
    runner.push({ id: 'wb', status: 'done', messages: [{ type: 'text', content: 'B: step 1', timestamp: 1 }, { type: 'text', content: 'B: step 2', timestamp: 2 }] });
    expect((await turnB).result.stopReason).toBe('end_turn');

    const a = said(client, 'wa');
    const b = said(client, 'wb');
    expect(a).toEqual(['A: step 1', 'Finished.']);
    expect(b).toEqual(['B: step 1', 'B: step 2', 'Finished.']);
    await until(() => runner.subscribers() === 0);
  }, 20_000);

  // 7. Restart: the runner's event stream drops and the port reconnects
  //    (runner-port.ts RECONNECT_MS). "A turn lasts while the worker is working. It ends
  //    the first time the worker is not working … with a closing line from settledText";
  //    "After a restart, a prompt or session/load for a linked id MUST resolve to its
  //    worker" (AC-6).
  test('7a. runner restart mid-turn: stream reconnects, the turn resumes and ends, the thread link survives', async () => {
    const { dir, runner, open } = setup({ workspaces: [{ id: 'ws-shop', name: 'shop' }] });
    const client = open();
    await client.call('initialize', { protocolVersion: 1, clientCapabilities: {} });
    const project = join(dir, 'shop');
    const { result: { sessionId } } = await client.call('session/new', { cwd: project, mcpServers: [] });
    const turn = client.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Add search' }] });
    await until(() => runner.subscribers() === 1);
    runner.push({ id: 'w-t-1', workspaceName: 'shop', status: 'working', messages: [{ type: 'text', content: 'before restart', timestamp: 1 }] });
    await until(() => said(client, sessionId).includes('before restart'));

    runner.down();
    await Bun.sleep(300);
    runner.up();
    // the port reconnects on its own; the init frame carries the worker as it is now
    await until(() => runner.subscribers() === 1, 6_000);
    runner.push({ id: 'w-t-1', workspaceName: 'shop', status: 'working', messages: [{ type: 'text', content: 'before restart', timestamp: 1 }, { type: 'text', content: 'after restart', timestamp: 2 }] });
    runner.push({ id: 'w-t-1', workspaceName: 'shop', status: 'done', messages: [{ type: 'text', content: 'before restart', timestamp: 1 }, { type: 'text', content: 'after restart', timestamp: 2 }] });
    expect((await turn).result.stopReason).toBe('end_turn');
    const lines = said(client, sessionId);
    expect(lines.filter(l => l === 'before restart')).toHaveLength(1);
    expect(lines).toContain('after restart');
    expect(lines.at(-1)).toBe('Finished.');

    const listed = await client.call('session/list', { cwd: project });
    expect(listed.result.sessions.map((s: any) => s.sessionId)).toEqual([sessionId]);
    expect(client.stray).toEqual([]);
  }, 20_000);

  test('7b. runner restart mid-turn: the run finished while the stream was down, the reconnect ends the turn', async () => {
    const { dir, runner, open } = setup({ workers: [{ id: 'w1', status: 'working', worktreePath: '/x/a', messages: [] }] });
    const client = open();
    await client.call('initialize', { protocolVersion: 1, clientCapabilities: {} });
    await client.call('session/load', { sessionId: 'w1', cwd: dir, mcpServers: [] });
    const turn = client.call('session/prompt', { sessionId: 'w1', prompt: [{ type: 'text', text: '/watch' }] });
    await until(() => runner.subscribers() === 1);
    runner.down();
    runner.workers.set('w1', { id: 'w1', status: 'done', prUrl: 'https://example.test/pr/2', messages: [] });
    runner.up();
    const res = await within(turn, 6_000);
    expect(res).not.toBe('timedOut');
    expect((res as any).result.stopReason).toBe('end_turn');
    expect(said(client, 'w1').at(-1)).toBe('Finished. PR: https://example.test/pr/2');
  }, 20_000);

  // FAILS TODAY. Requirement: "A turn … ends … with a closing line from settledText" and
  // "A user-visible failure MUST be an agent_message_chunk that ends the turn" (Invariants).
  // The runner pauses an in-flight run when it restarts (pause.ts pausedWaitingFor
  // cause 'shutdown', R-37) and says why in `waitingFor.context`. The turn does end, but on
  // "Paused. Reply here to resume it." alone: waitingText drops the context for a pause
  // (translate.ts:209), so the thread never says the runner restarted.
  test.failing('7c. runner restart mid-turn: a run the restart paused ends the turn saying the runner restarted', async () => {
    const { dir, runner, open } = setup({ workers: [{ id: 'w1', status: 'working', worktreePath: '/x/a', messages: [] }] });
    const client = open();
    await client.call('initialize', { protocolVersion: 1, clientCapabilities: {} });
    await client.call('session/load', { sessionId: 'w1', cwd: dir, mcpServers: [] });
    const turn = client.call('session/prompt', { sessionId: 'w1', prompt: [{ type: 'text', text: '/watch' }] });
    await until(() => runner.subscribers() === 1);
    runner.down();
    runner.workers.set('w1', { id: 'w1', status: 'waiting', worktreePath: '/x/a', messages: [], waitingFor: {
      type: 'pause', prompt: 'Paused', since: 'r1',
      context: 'The runner stopped or restarted, so it paused this run. Its worktree, uncommitted work and session are kept.',
      options: [{ label: 'Resume', recommended: true }],
    } });
    runner.up();
    const res = await within(turn, 6_000);
    expect(res).not.toBe('timedOut');
    expect((res as any).result.stopReason).toBe('end_turn');
    expect(said(client, 'w1').at(-1)).toContain('restarted');
  }, 20_000);

  // Same requirement as 7c. When the restarted runner no longer has the
  // worker (its init frame and updates never name it), nothing ever settles the turn: the
  // bridge only ends a turn from an update for that worker (bridge.ts:428-441) and has no
  // check on reconnect, so the T3 thread spins forever with no message.
  test('7d. runner restart mid-turn: a worker the restarted runner no longer has ends the turn with a clear message', async () => {
    const { dir, runner, open } = setup({ workers: [{ id: 'w1', status: 'working', worktreePath: '/x/a', messages: [] }] });
    const client = open();
    await client.call('initialize', { protocolVersion: 1, clientCapabilities: {} });
    await client.call('session/load', { sessionId: 'w1', cwd: dir, mcpServers: [] });
    const turn = client.call('session/prompt', { sessionId: 'w1', prompt: [{ type: 'text', text: '/watch' }] });
    await until(() => runner.subscribers() === 1);
    runner.down();
    runner.workers.delete('w1');
    runner.up();
    await until(() => runner.subscribers() === 1, 6_000);
    const res = await within(turn, 4_000);
    expect(res).not.toBe('timedOut');
    expect(said(client, 'w1').at(-1)).toBe('This worker is no longer on this runner.');
  }, 20_000);

  // 8. Reservation: "The task is filed reserved for the filing runner's account for 20
  //    minutes, then claimed by id" (AC-9, CG-7); "If the claim is refused, the thread MUST
  //    say the task is queued and why, and the task stays held for this runner until the
  //    lease lapses, then is free for any runner." The lease itself is the server's
  //    (claim-candidate-where.ts, pinned by apps/web/src/lib/claim-candidate-where.test.ts);
  //    here the stand-in models it from CG-7 so the test checks what the bridge must do
  //    for it to hold: file reserved, name the hold, store no link, and not touch the
  //    task again (no cancel, no unreserve, no second claim).
  test('8. reservation: claim refused (slots full), the thread names the 20-minute hold, after expiry another runner may claim', async () => {
    const HOLD_MS = 20 * 60_000;
    const lease = new Map<string, { until: number }>();
    let now = 0;
    const { dir, runner, open } = setup({
      workspaces: [{ id: 'ws-shop', name: 'shop' }],
      claim: () => ({ status: 400, body: { error: 'All 2 worker slots are busy' } }),
    });
    const client = open();
    await client.call('initialize', { protocolVersion: 1, clientCapabilities: {} });
    const project = join(dir, 'shop');
    const { result: { sessionId } } = await client.call('session/new', { cwd: project, mcpServers: [] });
    const res = await client.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: T3_ENVELOPE('Fix the cart total') }] });

    expect(res.result.stopReason).toBe('end_turn');
    expect(runner.posts).toEqual([
      { path: '/api/tasks', body: { workspaceId: 'ws-shop', title: 'Fix the cart total', description: 'Fix the cart total', reserve: true } },
      { path: '/api/claim', body: { taskId: 't-1' } },
    ]);
    const line = said(client, sessionId).at(-1)!;
    expect(line).toContain('Created the buildd task “Fix the cart total” in shop.');
    expect(line).toContain('held for this runner for 20 minutes, then any runner can take it');
    expect(line).toContain('The runner refused that (400): All 2 worker slots are busy.');
    // no worker, so no link: the thread is not listed as a run
    expect((await client.call('session/list', { cwd: project })).result.sessions).toEqual([]);

    // CG-7, as the server applies it to the reserve:true the bridge sent
    const filed = runner.posts[0].body;
    if (filed.reserve) lease.set('t-1', { until: now + HOLD_MS });
    const otherRunnerMayClaim = (taskId: string) => !lease.has(taskId) || now >= lease.get(taskId)!.until;
    now += HOLD_MS - 1;
    expect(otherRunnerMayClaim('t-1')).toBe(false);
    now += 1;
    expect(otherRunnerMayClaim('t-1')).toBe(true);

    // the bridge left the task alone after the refusal, so the lease runs its course
    await Bun.sleep(200);
    expect(runner.posts).toHaveLength(2);
  }, 20_000);
});
