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

  it('merges SCIP edges/entities additively without dropping ast-grep edges', () => {
    const input: EdgeBuilderInput = {
      chunk: {
        ...BASE_CHUNK,
        sourceType: 'code',
        sourcePath: 'src/a.ts',
        metadata: { startLine: 1, endLine: 20, symbols: [{ name: 'foo', kind: 'function', startLine: 1, endLine: 5 }] },
      },
      corpus: 'code',
      workspaceId: 'ws-1',
      // A duplicate of the ast-grep defines edge plus a SCIP-only cross-file edge.
      scipEdges: [
        {
          workspaceId: 'ws-1',
          fromEntityKey: 'src/a.ts',
          fromEntityKind: 'file',
          toEntityKey: 'src/a.ts#foo',
          toEntityKind: 'symbol',
          type: 'defines',
          weight: 1.0,
          rule: 'scip:defines',
        },
        {
          workspaceId: 'ws-1',
          fromEntityKey: 'src/a.ts',
          fromEntityKind: 'file',
          toEntityKey: 'src/b.ts',
          toEntityKind: 'file',
          type: 'imports',
          weight: 0.8,
          rule: 'scip:imports',
        },
      ],
      scipEntities: [
        { workspaceId: 'ws-1', kind: 'file', key: 'src/b.ts', canonicalName: 'b.ts' },
      ],
    };
    const { edges } = buildEdges(input);
    const defines = edges.filter(e => e.type === 'defines' && e.toEntityKey === 'src/a.ts#foo');
    // Duplicate collapsed to one, and ast-grep's rule wins (emitted first).
    expect(defines).toHaveLength(1);
    expect(defines[0].rule).toBe('astgrep:definition');
    // The SCIP-only cross-file import edge survives.
    expect(edges.some(e => e.type === 'imports' && e.toEntityKey === 'src/b.ts' && e.rule === 'scip:imports')).toBe(true);
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

// ── symbol defines / imports edges (ast-grep symbol layer) ──────────────────

describe('buildEdges — symbols and imports', () => {
  const SYMBOLS = [
    { name: 'foo', kind: 'function', startLine: 2, endLine: 4, exported: true },
    { name: 'Widget', kind: 'class', startLine: 6, endLine: 9, exported: true },
  ];
  const IMPORTS = [
    { specifier: './token', resolvedPath: 'src/lib/token' },
    { specifier: 'react', resolvedPath: null },
  ];

  it('emits file -defines-> symbol edges with rule astgrep:definition', () => {
    const { entities, edges } = buildEdges({
      chunk: { ...BASE_CHUNK, sourcePath: 'src/lib/auth.ts' },
      corpus: 'code',
      workspaceId: 'ws-1',
      symbols: SYMBOLS,
    });
    const symbolEntities = entities.filter(e => e.kind === 'symbol');
    expect(symbolEntities).toHaveLength(2);
    expect(symbolEntities[0].key).toBe('src/lib/auth.ts#foo');

    const defines = edges.filter(e => e.type === 'defines');
    expect(defines).toHaveLength(2);
    for (const e of defines) {
      expect(e.fromEntityKey).toBe('src/lib/auth.ts');
      expect(e.fromEntityKind).toBe('file');
      expect(e.toEntityKind).toBe('symbol');
      expect(e.rule).toBe('astgrep:definition');
    }
    expect(defines.map(e => e.toEntityKey).sort()).toEqual([
      'src/lib/auth.ts#Widget',
      'src/lib/auth.ts#foo',
    ]);
  });

  it('emits file -imports-> file edges only for resolved relative imports', () => {
    const { entities, edges } = buildEdges({
      chunk: { ...BASE_CHUNK, sourcePath: 'src/lib/auth.ts' },
      corpus: 'code',
      workspaceId: 'ws-1',
      imports: IMPORTS,
    });
    const importEdges = edges.filter(e => e.type === 'imports');
    expect(importEdges).toHaveLength(1);
    expect(importEdges[0].fromEntityKey).toBe('src/lib/auth.ts');
    expect(importEdges[0].toEntityKey).toBe('src/lib/token');
    expect(importEdges[0].toEntityKind).toBe('file');
    expect(importEdges[0].rule).toBe('astgrep:import');
    // The imported file gets an entity so the edge can bind.
    expect(entities.some(e => e.kind === 'file' && e.key === 'src/lib/token')).toBe(true);
  });

  it('reads symbols and imports from chunk metadata when not passed explicitly', () => {
    const { edges } = buildEdges({
      chunk: {
        ...BASE_CHUNK,
        sourcePath: 'src/lib/auth.ts',
        metadata: { startLine: 1, endLine: 20, symbols: SYMBOLS, imports: IMPORTS },
      },
      corpus: 'code',
      workspaceId: 'ws-1',
    });
    expect(edges.filter(e => e.type === 'defines')).toHaveLength(2);
    expect(edges.filter(e => e.type === 'imports')).toHaveLength(1);
  });

  it('respects the chunk line range for defines edges', () => {
    const { edges } = buildEdges({
      chunk: {
        ...BASE_CHUNK,
        sourcePath: 'src/lib/auth.ts',
        metadata: { startLine: 1, endLine: 5 },
      },
      corpus: 'code',
      workspaceId: 'ws-1',
      symbols: SYMBOLS,
    });
    const defines = edges.filter(e => e.type === 'defines');
    expect(defines).toHaveLength(1);
    expect(defines[0].toEntityKey).toBe('src/lib/auth.ts#foo');
  });

  it('emits no symbol/import edges without a sourcePath', () => {
    const { edges } = buildEdges({
      chunk: BASE_CHUNK,
      corpus: 'code',
      workspaceId: 'ws-1',
      symbols: SYMBOLS,
      imports: IMPORTS,
    });
    expect(edges.filter(e => e.type === 'defines')).toHaveLength(0);
    expect(edges.filter(e => e.type === 'imports')).toHaveLength(0);
  });
});
