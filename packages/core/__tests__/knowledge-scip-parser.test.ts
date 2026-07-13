import { describe, it, expect } from 'bun:test';
import {
  parseScipSymbol,
  buildScipGraph,
  decodeScipIndex,
  parseScipIndex,
  SCIP_ROLE_DEFINITION,
  SCIP_ROLE_IMPORT,
  type ScipIndex,
} from '../knowledge-store/scip-parser';

// SCIP monikers encode file-path segments as backtick-escaped namespace
// descriptors (segments contain dots). scip-typescript emits exactly this.
const S = (path: string, sym: string) =>
  `scip-typescript npm mypkg 1.0.0 ${path.split('/').map(seg => '`' + seg + '`').join('/')}/${sym}`;

const ADD = S('src/math.ts', 'add().'); // top-level function `add`
const MAIN = S('src/app.ts', 'main().'); // top-level function `main`
const BAR = S('src/svc.ts', 'Foo#bar().'); // method Foo.bar

// ── parseScipSymbol ────────────────────────────────────────────────────────────

describe('parseScipSymbol', () => {
  it('splits module namespaces from the symbol path for a top-level function', () => {
    const p = parseScipSymbol(ADD);
    expect(p).not.toBeNull();
    expect(p!.isLocal).toBe(false);
    expect(p!.moduleDescriptors).toEqual(['src', 'math.ts']);
    expect(p!.symbolDescriptors).toEqual(['add']);
  });

  it('captures type + method descriptors as a qualified symbol path', () => {
    const p = parseScipSymbol(BAR);
    expect(p!.symbolDescriptors).toEqual(['Foo', 'bar']);
  });

  it('handles type (#) and term (.) descriptors', () => {
    expect(parseScipSymbol(S('src/t.ts', 'MyType#'))!.symbolDescriptors).toEqual(['MyType']);
    expect(parseScipSymbol(S('src/c.ts', 'CONST.'))!.symbolDescriptors).toEqual(['CONST']);
  });

  it('flags local symbols', () => {
    const p = parseScipSymbol('local 12');
    expect(p!.isLocal).toBe(true);
    expect(p!.symbolDescriptors).toEqual([]);
  });

  it('returns null for malformed monikers', () => {
    expect(parseScipSymbol('')).toBeNull();
    expect(parseScipSymbol('only three tokens here')).toBeNull();
  });
});

// ── buildScipGraph (decoded object) ────────────────────────────────────────────

function fixtureIndex(): ScipIndex {
  return {
    documents: [
      {
        relativePath: 'src/math.ts',
        occurrences: [{ symbol: ADD, symbolRoles: SCIP_ROLE_DEFINITION }],
        symbols: [{ symbol: ADD, displayName: 'add' }],
      },
      {
        relativePath: 'src/app.ts',
        occurrences: [
          { symbol: ADD, symbolRoles: SCIP_ROLE_IMPORT }, // import of add
          { symbol: ADD, symbolRoles: 0 }, // reference to add
          { symbol: ADD, symbolRoles: 0 }, // duplicate reference (must dedupe)
          { symbol: MAIN, symbolRoles: SCIP_ROLE_DEFINITION }, // local def
          { symbol: 'local 3', symbolRoles: 0 }, // local — skipped
          { symbol: S('ext/lib.ts', 'ghost().'), symbolRoles: 0 }, // unresolved — skipped
        ],
      },
    ],
  };
}

describe('buildScipGraph', () => {
  const graph = buildScipGraph(fixtureIndex(), { workspaceId: 'ws-1' });
  const edgeKeys = graph.edges.map(
    e => `${e.fromEntityKind}:${e.fromEntityKey}-${e.type}->${e.toEntityKind}:${e.toEntityKey}`,
  );

  it('emits defines edges to symbol entities keyed like the ast-grep layer', () => {
    expect(edgeKeys).toContain('file:src/math.ts-defines->symbol:src/math.ts#add');
    expect(edgeKeys).toContain('file:src/app.ts-defines->symbol:src/app.ts#main');
  });

  it('emits a cross-file imports edge from the import occurrence', () => {
    expect(edgeKeys).toContain('file:src/app.ts-imports->file:src/math.ts');
  });

  it('emits a references edge resolved to the definition file', () => {
    expect(edgeKeys).toContain('file:src/app.ts-references->symbol:src/math.ts#add');
  });

  it('dedupes duplicate reference occurrences', () => {
    const refs = edgeKeys.filter(k => k.includes('-references->symbol:src/math.ts#add'));
    expect(refs).toHaveLength(1);
  });

  it('skips local and unresolvable symbols', () => {
    expect(edgeKeys.some(k => k.includes('ghost'))).toBe(false);
    expect(edgeKeys.some(k => k.includes('local'))).toBe(false);
  });

  it('seeds scip-sourced aliases for defined symbols', () => {
    const addAlias = graph.aliases.find(a => a.entityKey === 'src/math.ts#add');
    expect(addAlias).toEqual({ entityKind: 'symbol', entityKey: 'src/math.ts#add', alias: 'add', source: 'scip' });
    expect(graph.aliases.every(a => a.source === 'scip')).toBe(true);
  });

  it('produces file + symbol entities and correct stats', () => {
    const entityKeys = graph.entities.map(e => `${e.kind}:${e.key}`).sort();
    expect(entityKeys).toContain('file:src/math.ts');
    expect(entityKeys).toContain('symbol:src/math.ts#add');
    expect(graph.stats).toEqual({ documents: 2, definitions: 2, references: 1, imports: 1, aliases: 2 });
  });

  it('marks symbol entities with role defines and a scip attribute', () => {
    const sym = graph.entities.find(e => e.key === 'src/math.ts#add');
    expect(sym!.role).toBe('defines');
    expect(sym!.attributes).toEqual({ scip: true });
  });
});

// ── Protobuf decoder ────────────────────────────────────────────────────────────
// A minimal encoder mirrors the decoder's field layout so we can prove the
// wire-format reader against a real buffer (not just a hand-decoded object).

function varint(n: number): number[] {
  const out: number[] = [];
  while (n > 0x7f) {
    out.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n & 0x7f);
  return out;
}
const tag = (field: number, wire: number) => varint((field << 3) | wire);
const lenDelim = (field: number, bytes: number[]) => [...tag(field, 2), ...varint(bytes.length), ...bytes];
const strField = (field: number, s: string) => lenDelim(field, [...Buffer.from(s, 'utf8')]);
const intField = (field: number, n: number) => [...tag(field, 0), ...varint(n)];

function encOccurrence(symbol: string, roles: number): number[] {
  return [...strField(2, symbol), ...intField(3, roles)];
}
function encDocument(relativePath: string, occs: Array<[string, number]>): number[] {
  return [
    ...strField(1, relativePath),
    ...occs.flatMap(([sym, roles]) => lenDelim(2, encOccurrence(sym, roles))),
  ];
}
function encIndex(docs: Array<{ path: string; occs: Array<[string, number]> }>): Buffer {
  return Buffer.from(docs.flatMap(d => lenDelim(2, encDocument(d.path, d.occs))));
}

describe('decodeScipIndex', () => {
  const buf = encIndex([
    { path: 'src/math.ts', occs: [[ADD, SCIP_ROLE_DEFINITION]] },
    { path: 'src/app.ts', occs: [[ADD, SCIP_ROLE_IMPORT], [MAIN, SCIP_ROLE_DEFINITION]] },
  ]);

  it('decodes documents, relative paths, symbols and roles from the wire format', () => {
    const idx = decodeScipIndex(buf);
    expect(idx.documents.map(d => d.relativePath)).toEqual(['src/math.ts', 'src/app.ts']);
    expect(idx.documents[0].occurrences[0]).toEqual({ symbol: ADD, symbolRoles: SCIP_ROLE_DEFINITION });
    expect(idx.documents[1].occurrences[0].symbolRoles).toBe(SCIP_ROLE_IMPORT);
  });

  it('parseScipIndex accepts a buffer and yields the same graph as the decoded object', () => {
    const fromBuf = parseScipIndex(buf, { workspaceId: 'ws-1' });
    const fromObj = parseScipIndex(decodeScipIndex(buf), { workspaceId: 'ws-1' });
    expect(fromBuf.edges.length).toBe(fromObj.edges.length);
    expect(fromBuf.stats).toEqual(fromObj.stats);
    // The buffer path found the same precise edges.
    const keys = fromBuf.edges.map(e => `${e.fromEntityKey}-${e.type}->${e.toEntityKey}`);
    expect(keys).toContain('src/app.ts-imports->src/math.ts');
    expect(keys).toContain('src/math.ts-defines->src/math.ts#add');
  });

  it('skips unknown wire fields without breaking', () => {
    // Prepend a bogus varint field (field 99) to a document; decode must ignore it.
    const doc = [...intField(99, 12345), ...encDocument('src/x.ts', [[MAIN, SCIP_ROLE_DEFINITION]])];
    const idx = decodeScipIndex(Buffer.from(lenDelim(2, doc)));
    expect(idx.documents[0].relativePath).toBe('src/x.ts');
    expect(idx.documents[0].occurrences[0].symbol).toBe(MAIN);
  });
});
