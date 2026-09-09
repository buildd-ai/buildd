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
  responses: {
    byPath?: TaskMemoryObservation[];
    byInferred?: TaskMemoryObservation[];
    byTitle?: TaskMemoryObservation[];
    throwOn?: 'path' | 'title';
  },
  declaredPaths: string[] = ['apps/runner/src/index.ts'],
): ObservationSearcher & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    async searchObservations(_ws, query, limit, files) {
      calls.push({ query, limit, files });
      const isPathStep = !!files?.length;
      if (responses.throwOn === (isPathStep ? 'path' : 'title')) throw new Error('boom');
      if (!isPathStep) return responses.byTitle ?? [];
      // Declared and inferred both arrive as a file scope, so they are told
      // apart by which paths were sent — otherwise a test could not tell a
      // step-2 hit from a step-1 hit.
      const isDeclared = files!.some(f => declaredPaths.includes(f));
      return (isDeclared ? responses.byPath : responses.byInferred) ?? [];
    },
  };
}

const mem = (id: string): TaskMemoryObservation => ({ id, title: `m-${id}`, type: 'gotcha' });

const task = (over: Partial<Parameters<typeof retrieveTaskMemory>[1]> = {}) => ({
  workspaceId: 'ws-1',
  title: 'Do the thing properly',
  // No path-shaped text on purpose: these fixtures exercise the declared and
  // title steps, so the inference step must stay out of the way unless a test
  // opts into it by supplying a description that names a file.
  description: 'A description with no file references in it',
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
    // Tell the stub which paths count as the DECLARED scope for this case —
    // it distinguishes step 1 from step 2 by the paths it is handed.
    const s = searcher({ byPath: [mem('a')] }, ['packages/core']);
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


describe('retrieveTaskMemory — inferred paths (step 2)', () => {
  const DESC = 'The bug is in packages/core/memory-store.ts, see also docs/design';

  test('infers a scope from the task text when none was declared', async () => {
    const s = searcher({ byInferred: [mem('i')] });
    const r = await retrieveTaskMemory(s, task({ pathManifest: [], description: DESC }));

    expect(r.derivedBy).toBe('inferred_paths');
    expect(r.results.map(m => m.id)).toEqual(['i']);
    expect(r.inferredPaths).toEqual(['packages/core/memory-store.ts', 'docs/design']);
    expect(s.calls[0].files).toEqual(['packages/core/memory-store.ts', 'docs/design']);
  });

  // A declaration is strictly better evidence; inferring alongside it would add
  // noise to a good signal, and cost a round trip.
  test('does not infer when a manifest was declared', async () => {
    const s = searcher({ byPath: [mem('a')] });
    const r = await retrieveTaskMemory(s, task({ description: DESC }));

    expect(r.derivedBy).toBe('path_manifest');
    expect(r.inferredPaths).toEqual([]);
    expect(s.calls).toHaveLength(1);
  });

  test('falls through declared → inferred → title in that order', async () => {
    const s = searcher({ byPath: [], byInferred: [], byTitle: [mem('t')] },
      ['apps/runner/src/index.ts']);
    const r = await retrieveTaskMemory(s, task({ description: DESC }));

    // A declared manifest suppresses inference, so only two steps run here.
    expect(r.derivedBy).toBe('title_phrase');
    expect(s.calls.map(c => (c.files?.length ? 'files' : 'title'))).toEqual(['files', 'title']);
  });

  test('runs inferred then title when nothing was declared', async () => {
    const s = searcher({ byInferred: [], byTitle: [mem('t')] });
    const r = await retrieveTaskMemory(s, task({ pathManifest: [], description: DESC }));

    expect(r.derivedBy).toBe('title_phrase');
    expect(s.calls.map(c => (c.files?.length ? 'files' : 'title'))).toEqual(['files', 'title']);
  });

  test('reports no_match when all three steps miss', async () => {
    const s = searcher({ byInferred: [], byTitle: [] });
    const r = await retrieveTaskMemory(s, task({ pathManifest: [], description: DESC }));

    expect(r.derivedBy).toBe('no_match');
    expect(r.inferredPaths.length).toBeGreaterThan(0);
  });

  // Prose is full of slashes; a description with none of them must not invent a
  // scope, and must not cost a round trip either.
  test('a description with no paths yields no inference and no extra call', async () => {
    const s = searcher({ byTitle: [mem('t')] });
    const r = await retrieveTaskMemory(s, task({ pathManifest: [], description: 'read/write and/or 9/10' }));

    expect(r.inferredPaths).toEqual([]);
    expect(r.derivedBy).toBe('title_phrase');
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0].files).toBeUndefined();
  });

  test('the sentinel is stripped from inferred paths too', async () => {
    const s = searcher({ byTitle: [mem('t')] });
    const r = await retrieveTaskMemory(s, task({ pathManifest: ['**'], description: 'read/write only' }));

    expect(r.scopePaths).toEqual([]);
    expect(r.inferredPaths).toEqual([]);
    expect(r.derivedBy).toBe('title_phrase');
  });
});
