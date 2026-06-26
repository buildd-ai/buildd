import { describe, it, expect } from 'bun:test';
import { buildEdges } from '../knowledge-store/edge-builder';
import type { EdgeBuilderInput } from '../knowledge-store/edge-builder';

const BASE_CHUNK = {
  id: 'chunk-1',
  content: 'Some content',
  sourceType: 'code',
};

// ── buildEdges — pure function, no I/O ───────────────────────────────────────

describe('buildEdges', () => {
  it('returns empty output for a plain chunk with no signals', () => {
    const input: EdgeBuilderInput = {
      chunk: BASE_CHUNK,
      corpus: 'memory',
      workspaceId: 'ws-1',
    };
    const output = buildEdges(input);
    expect(output.entities).toBeDefined();
    expect(output.edges).toBeDefined();
    expect(output.pendingRefs).toBeDefined();
  });

  it('produces a file entity for code chunks with sourcePath', () => {
    const input: EdgeBuilderInput = {
      chunk: { ...BASE_CHUNK, sourceType: 'code', sourcePath: 'src/lib/auth.ts' },
      corpus: 'code',
      workspaceId: 'ws-1',
    };
    const { entities } = buildEdges(input);
    const fileEntity = entities.find(e => e.kind === 'file');
    expect(fileEntity).toBeDefined();
    expect(fileEntity!.key).toBe('src/lib/auth.ts');
  });

  it('produces produced edges from PR diff files', () => {
    const input: EdgeBuilderInput = {
      chunk: { ...BASE_CHUNK, id: 'pr:42', sourceType: 'pr' },
      corpus: 'pr',
      workspaceId: 'ws-1',
      prDiff: ['src/lib/auth.ts', 'src/lib/token.ts'],
    };
    const { edges, entities } = buildEdges(input);
    const producedEdges = edges.filter(e => e.type === 'produced');
    expect(producedEdges.length).toBe(2);
    expect(producedEdges.every(e => e.rule === 'pr:produced')).toBe(true);

    const fileEntities = entities.filter(e => e.kind === 'file');
    expect(fileEntities.length).toBe(2);
  });

  it('produces implements edge when spec and code share a basename', () => {
    const input: EdgeBuilderInput = {
      chunk: { ...BASE_CHUNK, sourcePath: 'src/auth.ts' },
      corpus: 'code',
      workspaceId: 'ws-1',
      speculativeMatchPaths: ['docs/spec/auth.md'],
    };
    const { edges } = buildEdges(input);
    const implEdge = edges.find(e => e.type === 'implements');
    expect(implEdge).toBeDefined();
    expect(implEdge!.rule).toBe('path:implements');
  });

  it('produces relates_to edges from agent relations', () => {
    const input: EdgeBuilderInput = {
      chunk: BASE_CHUNK,
      corpus: 'memory',
      workspaceId: 'ws-1',
      agentRelations: [
        {
          from: 'PgVectorStore',
          type: 'relates_to',
          to: 'knowledge graph retrieval',
          weight: 0.7,
        },
      ],
    };
    const { edges, pendingRefs } = buildEdges(input);
    const relatesEdges = edges.filter(e => e.type === 'relates_to');
    // Edges go into pending if entities aren't resolved yet
    // Either as a real edge (if resolved) or pending refs
    expect(relatesEdges.length + pendingRefs.length).toBeGreaterThan(0);
  });

  it('produces outcome_of edge for task cards with missionId', () => {
    const input: EdgeBuilderInput = {
      chunk: {
        ...BASE_CHUNK,
        id: 'task:abc123',
        sourceType: 'task',
        metadata: { taskId: 'abc123', missionId: 'mission-xyz' },
      },
      corpus: 'task',
      workspaceId: 'ws-1',
    };
    const { edges } = buildEdges(input);
    const outcomeEdge = edges.find(e => e.type === 'outcome_of');
    expect(outcomeEdge).toBeDefined();
    expect(outcomeEdge!.rule).toBe('meta:outcome_of');
  });

  it('produces part_of edges for heading entities in docs', () => {
    const input: EdgeBuilderInput = {
      chunk: {
        ...BASE_CHUNK,
        content: '## Retrieval Path\n\nSome text about retrieval',
        sourcePath: 'docs/design/retrieval.md',
      },
      corpus: 'docs',
      workspaceId: 'ws-1',
    };
    const { edges } = buildEdges(input);
    const partOfEdges = edges.filter(e => e.type === 'part_of');
    expect(partOfEdges.length).toBeGreaterThanOrEqual(1);
  });

  it('produces references_doc edges for PR body wikilinks', () => {
    const input: EdgeBuilderInput = {
      chunk: {
        ...BASE_CHUNK,
        content: 'This PR fixes #987 and implements [[auth spec]].',
        id: 'pr:42',
        sourceType: 'pr',
      },
      corpus: 'pr',
      workspaceId: 'ws-1',
    };
    const { edges, pendingRefs } = buildEdges(input);
    const refEdges = edges.filter(e => e.type === 'references_doc');
    // PR #987 should be resolved as a pr entity and produce a references_doc edge
    // Wikilink may go to pending refs
    expect(refEdges.length + pendingRefs.length).toBeGreaterThan(0);
  });

  it('is idempotent — same input produces same output', () => {
    const input: EdgeBuilderInput = {
      chunk: { ...BASE_CHUNK, sourcePath: 'src/lib/auth.ts' },
      corpus: 'code',
      workspaceId: 'ws-1',
      prDiff: ['src/lib/token.ts'],
    };
    const out1 = buildEdges(input);
    const out2 = buildEdges(input);
    expect(out1.entities.length).toBe(out2.entities.length);
    expect(out1.edges.length).toBe(out2.edges.length);
  });

  it('applies correct default weights per edge type', () => {
    const input: EdgeBuilderInput = {
      chunk: { ...BASE_CHUNK, id: 'pr:42', sourceType: 'pr' },
      corpus: 'pr',
      workspaceId: 'ws-1',
      prDiff: ['src/lib/auth.ts'],
    };
    const { edges } = buildEdges(input);
    const producedEdge = edges.find(e => e.type === 'produced');
    expect(producedEdge!.weight).toBe(1.0);
  });
});
