/**
 * A claim a person asked for (`c` in top, a task aimed at this runner) says so
 * on the wire, so the server's account-wide worker count never refuses it
 * while this runner has a free slot. The autonomous poll never sends it.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/claim-requested-by-person.test.ts
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { BuilddClient } from '../../src/buildd';
import type { LocalUIConfig } from '../../src/types';

const realFetch = globalThis.fetch;

function makeClient() {
  return new BuilddClient({
    projectsRoot: '/tmp',
    builddServer: 'http://server.invalid',
    apiKey: 'test-key',
    maxConcurrent: 1,
  } as LocalUIConfig);
}

let sentBodies: any[];

describe('claimTask requestedByPerson', () => {
  beforeEach(() => {
    sentBodies = [];
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      sentBodies.push(JSON.parse(String(init.body)));
      const body = JSON.stringify({ workers: [] });
      return { ok: true, status: 200, text: async () => body, json: async () => JSON.parse(body) };
    }) as any;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test('a person-requested claim sends requestedByPerson: true', async () => {
    await makeClient().claimTask(1, 'ws-1', 'r', 't-1', undefined, false, undefined, { byPerson: true });
    expect(sentBodies[0].requestedByPerson).toBe(true);
  });

  test('an ordinary claim does not send it', async () => {
    await makeClient().claimTask(1, 'ws-1', 'r', 't-1');
    expect('requestedByPerson' in sentBodies[0]).toBe(false);
  });
});
