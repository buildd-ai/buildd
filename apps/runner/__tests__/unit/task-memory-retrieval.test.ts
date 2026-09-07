import { describe, expect, test } from 'bun:test';
import {
  retrieveTaskMemory,
  type ObservationSearcher,
  type TaskMemoryObservation,
} from '../../src/task-memory-retrieval';

type Call = { query: string; limit?: number; files?: readonly string[] };

/**
 * Records what was asked, so a test can assert the *order and shape* of the two
 * steps rather than only their combined output. Without that, a single blended
 * query and a correct two-step sequence are indistinguishable from the result.
 */
function searcher(
  responses: { byPath?: TaskMemoryObservation[]; byTitle?: TaskMemoryObservation[]; throwOn?: 'path' | 'title' },
): ObservationSearcher & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    async searchObservations(_ws, query, limit, files) {
      calls.push({ query, limit, files });
      const isPathStep = !!files?.length;
      if (responses.throwOn === (isPathStep ? 'path' : 'title')) throw new Error('boom');
      return (isPathStep ? responses.byPath : responses.byTitle) ?? [];
    },
  };
}

const mem = (id: string): TaskMemoryObservation => ({ id, title: `m-${id}`, type: 'gotcha' });

const task = (over: Partial<Parameters<typeof retrieveTaskMemory>[1]> = {}) => ({
  workspaceId: 'ws-1',
  title: 'Do the thing properly',
  pathManifest: ['apps/runner/src/index.ts'],
  ...over,
});

describe('retrieveTaskMemory — step order', () => {
  test('declared paths are tried first and win when they hit', async () => {
    const s = searcher({ byPath: [mem('a'), mem('b')], byTitle: [mem('z')] });
    const r = await retrieveTaskMemory(s, task());

    expect(r.derivedBy).toBe('path_manifest');
    expect(r.results.map(m => m.id)).toEqual(['a', 'b']);
    // The title step must not run at all once paths hit — otherwise every task
    // pays for two round trips.
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0].files).toEqual(['apps/runner/src/index.ts']);
    expect(s.calls[0].query).toBe('');
  });

  test('falls back to the title when the path scope matches nothing', async () => {
    const s = searcher({ byPath: [], byTitle: [mem('z')] });
    const r = await retrieveTaskMemory(s, task());

    expect(r.derivedBy).toBe('title_phrase');
    expect(r.results.map(m => m.id)).toEqual(['z']);
    expect(s.calls).toHaveLength(2);
    expect(s.calls[1].files).toBeUndefined();
    expect(s.calls[1].query).toBe('Do the thing properly');
  });

  test('reports that a path scope existed and missed, distinctly from having none', async () => {
    const missed = await retrieveTaskMemory(searcher({ byPath: [], byTitle: [mem('z')] }), task());
    expect(missed.pathScopeMissed).toBe(true);
    expect(missed.scopePaths).toEqual(['apps/runner/src/index.ts']);

    const noScope = await retrieveTaskMemory(searcher({ byTitle: [mem('z')] }), task({ pathManifest: [] }));
    expect(noScope.pathScopeMissed).toBe(false);
    expect(noScope.scopePaths).toEqual([]);
  });

  test('no scope means only the title step runs', async () => {
    const s = searcher({ byTitle: [mem('z')] });
    const r = await retrieveTaskMemory(s, task({ pathManifest: undefined }));

    expect(r.derivedBy).toBe('title_phrase');
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0].files).toBeUndefined();
  });
});

describe('retrieveTaskMemory — the sentinel', () => {
  // '**' records that the filer never declared a scope. Querying it would match
  // every memory, so it must not become a path step at all.
  test('a repo-wide sentinel is not a path scope', async () => {
    const s = searcher({ byPath: [mem('a')], byTitle: [mem('z')] });
    const r = await retrieveTaskMemory(s, task({ pathManifest: ['**'] }));

    expect(r.scopePaths).toEqual([]);
    expect(r.derivedBy).toBe('title_phrase');
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0].files).toBeUndefined();
  });

  test('concrete paths alongside the sentinel are still used', async () => {
    const s = searcher({ byPath: [mem('a')] });
    const r = await retrieveTaskMemory(s, task({ pathManifest: ['**', 'packages/core'] }));

    expect(r.scopePaths).toEqual(['packages/core']);
    expect(r.derivedBy).toBe('path_manifest');
  });
});

describe('retrieveTaskMemory — degradation', () => {
  test('nothing to search with is reported as not attempted, not as a miss', async () => {
    const s = searcher({});
    const r = await retrieveTaskMemory(s, task({ title: '', pathManifest: [] }));

    expect(r.derivedBy).toBe('not_attempted');
    expect(s.calls).toHaveLength(0);
  });

  test('both steps running and returning nothing is a miss', async () => {
    const r = await retrieveTaskMemory(searcher({ byPath: [], byTitle: [] }), task());
    expect(r.derivedBy).toBe('no_match');
    expect(r.results).toEqual([]);
  });

  // A transient failure on the path query must not also suppress the fallback.
  test('a throwing path step still lets the title step run', async () => {
    const s = searcher({ throwOn: 'path', byTitle: [mem('z')] });
    const r = await retrieveTaskMemory(s, task());

    expect(r.derivedBy).toBe('title_phrase');
    expect(r.results.map(m => m.id)).toEqual(['z']);
  });

  test('a throwing title step degrades to a miss rather than rejecting', async () => {
    const s = searcher({ byPath: [], throwOn: 'title' });
    const r = await retrieveTaskMemory(s, task());

    expect(r.derivedBy).toBe('no_match');
    expect(r.results).toEqual([]);
  });

  test('a path manifest that is not an array of strings is ignored safely', async () => {
    for (const bad of ['apps/web', 42, {}, null] as unknown[]) {
      const s = searcher({ byTitle: [mem('z')] });
      const r = await retrieveTaskMemory(s, task({ pathManifest: bad }));
      expect(r.scopePaths).toEqual([]);
      expect(s.calls[0].files).toBeUndefined();
    }
  });

  test('the limit is threaded to both steps', async () => {
    const s = searcher({ byPath: [], byTitle: [] });
    await retrieveTaskMemory(s, task(), 9);
    expect(s.calls.map(c => c.limit)).toEqual([9, 9]);
  });
});
