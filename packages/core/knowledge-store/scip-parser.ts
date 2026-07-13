// Pure, side-effect-free SCIP index → knowledge-graph parser (KM v2 spec §4,
// stream B2b). Given an already-produced SCIP index — either the raw protobuf
// buffer emitted by `scip-typescript` or an already-decoded object — it derives
// precise, cross-file `defines` / `references` / `imports` edges plus symbol
// alias seeds (`entity_aliases.source = 'scip'`).
//
// This module does NO I/O: no child_process, no fs, no DB. The side-effectful
// invocation of the `scip-typescript` binary lives in `scip-runner.ts`; keeping
// them apart is what makes this parser unit-testable against a hand-built
// fixture and safe to re-export from index.ts.
//
// Edge/entity keys are deliberately aligned with the ast-grep symbol layer
// (`entity-extractor.ts`): file entities are keyed by repo-relative path and
// symbol entities by `${file}#${qualifiedName}`, so SCIP precision layers
// ADDITIVELY on top of the ast-grep graph — same symbol entity, extra edges —
// and never supersedes it (distinct `rule` prefixes: `scip:*` vs `astgrep:*`).

import type { EdgeUpsert, EntityUpsert } from './types';

// ── SCIP symbol roles (bitfield, from scip.proto SymbolRole) ──────────────────
export const SCIP_ROLE_DEFINITION = 0x1;
export const SCIP_ROLE_IMPORT = 0x2;

// ── Edge weights — mirror edge-builder.ts so SCIP edges rank consistently ─────
const WEIGHT_DEFINES = 1.0;
const WEIGHT_REFERENCES = 0.5;
const WEIGHT_IMPORTS = 0.8;

// ── Decoded SCIP index shape (the subset we consume) ──────────────────────────

export interface ScipOccurrence {
  /** SCIP symbol moniker, e.g. `scip-typescript npm pkg 1.0 src/a.ts/foo().`. */
  symbol: string;
  /** SymbolRole bitfield (Definition = 0x1, Import = 0x2, …). */
  symbolRoles: number;
}

export interface ScipSymbolInformation {
  symbol: string;
  displayName?: string;
}

export interface ScipDocument {
  /** Repo-relative path of the document. */
  relativePath: string;
  occurrences: ScipOccurrence[];
  symbols?: ScipSymbolInformation[];
}

export interface ScipIndex {
  documents: ScipDocument[];
}

// ── Output graph ──────────────────────────────────────────────────────────────

export interface ScipAliasSeed {
  entityKind: 'symbol';
  entityKey: string;
  alias: string;
  source: 'scip';
}

export interface ScipGraph {
  entities: EntityUpsert[];
  edges: EdgeUpsert[];
  aliases: ScipAliasSeed[];
  stats: {
    documents: number;
    definitions: number;
    references: number;
    imports: number;
    aliases: number;
  };
}

// ── Symbol moniker parsing ────────────────────────────────────────────────────

export interface ParsedScipSymbol {
  isLocal: boolean;
  /** Namespace (`/`-suffixed) descriptor names — the module/file path portion. */
  moduleDescriptors: string[];
  /** Non-namespace descriptor names — the qualified symbol path (Type.method). */
  symbolDescriptors: string[];
}

const DELIMS = new Set(['/', '#', '.', ':', '!', '(', '[']);

/**
 * Parse a SCIP symbol moniker into module vs. symbol descriptors. Tolerant of
 * backtick-escaped identifiers and method disambiguators; returns null when the
 * moniker can't be parsed (caller then skips that symbol — graceful).
 *
 * SCIP grammar: `<scheme> ' ' <manager> ' ' <name> ' ' <version> ' ' {descriptor}`
 * with `local <id>` for file-local symbols. Descriptor suffixes: `/` namespace,
 * `#` type, `.` term, `:` meta, `!` macro, `(disambiguator).` method.
 */
export function parseScipSymbol(symbol: string): ParsedScipSymbol | null {
  const trimmed = symbol.trim();
  if (!trimmed) return null;
  if (trimmed === 'local' || trimmed.startsWith('local ')) {
    return { isLocal: true, moduleDescriptors: [], symbolDescriptors: [] };
  }

  // Split the 4-token header (scheme manager name version) off the front,
  // honouring SCIP's double-space escape for spaces inside a token.
  const header = splitHeader(trimmed);
  if (!header) return null;
  const descriptorStr = header.rest;
  if (!descriptorStr) return null;

  const moduleDescriptors: string[] = [];
  const symbolDescriptors: string[] = [];
  let i = 0;
  const n = descriptorStr.length;
  while (i < n) {
    const [name, afterName] = readName(descriptorStr, i);
    if (name === null) return null;
    i = afterName;
    if (i >= n) return null; // a descriptor must end in a suffix
    const suffix = descriptorStr[i];
    if (suffix === '(') {
      // method: skip disambiguator to matching ')', then require a '.'
      const close = descriptorStr.indexOf(')', i);
      if (close === -1) return null;
      i = close + 1;
      if (descriptorStr[i] !== '.') return null;
      i += 1;
      symbolDescriptors.push(name);
    } else if (suffix === '[') {
      // type-parameter — skip to ']' (not part of the symbol name path)
      const close = descriptorStr.indexOf(']', i);
      if (close === -1) return null;
      i = close + 1;
    } else if (suffix === '/') {
      moduleDescriptors.push(name);
      i += 1;
    } else if (suffix === '#' || suffix === '.' || suffix === ':' || suffix === '!') {
      symbolDescriptors.push(name);
      i += 1;
    } else {
      return null;
    }
  }
  return { isLocal: false, moduleDescriptors, symbolDescriptors };
}

/** Read the 4 header tokens; return the remaining descriptor substring. */
function splitHeader(s: string): { rest: string } | null {
  let tokens = 0;
  let i = 0;
  const n = s.length;
  while (i < n && tokens < 4) {
    // consume a token (with double-space escape inside), then its separator
    while (i < n) {
      if (s[i] === ' ') {
        if (s[i + 1] === ' ') {
          i += 2; // escaped literal space inside the token
          continue;
        }
        break; // real separator
      }
      i += 1;
    }
    if (i >= n) return null; // ran out before 4 tokens + descriptors
    i += 1; // skip the separating space
    tokens += 1;
  }
  if (tokens < 4) return null;
  return { rest: s.slice(i) };
}

/** Read one descriptor name (bare or backtick-escaped) starting at `start`. */
function readName(s: string, start: number): [string | null, number] {
  if (s[start] === '`') {
    // backtick-escaped: `` is a literal backtick; closes on a lone backtick
    let i = start + 1;
    let out = '';
    while (i < s.length) {
      if (s[i] === '`') {
        if (s[i + 1] === '`') {
          out += '`';
          i += 2;
          continue;
        }
        return [out, i + 1];
      }
      out += s[i];
      i += 1;
    }
    return [null, i]; // unterminated
  }
  let i = start;
  let out = '';
  while (i < s.length && !DELIMS.has(s[i])) {
    out += s[i];
    i += 1;
  }
  return [out === '' ? null : out, i];
}

// ── Graph builder ─────────────────────────────────────────────────────────────

interface DefTarget {
  file: string;
  /** Symbol entity key `${file}#${qualifiedName}`. */
  key: string;
  qualifiedName: string;
  terminalName: string;
}

function fileBasename(p: string): string {
  return p.split('/').pop() ?? p;
}

/**
 * Build the precise SCIP code graph from a decoded index.
 *
 * Two passes: (1) index every Definition occurrence so cross-file references
 * and imports can resolve their target's defining file; (2) emit edges.
 * Definitions produce `(file) -defines-> (symbol)`; imports produce
 * `(file) -imports-> (file)`; all other resolvable occurrences produce
 * `(file) -references-> (symbol)`. Everything is deduped and additive.
 */
export function buildScipGraph(index: ScipIndex, opts: { workspaceId: string }): ScipGraph {
  const { workspaceId } = opts;
  const defBySymbol = new Map<string, DefTarget>();

  // ── Pass 1: collect definitions (the resolution table) ──────────────────────
  for (const doc of index.documents) {
    for (const occ of doc.occurrences) {
      if (!(occ.symbolRoles & SCIP_ROLE_DEFINITION)) continue;
      const target = defTargetFor(occ.symbol, doc.relativePath);
      if (target) defBySymbol.set(occ.symbol, target);
    }
  }

  const entities = new Map<string, EntityUpsert>();
  const edges: EdgeUpsert[] = [];
  const aliases = new Map<string, ScipAliasSeed>();
  const seenEdge = new Set<string>();

  const addEntity = (e: EntityUpsert) => {
    const k = `${e.kind}:${e.key}`;
    if (!entities.has(k)) entities.set(k, e);
  };
  const addEdge = (e: EdgeUpsert) => {
    const k = `${e.fromEntityKind}:${e.fromEntityKey}→${e.type}→${e.toEntityKind}:${e.toEntityKey}`;
    if (seenEdge.has(k)) return;
    seenEdge.add(k);
    edges.push(e);
  };
  const fileEntity = (path: string): void =>
    addEntity({ workspaceId, kind: 'file', key: path, canonicalName: fileBasename(path) });
  const symbolEntity = (t: DefTarget): void => {
    addEntity({
      workspaceId,
      kind: 'symbol',
      key: t.key,
      canonicalName: t.terminalName,
      role: 'defines',
      attributes: { scip: true },
    });
    // Seed aliases for both the bare terminal name and the qualified path so
    // agent refs like `method` or `Class.method` auto-bind.
    for (const alias of new Set([t.terminalName, t.qualifiedName])) {
      if (!alias) continue;
      const ak = `${t.key}::${alias.toLowerCase()}`;
      if (!aliases.has(ak)) {
        aliases.set(ak, { entityKind: 'symbol', entityKey: t.key, alias, source: 'scip' });
      }
    }
  };

  // ── Pass 2: emit edges ──────────────────────────────────────────────────────
  for (const doc of index.documents) {
    const fromFile = doc.relativePath;
    fileEntity(fromFile);
    for (const occ of doc.occurrences) {
      const isDef = !!(occ.symbolRoles & SCIP_ROLE_DEFINITION);
      const isImport = !!(occ.symbolRoles & SCIP_ROLE_IMPORT);

      if (isDef) {
        const t = defTargetFor(occ.symbol, fromFile);
        if (!t) continue;
        symbolEntity(t);
        addEdge(edge(workspaceId, fromFile, 'file', t.key, 'symbol', 'defines', WEIGHT_DEFINES, 'scip:defines'));
        continue;
      }

      const target = defBySymbol.get(occ.symbol);
      if (!target) continue; // unresolvable (external/local) — skip

      if (isImport) {
        if (target.file !== fromFile) {
          fileEntity(target.file);
          addEdge(edge(workspaceId, fromFile, 'file', target.file, 'file', 'imports', WEIGHT_IMPORTS, 'scip:imports'));
        }
        continue;
      }

      symbolEntity(target);
      addEdge(edge(workspaceId, fromFile, 'file', target.key, 'symbol', 'references', WEIGHT_REFERENCES, 'scip:references'));
    }
  }

  const aliasList = [...aliases.values()];
  // Stats count the deduped edges actually emitted (not raw occurrences).
  const byType = (t: string) => edges.filter(e => e.type === t).length;
  return {
    entities: [...entities.values()],
    edges,
    aliases: aliasList,
    stats: {
      documents: index.documents.length,
      definitions: byType('defines'),
      references: byType('references'),
      imports: byType('imports'),
      aliases: aliasList.length,
    },
  };
}

/**
 * Accept a raw protobuf buffer or an already-decoded index, and return the
 * graph. The single convenience entry point for callers.
 */
export function parseScipIndex(input: Buffer | Uint8Array | ScipIndex, opts: { workspaceId: string }): ScipGraph {
  const index = isDecodedIndex(input) ? input : decodeScipIndex(input);
  return buildScipGraph(index, opts);
}

function isDecodedIndex(input: Buffer | Uint8Array | ScipIndex): input is ScipIndex {
  return !Buffer.isBuffer(input) && !(input instanceof Uint8Array) && Array.isArray((input as ScipIndex).documents);
}

function defTargetFor(symbol: string, file: string): DefTarget | null {
  const parsed = parseScipSymbol(symbol);
  if (!parsed || parsed.isLocal || parsed.symbolDescriptors.length === 0) return null;
  const qualifiedName = parsed.symbolDescriptors.join('.');
  const terminalName = parsed.symbolDescriptors[parsed.symbolDescriptors.length - 1];
  return { file, key: `${file}#${qualifiedName}`, qualifiedName, terminalName };
}

function edge(
  workspaceId: string,
  fromKey: string,
  fromKind: EdgeUpsert['fromEntityKind'],
  toKey: string,
  toKind: EdgeUpsert['toEntityKind'],
  type: EdgeUpsert['type'],
  weight: number,
  rule: string,
): EdgeUpsert {
  return {
    workspaceId,
    fromEntityKey: fromKey,
    fromEntityKind: fromKind,
    toEntityKey: toKey,
    toEntityKind: toKind,
    type,
    weight,
    rule,
  };
}

// ── Minimal SCIP protobuf decoder ─────────────────────────────────────────────
// scip-typescript emits an `index.scip` protobuf. Rather than depend on a
// protobuf runtime + generated bindings (heavy, and another native-ish dep in
// the graph), we decode only the handful of wire fields this parser consumes.
// Unknown fields are skipped by wire type, so schema additions never break us.

interface RawField {
  field: number;
  wire: number;
  varint?: number;
  bytes?: Buffer;
}

function* iterFields(buf: Buffer): Generator<RawField> {
  let pos = 0;
  while (pos < buf.length) {
    let tag: number;
    [tag, pos] = readVarint(buf, pos);
    const field = tag >>> 3;
    const wire = tag & 0x7;
    if (wire === 0) {
      let v: number;
      [v, pos] = readVarint(buf, pos);
      yield { field, wire, varint: v };
    } else if (wire === 2) {
      let len: number;
      [len, pos] = readVarint(buf, pos);
      const bytes = buf.subarray(pos, pos + len);
      pos += len;
      yield { field, wire, bytes };
    } else if (wire === 1) {
      pos += 8;
    } else if (wire === 5) {
      pos += 4;
    } else {
      throw new Error(`unsupported protobuf wire type ${wire}`);
    }
  }
}

function readVarint(buf: Buffer, pos: number): [number, number] {
  let result = 0;
  let shift = 0;
  while (true) {
    if (pos >= buf.length) throw new Error('varint truncated');
    const b = buf[pos++];
    result += (b & 0x7f) * Math.pow(2, shift);
    if ((b & 0x80) === 0) break;
    shift += 7;
  }
  return [result, pos];
}

/** Decode an `index.scip` protobuf buffer into the subset shape we consume. */
export function decodeScipIndex(buf: Buffer | Uint8Array): ScipIndex {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const documents: ScipDocument[] = [];
  for (const f of iterFields(b)) {
    if (f.field === 2 && f.bytes) documents.push(decodeDocument(f.bytes));
  }
  return { documents };
}

function decodeDocument(buf: Buffer): ScipDocument {
  let relativePath = '';
  const occurrences: ScipOccurrence[] = [];
  const symbols: ScipSymbolInformation[] = [];
  for (const f of iterFields(buf)) {
    if (f.field === 1 && f.bytes) relativePath = f.bytes.toString('utf8');
    else if (f.field === 2 && f.bytes) occurrences.push(decodeOccurrence(f.bytes));
    else if (f.field === 3 && f.bytes) symbols.push(decodeSymbolInformation(f.bytes));
  }
  return { relativePath, occurrences, symbols };
}

function decodeOccurrence(buf: Buffer): ScipOccurrence {
  let symbol = '';
  let symbolRoles = 0;
  for (const f of iterFields(buf)) {
    if (f.field === 2 && f.bytes) symbol = f.bytes.toString('utf8');
    else if (f.field === 3 && f.varint !== undefined) symbolRoles = f.varint;
  }
  return { symbol, symbolRoles };
}

function decodeSymbolInformation(buf: Buffer): ScipSymbolInformation {
  let symbol = '';
  let displayName: string | undefined;
  for (const f of iterFields(buf)) {
    if (f.field === 1 && f.bytes) symbol = f.bytes.toString('utf8');
    else if (f.field === 6 && f.bytes) displayName = f.bytes.toString('utf8');
  }
  return { symbol, displayName };
}
