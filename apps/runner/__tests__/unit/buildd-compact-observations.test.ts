/**
 * Defect 3 (task d3ab825c): `digestBytesAvailable` in memory-digest-policy.ts
 * used to be measured from the markdown `getCompactObservations` returns —
 * which is ALREADY sliced to 150 chars per item. So "how much context we had
 * to discard" was unrecoverable by construction: the discard happened here,
 * before the caller ever saw a number.
 *
 * `getCompactObservations` now also sums the FULL content of every fetched
 * memory, before that slice, so the caller can report the true pre-cap size.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/buildd-compact-observations.test.ts
 */
import { describe, it, expect, afterEach } from 'bun:test';
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

function respondWithMemories(memories: Array<{ type: string; title: string; content: string; files?: string[] }>, total?: number) {
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ memories, total: total ?? memories.length }),
    json: async () => ({ memories, total: total ?? memories.length }),
  })) as any;
}

describe('getCompactObservations — rawContentBytes', () => {
  afterEach(() => { globalThis.fetch = realFetch; });

  it('sums the FULL content of every fetched memory, before the 150-char slice', async () => {
    const longContent = 'x'.repeat(500);
    respondWithMemories([
      { type: 'gotcha', title: 'lesson one', content: longContent },
      { type: 'gotcha', title: 'lesson two', content: longContent },
    ]);

    const result = await makeClient().getCompactObservations('ws-1');

    expect(result.rawContentBytes).toBe(Buffer.byteLength(longContent, 'utf8') * 2);
    // The rendered markdown itself is capped at 150 chars/item + '...', so the
    // raw figure must be strictly larger — that gap IS the discarded content
    // defect 3 needed to make recordable.
    expect(result.rawContentBytes).toBeGreaterThan(Buffer.byteLength(result.markdown, 'utf8'));
  });

  it('counts UTF-8 bytes, not code units', async () => {
    const content = '→'.repeat(50); // 3 bytes each in UTF-8
    respondWithMemories([{ type: 'gotcha', title: 't', content }]);

    const result = await makeClient().getCompactObservations('ws-1');
    expect(result.rawContentBytes).toBeGreaterThanOrEqual(150);
  });

  it('is 0 when the workspace has no memories', async () => {
    respondWithMemories([]);
    const result = await makeClient().getCompactObservations('ws-1');
    expect(result.rawContentBytes).toBe(0);
    expect(result.markdown).toBe('');
    expect(result.count).toBe(0);
  });

  it('is 0 on a fetch failure, same as the other fields', async () => {
    globalThis.fetch = (async () => { throw new TypeError('fetch failed'); }) as any;
    const result = await makeClient().getCompactObservations('ws-1');
    expect(result).toEqual({ markdown: '', count: 0, rawContentBytes: 0 });
  });
});
