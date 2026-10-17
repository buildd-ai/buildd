/**
 * The Queue view end to end over a real (temp) runner socket (spec c7410e76
 * R-26, AC-12): Tab reads the queue, another runner claiming position 1 (a
 * pushed `task_claimed`) moves position 2 to the top within 2 s with no key
 * press, `c` claims a queue row through the socket's claim path, and the queue
 * is not read while the Missions view is open. Never touches ~/.buildd.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { RunnerQueueResponse } from '@buildd/shared';
import { serveRunnerSocket, type RunnerSocketServer } from '../../src/runner-socket';
import { createPalette, stripAnsi } from '../../src/terminal-palette';
import { runTop, type TopTerminal } from '../../src/top/run';
import { TASKS, WORKERS } from './top-fixture';
import { QUEUE } from './top-queue-fixture';

let dir: string;
let sock: string;
let server: RunnerSocketServer | null = null;
let sse: ReadableStreamDefaultController<Uint8Array> | null = null;
let queue: RunnerQueueResponse = QUEUE;
let queueReads = 0;
const posts: Array<{ path: string; body: any }> = [];

const push = (event: unknown) => sse?.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'top-queue-'));
  sock = join(dir, 'runner.sock');
  queue = QUEUE;
  queueReads = 0;
  posts.length = 0;
  sse = null;
  server = serveRunnerSocket(sock, async (req) => {
    const path = new URL(req.url).pathname;
    if (req.method === 'POST') {
      posts.push({ path, body: await req.json().catch(() => ({})) });
      return Response.json({ workers: [{ id: 'w-x' }] });
    }
    switch (path) {
      case '/api/runner': return Response.json({ pid: 4242, version: '0.340.0' });
      case '/api/config': return Response.json({ maxConcurrent: 3, builddServer: 'http://127.0.0.1:1' });
      case '/api/workers': return Response.json({ workers: WORKERS });
      case '/api/tasks': return Response.json({ tasks: TASKS });
      case '/api/workspaces': return Response.json({ workspaces: [
        { id: 'ws-a', name: 'alpha', teamId: 'team-1', teamName: 'Team One' },
        { id: 'ws-b', name: 'bravo', teamId: 'team-2', teamName: 'Team Two' },
      ] });
      case '/api/missions/recent': return Response.json({ missions: [] });
      case '/api/queue': queueReads++; return Response.json(queue);
      case '/api/events':
        return new Response(new ReadableStream<Uint8Array>({
          start(c) {
            sse = c;
            c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: 'init', workers: [] })}\n\n`));
          },
        }), { headers: { 'Content-Type': 'text/event-stream' } });
    }
    return new Response('Not found', { status: 404 });
  });
});

afterEach(() => {
  server?.stop();
  server = null;
  rmSync(dir, { recursive: true, force: true });
});

function fakeTerminal() {
  const writes: string[] = [];
  let onData: ((d: string) => void) | null = null;
  const term: TopTerminal = {
    stdin: { isTTY: true, setRawMode: () => {}, on: (_e: 'data', cb: (d: any) => void) => { onData = cb; }, off: () => { onData = null; }, resume: () => {}, pause: () => {}, setEncoding: () => {} },
    stdout: { isTTY: true, columns: 80, rows: 24, write: (s: string) => { writes.push(s); } },
  };
  return {
    term,
    type: (s: string) => onData?.(s),
    screen: () => {
      const last = [...writes].reverse().find(w => w.startsWith('\x1b[H'));
      return last ? stripAnsi(last).replace(/\x1b\[K/g, '') : '';
    },
  };
}

async function until(cond: () => boolean, ms = 2_000) {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await Bun.sleep(10);
  }
}

const firstRow = (screen: string) => screen.split('\n').find(l => /^.\s+1 /.test(l)) ?? '';

describe('Queue view, live', () => {
  test('Tab reads it; another runner claiming position 1 moves position 2 to the top within 2 s (AC-12)', async () => {
    const t = fakeTerminal();
    const done = runTop({ socketPath: sock, terminal: t.term, hostname: 'h', palette: createPalette('night', 'none'), processHooks: false, openUrl: () => {} });
    await until(() => t.screen().includes('name override'));
    // The Missions view reads the queue once at the start (it lists a mission's
    // queued work the windowed task list leaves out), then once a minute: a
    // change in the queue does not re-read it there.
    await until(() => queueReads === 1);
    push({ type: 'task_claimed', taskId: 't-loose' });
    await Bun.sleep(400);
    expect(queueReads).toBe(1);

    t.type('\t');
    await until(() => firstRow(t.screen()).includes('fix(kernel): review composition'));
    expect(queueReads).toBe(2);

    // Another runner takes position 1; the server's next answer no longer has it first.
    queue = { ...QUEUE, teams: QUEUE.teams.map((tm, i) => i === 0 ? { ...tm, queue: tm.queue.slice(1), notForRunner: [{ ...tm.queue[0], reason: 'another_runner' as const }, ...tm.notForRunner] } : tm) };
    const pushedAt = Date.now();
    push({ type: 'task_claimed', taskId: 'q-review', workspaceId: 'ws-a' });
    await until(() => firstRow(t.screen()).includes('feat(intake): one intake door'));
    expect(Date.now() - pushedAt).toBeLessThan(2_000);

    // c claims the selected queue row through the socket's claim path.
    t.type('c');
    await until(() => posts.length === 1);
    expect(posts[0]).toEqual({ path: '/api/claim', body: { taskId: 'q-intake' } });
    await until(() => t.screen().includes('Claimed "feat(intake): one intake door" onto this runner.'));

    t.type('\t');
    await until(() => t.screen().includes('[ Missions ]'));
    t.type('q');
    expect(await done).toBe(0);
  });
});
