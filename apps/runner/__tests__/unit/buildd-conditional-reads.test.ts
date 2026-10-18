/**
 * The runner's list and polling reads send the ETag they hold (spec 3ef37387
 * R-20, AC-4): GET /api/tasks, /api/missions/stages, /api/missions/recent and
 * /api/workers/queue. A 304 answers with the body the runner already has, so
 * an unchanged poll costs the server no list read. Other reads never send it.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/buildd-conditional-reads.test.ts
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { BuilddClient } from '../../src/buildd';
import type { LocalUIConfig } from '../../src/types';

const realFetch = globalThis.fetch;
let sent: Array<{ url: string; ifNoneMatch: string | null }>;
let reply: (url: string) => { status: number; body?: unknown; etag?: string };

function makeClient() {
  return new BuilddClient({ projectRoots: ['/tmp'], builddServer: 'http://server.invalid', apiKey: 'k', maxConcurrent: 1 } as LocalUIConfig);
}

beforeEach(() => {
  sent = [];
  globalThis.fetch = (async (input: any, init: any) => {
    const url = String(input);
    const h = new Headers(init?.headers);
    sent.push({ url, ifNoneMatch: h.get('if-none-match') });
    const r = reply(url);
    const text = r.body === undefined ? '' : JSON.stringify(r.body);
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: new Headers(r.etag ? { etag: r.etag } : {}),
      text: async () => text,
      json: async () => JSON.parse(text),
    };
  }) as any;
});
afterEach(() => { globalThis.fetch = realFetch; });

describe('conditional list reads', () => {
  test('the second read sends the tag; a 304 answers with the held body', async () => {
    const client = makeClient();
    reply = () => ({ status: 200, body: { tasks: [{ id: 't1' }] }, etag: 'W/"cv1-a"' });
    expect(await client.listTasks()).toEqual([{ id: 't1' }] as any);
    reply = () => ({ status: 304, etag: 'W/"cv1-a"' });
    expect(await client.listTasks()).toEqual([{ id: 't1' }] as any);
    expect(sent.map(s => s.ifNoneMatch)).toEqual([null, 'W/"cv1-a"']);
  });

  test('a caller editing the answer does not change what the next 304 returns', async () => {
    const client = makeClient();
    reply = () => ({ status: 200, body: { tasks: [{ id: 't1' }] }, etag: 'W/"cv1-a"' });
    const first = await client.listTasks();
    (first[0] as any).mutated = true;
    reply = () => ({ status: 304 });
    expect(await client.listTasks()).toEqual([{ id: 't1' }] as any);
  });

  test('an answer with no tag drops the held one: the next read asks in full', async () => {
    const client = makeClient();
    reply = () => ({ status: 200, body: { missions: [] }, etag: 'W/"cv1-a"' });
    await client.listRecentMissions();
    reply = () => ({ status: 200, body: { missions: [{ id: 'm' }] } });
    await client.listRecentMissions();
    await client.listRecentMissions();
    expect(sent.map(s => s.ifNoneMatch)).toEqual([null, 'W/"cv1-a"', null]);
  });

  test('stages and the queue are held per query; other reads never send a tag', async () => {
    const client = makeClient();
    reply = () => ({ status: 200, body: { stages: {}, teams: [] }, etag: 'W/"cv1-s"' });
    await client.listMissionStages(['m1']);
    await client.listMissionStages(['m2']);
    await client.listMissionStages(['m1']);
    await client.listQueue({ runner: 'r1' });
    await client.listQueue({ runner: 'r1' });
    expect(sent.map(s => s.ifNoneMatch)).toEqual([null, null, 'W/"cv1-s"', null, 'W/"cv1-s"']);
    sent = [];
    reply = () => ({ status: 200, body: { id: 't1' }, etag: 'W/"x"' });
    await client.getTask('t1');
    await client.getTask('t1');
    expect(sent.map(s => s.ifNoneMatch)).toEqual([null, null]);
  });
});
