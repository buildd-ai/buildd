import { createHash } from 'crypto';
import type { KnowledgeStore, UpsertChunk, Corpus } from './types';
import {
  chunkMarkdown,
  chunkCode,
  chunkCodeSymbols,
  type ChunkOptions,
  type ChunkPiece,
} from './chunker';
import { buildNamespace } from './pg-vector-store';
import type { ExtractedSymbol, ExtractedImport } from './symbol-extractor';

// Phase 2 ingestion: turn source files (code, docs) into multiple retrievable
// chunks. A file becomes N chunks whose ids are `path#startLine` — stable
// across re-ingests of unchanged regions and unique within the file. Re-ingest
// first clears the file's existing chunks (via deleteBySource) so a file that
// shrank doesn't leave orphaned tail chunks behind.
//
// For the code corpus in supported languages (ts/tsx/js/jsx), chunking is
// symbol-boundary-aligned via ast-grep (spec §4, B1). The native binary is
// loaded through a dynamic import inside symbol-extractor.ts; when it is
// unavailable (e.g. serverless bundles) the line-window splitter output is
// byte-identical to the pre-B1 behavior.

export interface SourceFile {
  /** Repo-relative path — used as sourcePath and id prefix. */
  path: string;
  content: string;
  /** Optional base URL; chunks get `#L<startLine>` appended. */
  sourceUrl?: string;
  /** Source timestamp (git commit time or mtime). Passed through to UpsertChunk for recency decay. */
  sourceTs?: Date;
  /** SHA-256 of the full file content. Propagated to all chunks for hash-skip on re-ingest. */
  fileHash?: string;
}

export interface IngestResult {
  files: number;
  chunks: number;
  /** Files skipped because their content hash matched what is already stored. */
  skippedUnchanged: number;
}

// Defaults sized for voyage-4-large (generous context) while keeping chunks
// focused enough to rerank well.
const DEFAULT_CODE: ChunkOptions = { maxChars: 1600, overlap: 200 };
const DEFAULT_DOCS: ChunkOptions = { maxChars: 1200, overlap: 150 };

const MARKDOWN_EXT = /\.(md|mdx|markdown)$/i;

function optionsFor(corpus: Corpus, overrides: Partial<ChunkOptions>): ChunkOptions {
  const base = corpus === 'docs' || corpus === 'spec' ? DEFAULT_DOCS : DEFAULT_CODE;
  return { maxChars: overrides.maxChars ?? base.maxChars, overlap: overrides.overlap ?? base.overlap };
}

interface SymbolChunkingResult {
  pieces: ChunkPiece[];
  symbols: ExtractedSymbol[];
  imports: ExtractedImport[];
}

/**
 * Best-effort symbol-boundary chunking for code files. Returns null whenever
 * the symbol layer can't help (unsupported language, ast-grep unavailable, no
 * top-level declarations, or any unexpected error) — the caller then takes the
 * existing line-window path unchanged.
 */
async function trySymbolChunking(
  file: SourceFile,
  opts: ChunkOptions,
): Promise<SymbolChunkingResult | null> {
  try {
    // Dynamic import keeps symbol-extractor (and the @ast-grep/napi native
    // binary behind it) out of any static bundle graph reaching this module.
    const se = await import('./symbol-extractor');
    const lang = se.langForPath(file.path);
    if (!lang) return null;
    const symbols = await se.extractSymbols(file.content, lang);
    if (!symbols || symbols.length === 0) return null;
    const imports = await se.extractImports(file.content, lang, file.path);
    const pieces = chunkCodeSymbols(file.content, symbols, opts);
    if (pieces.length === 0) return null;
    return { pieces, symbols, imports };
  } catch {
    return null;
  }
}

/** Split a single file into upsertable chunks. No I/O beyond optional in-process AST parsing. */
export async function fileToChunks(
  file: SourceFile,
  corpus: Corpus,
  overrides: Partial<ChunkOptions> = {},
): Promise<UpsertChunk[]> {
  const opts = optionsFor(corpus, overrides);
  const useMarkdown = (corpus === 'docs' || corpus === 'spec') && MARKDOWN_EXT.test(file.path);

  let pieces: ChunkPiece[];
  let symbolInfo: SymbolChunkingResult | null = null;
  if (useMarkdown) {
    pieces = chunkMarkdown(file.content, opts);
  } else {
    if (corpus === 'code') symbolInfo = await trySymbolChunking(file, opts);
    pieces = symbolInfo ? symbolInfo.pieces : chunkCode(file.content, opts);
  }

  return pieces.map((piece, index) => {
    const headingPath = piece.headingPath ?? [];
    // Prepend file path (and heading trail for docs) to the lexical text so
    // BM25 can match on filename / section even when the body doesn't repeat it.
    const lexicalPrefix = headingPath.length ? `${file.path}\n${headingPath.join(' > ')}` : file.path;

    // Symbol layer metadata: each chunk lists the declarations it contains
    // (consumed by entity-extractor/edge-builder for symbol entities +
    // `defines` edges); imports ride on the first chunk only (one
    // file→file `imports` edge set per file).
    let symbolMeta: Record<string, unknown> = {};
    if (symbolInfo) {
      const defined = symbolInfo.symbols.filter(
        s => s.startLine >= piece.startLine && s.startLine <= piece.endLine,
      );
      symbolMeta = {
        ...(defined.length ? { symbols: defined } : {}),
        ...(index === 0 && symbolInfo.imports.length ? { imports: symbolInfo.imports } : {}),
      };
    }

    return {
      id: `${file.path}#${piece.startLine}`,
      content: piece.content,
      lexicalText: `${lexicalPrefix}\n\n${piece.content}`,
      sourceType: corpus,
      sourcePath: file.path,
      sourceUrl: file.sourceUrl ? `${file.sourceUrl}#L${piece.startLine}` : undefined,
      sourceTs: file.sourceTs,
      fileHash: file.fileHash ?? null,
      metadata: {
        startLine: piece.startLine,
        endLine: piece.endLine,
        ...(headingPath.length ? { headingPath } : {}),
        ...symbolMeta,
      },
    } satisfies UpsertChunk;
  });
}

/**
 * Ingest a batch of files into the given corpus namespace. Clears each file's
 * prior chunks first (when the store supports deleteBySource) so re-ingestion
 * is idempotent and orphan-free.
 *
 * Hash-skip: each file's SHA-256 (taken from `file.fileHash` or computed from
 * content) is compared against the hash already stored for that path. Files
 * whose hash is unchanged are skipped entirely — no re-chunk, no delete, no
 * re-embed. This is what turns a steady-state re-ingest of the whole tree into
 * near-zero work. Skipping is disabled when the store lacks `getFileHashes`.
 */
export async function ingestFiles(
  store: KnowledgeStore,
  workspaceId: string,
  corpus: Corpus,
  files: SourceFile[],
  overrides: Partial<ChunkOptions> = {},
): Promise<IngestResult> {
  const namespace = buildNamespace(workspaceId, corpus);
  let chunkCount = 0;
  let skippedUnchanged = 0;

  // Ensure every file carries a hash so it lands on its chunks (enabling the
  // skip on the *next* run) and can be compared against stored hashes now.
  for (const file of files) {
    if (!file.fileHash) {
      file.fileHash = createHash('sha256').update(file.content).digest('hex');
    }
  }

  const storedHashes = store.getFileHashes
    ? await store.getFileHashes(namespace, files.map(f => f.path))
    : new Map<string, string>();

  const skippedPaths: string[] = [];
  for (const file of files) {
    if (file.fileHash && storedHashes.get(file.path) === file.fileHash) {
      skippedUnchanged++;
      skippedPaths.push(file.path);
      continue;
    }
    const chunks = await fileToChunks(file, corpus, overrides);
    // Clear prior chunks for this file even when it now yields zero chunks
    // (e.g. emptied) so stale content doesn't linger.
    await store.deleteBySource?.(namespace, { sourcePath: file.path });
    if (chunks.length > 0) {
      await store.upsert(namespace, chunks);
      chunkCount += chunks.length;
    }
  }

  // Keep skipped (unchanged) files fresh so a later full-scope sweep that prunes
  // chunks older than the job start doesn't treat them as stale.
  if (skippedPaths.length > 0) {
    await store.touchBySource?.(namespace, skippedPaths);
  }

  return { files: files.length, chunks: chunkCount, skippedUnchanged };
}
