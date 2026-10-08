/**
 * Golden outputs for the core memory read paths, captured BEFORE memory reads
 * were routed through `retrieveMemory` (task d1997424): recall, query_knowledge,
 * authoring-time prior work, and the claim_task "Relevant Memory" reply.
 *
 * The refactor is a no-op by contract. Every snapshot below was recorded
 * against the pre-refactor code; a diff means an agent now sees different
 * memory, which needs its own flag rather than riding along in plumbing.
 */
import { describe, it, expect, mock } from 'bun:test';
import { handleRecallAction, handleMemoryAction, handleBuilddAction, type ActionContext } from '../mcp-tools';
import { buildAuthoringPriorWork } from '../prior-work-render';
import type { KnowledgeStore, QueryResult } from '../knowledge-store/types';
import type { MemoryHitScope } from '../memory-hit-scope';

// claim_task resolves its key server-side (resolveMemoryProjectKey); every
// other path here is handed its scope explicitly.
mock.module('../memory-scope', () => ({
  resolveMemoryProjectKey: async () => 'acme/widgets',
  resolveMemoryHitScope: async () => null,
}));

const WS = 'aaaa0000-0000-0000-0000-000000000000';
const TEAM = 'bbbb0000-0000-0000-0000-000000000000';
const PROJECT = 'acme/widgets';
const DAY = 24 * 60 * 60 * 1000;

type Row = Partial<QueryResult> & { id: string };

function store(byNs: Record<string, Row[]>) {
  const calls: Array<{ ns: string; text: string; topK?: number; mode?: string }> = [];
  const ks: KnowledgeStore = {
    async query(ns, params) {
      calls.push({ ns, text: params.text, topK: params.topK, mode: params.mode });
      const corpus = ns.split(':')[1] as QueryResult['corpus'];
      return (byNs[ns] ?? []).map(r => ({
        namespace: ns,
        corpus,
        sourceType: corpus,
        sourcePath: null,
        sourceUrl: null,
        content: 'content',
        metadata: {},
        score: 0.5,
        createdAt: null,
        isCurrent: true,
        ...r,
      })) as QueryResult[];
    },
    async upsert() { return { superseded: 0 } as any; },
    async delete() {},
    async listNamespaces() { return []; },
  };
  return { ks, calls };
}

/** Memory rows: every id belongs to PROJECT unless listed as foreign. */
function memClient(foreign: string[] = []) {
  return {
    batch: async (ids: string[]) => ({
      memories: ids.map(id => ({ id, project: foreign.includes(id) ? 'acme/other' : PROJECT })),
    }),
    get: async () => ({ memory: null }),
  } as any;
}

const MEMORY_ROWS: Row[] = [
  { id: 'm1', content: 'Neon has no transactions', score: 0.91, metadata: { type: 'gotcha', files: ['packages/core/db/client.ts'] }, sourceUrl: '/app/memory/m1', createdAt: new Date(Date.now() - 4 * DAY) },
  { id: 'm-foreign', content: 'Another project', score: 0.88, metadata: { type: 'gotcha' } },
  { id: 'm-superseded', content: 'Old belief', score: 0.8, isCurrent: false, metadata: { type: 'decision' } },
  { id: 'm2', content: 'Use bun run test', score: 0.6, metadata: { type: 'pattern', files: ['scripts/run-unit-tests.ts'] }, sourceUrl: '/app/memory/m2' },
  { id: 'm3', content: 'Low relevance', score: 0.3, metadata: { type: 'discovery' } },
];

function ctx(ks: KnowledgeStore) {
  return { workspaceId: WS, teamId: TEAM, project: PROJECT, workerId: 'worker-1', knowledgeStore: ks, embedder: null as any };
}

describe('golden: recall', () => {
  it('single scope=memory', async () => {
    const { ks, calls } = store({ [`${TEAM}:memory`]: MEMORY_ROWS });
    const res = await handleRecallAction(memClient(['m-foreign']), { query: 'how do transactions work here', limit: 3 }, ctx(ks));
    expect(res.content[0].text.replace(/\d+ days ago/g, 'N days ago')).toMatchInlineSnapshot(`
      "Found 3 result(s):

      ### 1. [gotcha] [source](/app/memory/m1)
      **Score:** 0.9100
      [savedAt: N days ago · superseded: false]

      Neon has no transactions

      ---

      ### 2. [pattern] [source](/app/memory/m2)
      **Score:** 0.6000
      [superseded: false]

      Use bun run test

      ---

      ### 3. [discovery] memory
      **Score:** 0.3000
      [superseded: false]

      Low relevance"
    `);
    expect(calls).toMatchInlineSnapshot(`
      [
        {
          "mode": "hybrid",
          "ns": "bbbb0000-0000-0000-0000-000000000000:memory",
          "text": "how do transactions work here",
          "topK": 15,
        },
      ]
    `);
  });

  it('single scope=memory with a type filter', async () => {
    const { ks, calls } = store({ [`${TEAM}:memory`]: MEMORY_ROWS });
    const res = await handleRecallAction(memClient(['m-foreign']), { query: 'test runner', type: 'pattern', limit: 2 }, ctx(ks));
    expect(res.content[0].text).toMatchInlineSnapshot(`
      "Found 1 result(s) (filtered: type=pattern):

      ### 1. [pattern] [source](/app/memory/m2)
      **Score:** 0.6000
      [superseded: false]

      Use bun run test"
    `);
    expect(calls).toMatchInlineSnapshot(`
      [
        {
          "mode": "hybrid",
          "ns": "bbbb0000-0000-0000-0000-000000000000:memory",
          "text": "test runner",
          "topK": 50,
        },
      ]
    `);
  });

  it('multi scope memory + task, fused', async () => {
    const { ks, calls } = store({
      [`${TEAM}:memory`]: MEMORY_ROWS,
      [`${WS}:task`]: [{ id: 't1', content: '# Task: transactions', score: 0.4, sourceType: 'task' }],
    });
    const res = await handleRecallAction(memClient(['m-foreign']), { query: 'transactions', scope: ['memory', 'task'], limit: 4 }, ctx(ks));
    expect(res.content[0].text.replace(/\d+ days ago/g, 'N days ago')).toMatchInlineSnapshot(`
      "Found 4 result(s):

      ### 1. [gotcha] [source](/app/memory/m1)
      **Score:** 0.9100
      [savedAt: N days ago · superseded: false]

      Neon has no transactions

      ---

      ### 2. task · task
      **Score:** 0.4000

      # Task: transactions

      ---

      ### 3. [pattern] [source](/app/memory/m2)
      **Score:** 0.6000
      [superseded: false]

      Use bun run test

      ---

      ### 4. [discovery] memory
      **Score:** 0.3000
      [superseded: false]

      Low relevance"
    `);
    expect(calls).toMatchInlineSnapshot(`
      [
        {
          "mode": "lexical",
          "ns": "bbbb0000-0000-0000-0000-000000000000:memory",
          "text": "transactions",
          "topK": 20,
        },
        {
          "mode": "lexical",
          "ns": "aaaa0000-0000-0000-0000-000000000000:task",
          "text": "transactions",
          "topK": 4,
        },
      ]
    `);
  });
});

describe('golden: query_knowledge corpus=memory', () => {
  it('single corpus', async () => {
    const { ks, calls } = store({ [`${TEAM}:memory`]: MEMORY_ROWS });
    const res = await handleMemoryAction(memClient(['m-foreign']), 'query_knowledge', { query: 'transactions', corpus: 'memory', topK: 3 }, ctx(ks));
    expect(res.content[0].text.replace(/\d+ days ago/g, 'N days ago')).toMatchInlineSnapshot(`
      "Found 3 chunk(s) (mode: hybrid, namespace: bbbb0000-0000-0000-0000-000000000000:memory):

      ### 1. [gotcha] [source](/app/memory/m1)
      **Score:** 0.9100
      [savedAt: N days ago · superseded: false]

      Neon has no transactions

      ---

      ### 2. [decision] memory
      **Score:** 0.8000
      [superseded: true]

      Old belief

      ---

      ### 3. [pattern] [source](/app/memory/m2)
      **Score:** 0.6000
      [superseded: false]

      Use bun run test"
    `);
    expect(calls).toMatchInlineSnapshot(`
      [
        {
          "mode": "hybrid",
          "ns": "bbbb0000-0000-0000-0000-000000000000:memory",
          "text": "transactions",
          "topK": 15,
        },
      ]
    `);
  });
});

describe('golden: buildAuthoringPriorWork', () => {
  it('merges memory, task and pr, floors and caps at 5', async () => {
    const { ks, calls } = store({
      [`${TEAM}:memory`]: MEMORY_ROWS,
      [`${WS}:task`]: [
        { id: 't1', content: '# Task: A', score: 0.7, sourceType: 'task', metadata: { success: false } },
        { id: 't2', content: '# Task: B', score: 0.46, sourceType: 'task' },
      ],
      [`${WS}:pr`]: [{ id: 'pr1', content: '# PR #3: C', score: 0.65, sourceType: 'pr', metadata: { prNumber: 3 } }],
    });
    const scope: MemoryHitScope = {
      project: PROJECT,
      lookup: memClient(['m-foreign']).batch,
    };
    const out = await buildAuthoringPriorWork('transactions', WS, TEAM, ks, { paths: ['packages/core/db/client.ts'], memoryScope: scope });
    expect(out).toMatchInlineSnapshot(`
      "## Prior work
      - [0.91] | Neon has no transactions | 4d ago (/app/memory/m1)
      - [0.80] | Old belief
      - [0.70] | Task: A | failed
      - [0.65] | PR #3: C | PR #3
      - [0.60] | Use bun run test (/app/memory/m2)"
    `);
    expect(calls).toMatchInlineSnapshot(`
      [
        {
          "mode": undefined,
          "ns": "bbbb0000-0000-0000-0000-000000000000:memory",
          "text": "transactions",
          "topK": 25,
        },
        {
          "mode": undefined,
          "ns": "aaaa0000-0000-0000-0000-000000000000:task",
          "text": "transactions",
          "topK": 5,
        },
        {
          "mode": undefined,
          "ns": "aaaa0000-0000-0000-0000-000000000000:pr",
          "text": "transactions",
          "topK": 5,
        },
        {
          "mode": undefined,
          "ns": "aaaa0000-0000-0000-0000-000000000000:pr",
          "text": "packages/core/db/client.ts",
          "topK": 5,
        },
      ]
    `);
  });
});

describe('golden: claim_task Relevant Memory', () => {
  it('renders the section from the store search, in batch order', async () => {
    const memories = [
      { id: 'mem-2', type: 'pattern', title: 'Second', content: 'x'.repeat(250) },
      { id: 'mem-1', type: 'gotcha', title: 'First', content: 'short' },
    ];
    const search = mock(async (_q: any) => ({ results: [{ id: 'mem-1' }, { id: 'mem-2' }], total: 2 }));
    const batch = mock(async (_ids: string[]) => ({ memories }));
    const api = mock(async (endpoint: string) => {
      if (endpoint === '/api/workers/claim') {
        return {
          workers: [{
            id: 'worker-1',
            taskId: 'task-1',
            branch: 'buildd/x',
            openPRs: [],
            task: {
              id: 'task-1', title: 'Fix the login bug', description: 'd', workspaceId: WS,
              workspace: { id: WS, teamId: TEAM, repo: 'https://github.com/Acme/Widgets.git', name: 'widgets', dataClass: 'standard' },
            },
          }],
        };
      }
      return {};
    });
    const actx: ActionContext = {
      workspaceId: WS,
      authType: 'api',
      getWorkspaceId: async () => WS,
      getLevel: async () => 'worker',
      getMemoryClient: async () => ({ search, batch }) as any,
    };
    const res = await handleBuilddAction(api as any, 'claim_task', {}, actx);
    expect(res.content[0].text).toMatchInlineSnapshot(`
      "Claimed 1 task(s):

      **Worker ID:** worker-1
      **Task:** Fix the login bug
      **Branch:** buildd/x (push here — create_pr's head must be this branch, or another name nobody else is using)
      **Description:** d

      ## Relevant Memory
      READ these memories before starting work:
      - **[pattern] Second**: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx...
      - **[gotcha] First**: short

      Call recall with scope=["memory","task"] for prior lessons + recent outcomes in one fused call.

      Use the worker ID to report progress and completion."
    `);
    expect(search.mock.calls).toMatchInlineSnapshot(`
      [
        [
          {
            "limit": 5,
            "project": "acme/widgets",
            "query": "Fix the login bug",
            "states": [
              "active",
            ],
          },
        ],
      ]
    `);
    expect(batch.mock.calls).toMatchInlineSnapshot(`
      [
        [
          [
            "mem-1",
            "mem-2",
          ],
        ],
      ]
    `);
  });
});
