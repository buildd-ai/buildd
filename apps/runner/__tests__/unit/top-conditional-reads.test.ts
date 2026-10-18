/**
 * `buildd top` → runner: the runner's list endpoints tag their answer and say
 * 304 to a reader that holds the tag (local-etag.ts); top's socket client
 * sends the tag it holds and reads a 304 as the body it has (spec 3ef37387
 * R-20). Over a real unix socket.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/top-conditional-reads.test.ts
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jsonUnlessUnchanged, localTag } from '../../src/local-etag';
import { socketClient } from '../../src/top/client';

let dir: string;
let server: ReturnType<typeof Bun.serve>;
let tasks: unknown[] = [];
const seen: Array<{ path: string; ifNoneMatch: string | null; status: number }> = [];

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'top-etag-'));
  server = Bun.serve({
    unix: join(dir, 'runner.sock'),
    fetch(req) {
      const path = new URL(req.url).pathname;
      const res = path === '/api/config' ? Response.json({ maxConcurrent: 1 }) : jsonUnlessUnchanged(req, { tasks }, { 'X-Test': '1' });
      seen.push({ path, ifNoneMatch: req.headers.get('if-none-match'), status: res.status });
      return res;
    },
  });
});
afterAll(() => { server.stop(true); rmSync(dir, { recursive: true, force: true }); });

describe('local tags', () => {
  test('the tag follows the answer', () => {
    expect(localTag({ a: 1 })).toBe(localTag({ a: 1 }));
    expect(localTag({ a: 1 })).not.toBe(localTag({ a: 2 }));
  });

  test('top sends the held tag; an unchanged answer is a 304 it reads as the body it has', async () => {
    const client = socketClient(join(dir, 'runner.sock'));
    tasks = [{ id: 't1' }];
    expect(await client.get('/api/tasks')).toEqual({ status: 200, body: { tasks: [{ id: 't1' }] } });
    expect(await client.get('/api/tasks')).toEqual({ status: 200, body: { tasks: [{ id: 't1' }] } });
    tasks = [{ id: 't2' }];
    expect(await client.get('/api/tasks')).toEqual({ status: 200, body: { tasks: [{ id: 't2' }] } });
    const reads = seen.filter(s => s.path === '/api/tasks');
    expect(reads.map(s => s.status)).toEqual([200, 304, 200]);
    expect(reads[0]!.ifNoneMatch).toBeNull();
    expect(reads[1]!.ifNoneMatch).toBe(localTag({ tasks: [{ id: 't1' }] }));
  });

  test('a read that is not a list read never sends a tag', async () => {
    const client = socketClient(join(dir, 'runner.sock'));
    await client.get('/api/config');
    await client.get('/api/config');
    expect(seen.filter(s => s.path === '/api/config').map(s => s.ifNoneMatch)).toEqual([null, null]);
  });
});
