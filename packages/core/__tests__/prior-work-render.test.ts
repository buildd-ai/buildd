import { describe, it, expect } from 'bun:test';
import { buildAuthoringPriorWork } from '../prior-work-render';

const WORKSPACE_ID = '00000000-0000-0000-0000-000000000001';
const TEAM_ID = '00000000-0000-0000-0000-00000000000a';

function hit(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task:hit-1',
    namespace: `${WORKSPACE_ID}:task`,
    corpus: 'task',
    sourceType: 'task',
    sourcePath: null,
    sourceUrl: '/app/tasks/hit-1',
    content: '# Task: CTA derives from server state',
    metadata: {},
    score: 0.9,
    createdAt: new Date(),
    ...overrides,
  };
}

describe('buildAuthoringPriorWork', () => {
  it('renders a "## Prior work" block with the stale-baseline flag for a recently-merged PR', async () => {
    const recentlyMerged = hit({
      score: 0.87,
      metadata: { success: true, prUrl: 'https://github.com/buildd-ai/buildd/pull/2339' },
      createdAt: new Date(Date.now() - 3 * 86400000), // 3 days ago
      content: '# Task: CTA derives from server state, not cached UI',
    });
    const store = { query: async () => [recentlyMerged] };

    const result = await buildAuthoringPriorWork('CTA state bug', WORKSPACE_ID, TEAM_ID, store);

    expect(result).toContain('## Prior work');
    expect(result).toContain('PR #2339');
    expect(result).toContain('MAY ALREADY BE SHIPPED');
    expect(result).toContain('0.87');
  });

  it('drops hits below the 0.45 precision floor', async () => {
    const weak = hit({ score: 0.3 });
    const store = { query: async () => [weak] };

    const result = await buildAuthoringPriorWork('some query', WORKSPACE_ID, TEAM_ID, store);

    expect(result).toBe('');
  });

  it('caps the merged, deduped result set at 5 hits', async () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      hit({ id: `task:hit-${i}`, score: 0.5 + i * 0.01, content: `# Task: Hit number ${i}` }),
    );
    const store = { query: async () => many };

    const result = await buildAuthoringPriorWork('broad query', WORKSPACE_ID, TEAM_ID, store);

    const bulletLines = result.split('\n').filter(l => l.startsWith('- ['));
    expect(bulletLines.length).toBe(5);
    // Highest-scored hits win the cap.
    expect(result).toContain('Hit number 11');
    expect(result).not.toContain('Hit number 0');
  });

  it('deduplicates a hit returned by both the main query and the path-scoped supplement', async () => {
    const shared = hit({ id: 'pr:shared', corpus: 'pr', sourceType: 'pr', score: 0.6 });
    let calls = 0;
    const store = {
      query: async () => {
        calls += 1;
        return [shared];
      },
    };

    const result = await buildAuthoringPriorWork('query', WORKSPACE_ID, TEAM_ID, store, {
      paths: ['apps/web/src/lib/cta.ts'],
    });

    expect(calls).toBeGreaterThan(1);
    const bulletLines = result.split('\n').filter(l => l.startsWith('- ['));
    expect(bulletLines.length).toBe(1);
  });

  it('renders nothing when every corpus comes back empty', async () => {
    const store = { query: async () => [] };
    const result = await buildAuthoringPriorWork('nothing found', WORKSPACE_ID, TEAM_ID, store);
    expect(result).toBe('');
  });

  it('degrades to empty string when the knowledge store throws', async () => {
    const store = {
      query: async () => {
        throw new Error('store unavailable');
      },
    };
    const result = await buildAuthoringPriorWork('query', WORKSPACE_ID, TEAM_ID, store);
    expect(result).toBe('');
  });

  it('returns empty string for a blank query without touching the store', async () => {
    let called = false;
    const store = { query: async () => { called = true; return []; } };
    const result = await buildAuthoringPriorWork('   ', WORKSPACE_ID, TEAM_ID, store);
    expect(result).toBe('');
    expect(called).toBe(false);
  });

  it('returns empty string when no store is provided', async () => {
    const result = await buildAuthoringPriorWork('query', WORKSPACE_ID, TEAM_ID, undefined);
    expect(result).toBe('');
  });
});

// Invariant: memory surfaced to an agent comes only from the requesting
// workspace's project. `{teamId}:memory` is team-wide, so a memory from another
// workspace's project sits in the same namespace and must not render.
describe('buildAuthoringPriorWork — memory is pinned to the caller project', () => {
  const OWN = 'acme/widgets';
  const FOREIGN = 'acme/other-thing';
  const memoryNs = `${TEAM_ID}:memory`;

  function nsStore(byNs: Record<string, ReturnType<typeof hit>[]>) {
    const queried: Array<{ ns: string; topK?: number }> = [];
    return {
      queried,
      store: {
        query: async (ns: string, p: { topK?: number }) => {
          queried.push({ ns, topK: p.topK });
          return (byNs[ns] ?? []) as any[];
        },
      },
    };
  }

  const scope = (projects: Record<string, string | null>) => ({
    project: OWN,
    lookup: async (ids: string[]) => ({
      memories: ids.filter(id => id in projects).map(id => ({ id, project: projects[id] })),
    }),
  });

  const memHits = () => [
    hit({ id: 'own-1', corpus: 'memory', sourceType: 'memory', content: '# own lesson', score: 0.8 }),
    hit({ id: 'foreign-1', corpus: 'memory', sourceType: 'memory', content: '# foreign lesson', score: 0.9 }),
    hit({ id: 'digest-1', corpus: 'memory', sourceType: 'memory', content: '# unscoped digest', score: 0.9 }),
  ];

  it('renders own-project memory and drops another project and unscoped rows', async () => {
    const { store } = nsStore({ [memoryNs]: memHits() });
    const result = await buildAuthoringPriorWork('lesson', WORKSPACE_ID, TEAM_ID, store, {
      memoryScope: scope({ 'own-1': OWN, 'foreign-1': FOREIGN, 'digest-1': null }),
    });
    expect(result).toContain('own lesson');
    expect(result).not.toContain('foreign lesson');
    expect(result).not.toContain('unscoped digest');
  });

  it('never queries the team memory namespace without a project scope', async () => {
    const { store, queried } = nsStore({ [memoryNs]: memHits() });
    const result = await buildAuthoringPriorWork('lesson', WORKSPACE_ID, TEAM_ID, store, { memoryScope: null });
    expect(queried.some(q => q.ns === memoryNs)).toBe(false);
    expect(result).not.toContain('lesson');
  });

  it('over-fetches the memory namespace before narrowing', async () => {
    const { store, queried } = nsStore({});
    await buildAuthoringPriorWork('lesson', WORKSPACE_ID, TEAM_ID, store, { memoryScope: scope({}) });
    const mem = queried.find(q => q.ns === memoryNs)!;
    const task = queried.find(q => q.ns === `${WORKSPACE_ID}:task`)!;
    expect(mem.topK!).toBeGreaterThan(task.topK!);
  });
});
