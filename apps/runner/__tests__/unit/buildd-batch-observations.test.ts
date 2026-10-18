import { afterEach, expect, test } from 'bun:test';
import { BuilddClient } from '../../src/buildd';
import type { LocalUIConfig } from '../../src/types';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
const client = () => new BuilddClient({ builddServer: 'http://server.invalid', apiKey: 'test-key' } as LocalUIConfig);

test('hydrates requested older memories by id instead of scanning the newest page', async () => {
  const routes: URL[] = [];
  globalThis.fetch = (async (input: string) => {
    const url = new URL(input);
    routes.push(url);
    const memories = url.searchParams.getAll('ids').includes('older-memory')
      ? [{ id: 'older-memory', title: 'Older relevant lesson', type: 'gotcha', content: 'Full lesson', tags: ['lesson'] }]
      : [{ id: 'newest-memory', title: 'Unrelated', type: 'gotcha', content: 'Other' }];
    return new Response(JSON.stringify({ memories }), { status: 200 });
  }) as typeof fetch;
  expect(await client().getBatchObservations('workspace', ['older-memory', 'older-memory'])).toEqual([
    { id: 'older-memory', title: 'Older relevant lesson', type: 'gotcha', content: 'Full lesson', files: [], concepts: ['lesson'] },
  ]);
  expect(routes).toHaveLength(1);
  expect(routes[0].searchParams.getAll('ids')).toEqual(['older-memory']);
});

test('empty hydration makes no request', async () => {
  let calls = 0;
  globalThis.fetch = (async () => { calls++; throw new Error('unexpected'); }) as typeof fetch;
  expect(await client().getBatchObservations('workspace', [])).toEqual([]);
  expect(calls).toBe(0);
});
