/**
 * query_knowledge memory corpus — freshness metadata and telemetry
 *
 * §5.4: Results for corpus=memory include [savedAt: N days ago · superseded: false] inline.
 * §5.3: A fire-and-forget emit_event is fired after each successful query_knowledge call.
 */
import { describe, it, expect } from 'bun:test';
import { handleMemoryAction } from '../mcp-tools';
import type { KnowledgeStore, QueryResult } from '../knowledge-store/types';

const WS_ID  = 'aaaa0000-0000-0000-0000-000000000000';
const TEAM_ID = 'bbbb0000-0000-0000-0000-000000000000';
const WORKER_ID = 'worker-001';

const THIRTY_DAYS_AGO = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
const TWO_DAYS_AGO    = new Date(Date.now() -  2 * 24 * 60 * 60 * 1000);

function makeMemoryStore(chunks: Partial<QueryResult>[]): KnowledgeStore {
  return {
    async query(_ns): Promise<QueryResult[]> {
      return chunks.map((c, i) => ({
        id: c.id ?? `mem-${i}`,
        namespace: `${TEAM_ID}:memory`,
        corpus: 'memory' as const,
        sourceType: 'memory',
        sourcePath: null,
        sourceUrl: c.sourceUrl ?? null,
        content: c.content ?? `Memory content ${i}`,
        metadata: c.metadata ?? {},
        score: c.score ?? 0.8,
        createdAt: (c as any).createdAt ?? null,
        isCurrent: (c as any).isCurrent ?? true,
      }));
    },
    async upsert()  {},
    async delete()  {},
    async listNamespaces() { return []; },
  };
}

function memCtx(store: KnowledgeStore, api?: any) {
  return {
    workspaceId: WS_ID,
    teamId: TEAM_ID,
    workerId: WORKER_ID,
    knowledgeStore: store,
    embedder: null as any,
    ...(api ? { api } : {}),
  };
}

const nullMemClient = {} as any;

describe('query_knowledge memory — freshness metadata', () => {
  it('includes [savedAt: N days ago · superseded: false] when createdAt present', async () => {
    const store = makeMemoryStore([
      { content: 'Use bun not npm', createdAt: THIRTY_DAYS_AGO, isCurrent: true } as any,
    ]);
    const res = await handleMemoryAction(nullMemClient, 'query_knowledge', { query: 'bun', corpus: 'memory' }, memCtx(store));
    expect(res.isError).toBeFalsy();
    const out = res.content[0].text;
    expect(out).toContain('savedAt:');
    expect(out).toContain('superseded: false');
  });

  it('marks superseded: true when isCurrent is false', async () => {
    const store = makeMemoryStore([
      { content: 'Old pattern', createdAt: TWO_DAYS_AGO, isCurrent: false } as any,
    ]);
    const res = await handleMemoryAction(nullMemClient, 'query_knowledge', { query: 'pattern', corpus: 'memory' }, memCtx(store));
    const out = res.content[0].text;
    expect(out).toContain('superseded: true');
  });

  it('omits freshness block when corpus is not memory', async () => {
    const store = makeMemoryStore([
      { content: 'function foo() {}', createdAt: THIRTY_DAYS_AGO } as any,
    ]);
    // Override to use code corpus namespace (store uses workspace-scoped ns)
    const codeStore: KnowledgeStore = {
      ...store,
      async query(_ns): Promise<QueryResult[]> {
        return [{ id: 'code-1', namespace: `${WS_ID}:code`, corpus: 'code', sourceType: 'code',
          sourcePath: 'src/foo.ts', sourceUrl: null, content: 'function foo() {}',
          metadata: {}, score: 0.9, createdAt: THIRTY_DAYS_AGO } as any];
      },
    };
    const res = await handleMemoryAction(nullMemClient, 'query_knowledge', { query: 'foo', corpus: 'code' }, memCtx(codeStore));
    const out = res.content[0].text;
    // Code corpus should NOT include savedAt prefix
    expect(out).not.toContain('savedAt:');
  });

  it('handles missing createdAt gracefully', async () => {
    const store = makeMemoryStore([{ content: 'Some memory', isCurrent: true } as any]);
    const res = await handleMemoryAction(nullMemClient, 'query_knowledge', { query: 'memory', corpus: 'memory' }, memCtx(store));
    expect(res.isError).toBeFalsy();
    // Should still show superseded status even without savedAt
    const out = res.content[0].text;
    expect(out).toContain('superseded: false');
  });
});

describe('query_knowledge — emit_event telemetry', () => {
  it('fires a knowledge_query event when api and workerId are present', async () => {
    const patchedPaths: string[] = [];
    const patchedBodies: any[] = [];
    const api = async (path: string, opts?: RequestInit) => {
      patchedPaths.push(path);
      if (opts?.body) patchedBodies.push(JSON.parse(opts.body as string));
      return {};
    };

    const store = makeMemoryStore([{ content: 'Use bun', isCurrent: true } as any]);
    await handleMemoryAction(nullMemClient, 'query_knowledge', { query: 'bun setup', corpus: 'memory' }, memCtx(store, api));

    // Wait briefly for the fire-and-forget
    await new Promise(r => setTimeout(r, 20));

    const workerPatch = patchedPaths.find(p => p.includes(`/api/workers/${WORKER_ID}`));
    expect(workerPatch).toBeTruthy();
    const milestoneBody = patchedBodies.find(b => b.appendMilestones);
    expect(milestoneBody).toBeTruthy();
    const event = milestoneBody.appendMilestones[0];
    expect(event.type).toBe('knowledge_query');
    expect(event.label).toBe('memory');
    expect(event.metadata.hitCount).toBe(1);
    expect(typeof event.metadata.query).toBe('string');
  });

  it('does not throw when api is absent (backward compat)', async () => {
    const store = makeMemoryStore([{ content: 'Use bun', isCurrent: true } as any]);
    const res = await handleMemoryAction(nullMemClient, 'query_knowledge', { query: 'bun', corpus: 'memory' }, memCtx(store));
    expect(res.isError).toBeFalsy();
  });

  it('fires event with correct corpus label for code corpus', async () => {
    const patchedBodies: any[] = [];
    const api = async (_path: string, opts?: RequestInit) => {
      if (opts?.body) patchedBodies.push(JSON.parse(opts.body as string));
      return {};
    };
    const codeStore: KnowledgeStore = {
      async query(): Promise<QueryResult[]> {
        return [{ id: 'c1', namespace: `${WS_ID}:code`, corpus: 'code', sourceType: 'code',
          sourcePath: 'src/a.ts', sourceUrl: null, content: 'export const x = 1',
          metadata: {}, score: 0.9 }];
      },
      async upsert() {}, async delete() {}, async listNamespaces() { return []; },
    };
    await handleMemoryAction(nullMemClient, 'query_knowledge', { query: 'x', corpus: 'code' }, memCtx(codeStore, api));
    await new Promise(r => setTimeout(r, 20));
    const milestoneBody = patchedBodies.find(b => b.appendMilestones);
    const event = milestoneBody?.appendMilestones[0];
    expect(event?.label).toBe('code');
  });
});
