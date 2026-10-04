/**
 * BuilddClient.claimPaths request deadline, against a real local HTTP server.
 *
 * Production round trips to the path-claim route run ~75-425ms. The old 200ms
 * abort turned slow-but-successful claims into "unavailable" (degraded
 * telemetry, paths re-queued) and, in enforce mode, a slow 409 into fail-open.
 * The request must wait for a healthy-but-slow answer, and still give up on a
 * hung server within PATH_CLAIM_TIMEOUT_MS.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/path-claim-client-deadline.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { BuilddClient } from '../../src/buildd';
import { PATH_CLAIM_TIMEOUT_MS } from '../../src/path-claim-enforcement';
import type { LocalUIConfig } from '../../src/types';

const SLOW_BUT_HEALTHY_MS = 450;
const BLOCKER = 'bbbbbbbb-1111-2222-3333-444444444444';

let server: ReturnType<typeof Bun.serve>;
let client: BuilddClient;
const hung: Array<() => void> = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const taskId = new URL(req.url).pathname.split('/')[3];
      if (taskId === 'hung') {
        await new Promise<void>(r => hung.push(r));
        return new Response('late');
      }
      await Bun.sleep(SLOW_BUT_HEALTHY_MS);
      if (taskId === 'slow-ok') return Response.json({ claimed: true });
      if (taskId === 'slow-409') {
        return Response.json({
          claimed: false,
          blockingTaskId: BLOCKER,
          blockingTaskTitle: 'Other task',
          blockingPath: 'a.ts',
          blockedPaths: [{ path: 'a.ts', blockingTaskId: BLOCKER, blockingPath: 'a.ts' }],
        }, { status: 409 });
      }
      return new Response('boom', { status: 503 });
    },
  });
  client = new BuilddClient({
    builddServer: `http://localhost:${server.port}`,
    apiKey: 'bld_test',
  } as unknown as LocalUIConfig);
});

afterAll(() => {
  hung.forEach(release => release());
  server.stop(true);
});

describe('BuilddClient.claimPaths — coordination deadline', () => {
  test('the deadline is calibrated above observed production round trips', () => {
    expect(PATH_CLAIM_TIMEOUT_MS).toBeGreaterThan(SLOW_BUT_HEALTHY_MS * 2);
  });

  test('a success answered after 200ms is claimed, not unavailable', async () => {
    expect(await client.claimPaths('slow-ok', ['a.ts'])).toEqual({ kind: 'claimed' });
  });

  test('a 409 answered after 200ms is a conflict, not unavailable', async () => {
    const res = await client.claimPaths('slow-409', ['a.ts']);
    expect(res.kind).toBe('conflict');
    expect((res as any).blockingTaskId).toBe(BLOCKER);
  });

  test('a slow 5xx is an error, distinct from a timeout', async () => {
    expect(await client.claimPaths('slow-5xx', ['a.ts'])).toEqual({ kind: 'unavailable', reason: 'error' });
  });

  test('a hung server is a timeout within the bounded deadline', async () => {
    const started = Date.now();
    const res = await client.claimPaths('hung', ['a.ts']);
    const elapsed = Date.now() - started;
    expect(res).toEqual({ kind: 'unavailable', reason: 'timeout' });
    expect(elapsed).toBeGreaterThanOrEqual(PATH_CLAIM_TIMEOUT_MS - 50);
    expect(elapsed).toBeLessThan(PATH_CLAIM_TIMEOUT_MS + 500);
  });
});
