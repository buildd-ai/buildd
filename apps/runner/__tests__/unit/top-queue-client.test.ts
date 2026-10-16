/**
 * The runner asks the server for its queue (spec c7410e76 R-26) with what its
 * claim body says about it: the runner id (the per-runner cooldown), the roles
 * it advertises, and its executor. Nothing else widens or narrows the read.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { BuilddClient } from '../../src/buildd';
import type { LocalUIConfig } from '../../src/types';

const realFetch = globalThis.fetch;
const realExecutor = process.env.BUILDD_EXECUTOR;
afterEach(() => {
  globalThis.fetch = realFetch;
  if (realExecutor === undefined) delete process.env.BUILDD_EXECUTOR; else process.env.BUILDD_EXECUTOR = realExecutor;
});

function capture(body: unknown) {
  const urls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    urls.push(String(url));
    return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body };
  }) as any;
  return urls;
}

const client = () => new BuilddClient({ projectRoots: ['/tmp'], builddServer: 'http://server.invalid', apiKey: 'test-key', maxConcurrent: 1 } as LocalUIConfig);

describe('BuilddClient.listQueue', () => {
  test('sends the runner id, the advertised roles and the executor', async () => {
    delete process.env.BUILDD_EXECUTOR;
    const urls = capture({ teams: [{ teamId: 't', teamName: 'T', estimatesOn: false, queue: [], notForRunner: [] }], truncated: true });
    const out = await client().listQueue({ runner: 'http://localhost:8766', skills: ['builder', 'writer'] });
    const u = new URL(urls[0]);
    expect(u.pathname).toBe('/api/workers/queue');
    expect(Object.fromEntries(u.searchParams)).toEqual({ executor: 'host', runner: 'http://localhost:8766', skills: 'builder,writer' });
    expect(out.truncated).toBe(true);
    expect(out.teams.length).toBe(1);
  });

  test('a cloud container says so; no roles means no skills param', async () => {
    process.env.BUILDD_EXECUTOR = 'cloud';
    const urls = capture({});
    const out = await client().listQueue({ skills: [] });
    expect(Object.fromEntries(new URL(urls[0]).searchParams)).toEqual({ executor: 'cloud' });
    expect(out).toEqual({ teams: [], truncated: false });
  });
});
