import type { KnowledgeStore, UpsertChunk, Corpus } from './types';
import { chunkMarkdown, chunkCode, type ChunkOptions, type ChunkPiece } from './chunker';
import { buildNamespace } from './pg-vector-store';

// Phase 2 ingestion: turn source files (code, docs) into multiple retrievable
// chunks. A file becomes N chunks whose ids are `path#startLine` — stable
// across re-ingests of unchanged regions and unique within the file. Re-ingest
// first clears the file's existing chunks (via deleteBySource) so a file that
// shrank doesn't leave orphaned tail chunks behind.

export interface SourceFile {
  /** Repo-relative path — used as sourcePath and id prefix. */
  path: string;
  content: string;
  /** Optional base URL; chunks get `#L<startLine>` appended. */
  sourceUrl?: string;
}

export interface IngestResult {
  files: number;
  chunks: number;
}

// Defaults sized for voyage-code-3 (generous context) while keeping chunks
// focused enough to rerank well.
const DEFAULT_CODE: ChunkOptions = { maxChars: 1600, overlap: 200 };
const DEFAULT_DOCS: ChunkOptions = { maxChars: 1200, overlap: 150 };

const MARKDOWN_EXT = /\.(md|mdx|markdown)$/i;

function optionsFor(corpus: Corpus, overrides: Partial<ChunkOptions>): ChunkOptions {
  const base = corpus === 'docs' || corpus === 'spec' ? DEFAULT_DOCS : DEFAULT_CODE;
  return { maxChars: overrides.maxChars ?? base.maxChars, overlap: overrides.overlap ?? base.overlap };
}

/** Split a single file into upsertable chunks. Pure — no I/O. */
export function fileToChunks(
  file: SourceFile,
  corpus: Corpus,
  overrides: Partial<ChunkOptions> = {},
): UpsertChunk[] {
  const opts = optionsFor(corpus, overrides);
  const useMarkdown = (corpus === 'docs' || corpus === 'spec') && MARKDOWN_EXT.test(file.path);
  const pieces: ChunkPiece[] = useMarkdown ? chunkMarkdown(file.content, opts) : chunkCode(file.content, opts);

  return pieces.map(piece => {
    const headingPath = piece.headingPath ?? [];
    // Prepend file path (and heading trail for docs) to the lexical text so
    // BM25 can match on filename / section even when the body doesn't repeat it.
    const lexicalPrefix = headingPath.length ? `${file.path}\n${headingPath.join(' > ')}` : file.path;
    return {
      id: `${file.path}#${piece.startLine}`,
      content: piece.content,
      lexicalText: `${lexicalPrefix}\n\n${piece.content}`,
      sourceType: corpus,
      sourcePath: file.path,
      sourceUrl: file.sourceUrl ? `${file.sourceUrl}#L${piece.startLine}` : undefined,
      metadata: {
        startLine: piece.startLine,
        endLine: piece.endLine,
        ...(headingPath.length ? { headingPath } : {}),
      },
    } satisfies UpsertChunk;
  });
}

/**
 * Ingest a batch of files into the given corpus namespace. Clears each file's
 * prior chunks first (when the store supports deleteBySource) so re-ingestion
 * is idempotent and orphan-free.
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

  for (const file of files) {
    const chunks = fileToChunks(file, corpus, overrides);
    // Clear prior chunks for this file even when it now yields zero chunks
    // (e.g. emptied) so stale content doesn't linger.
    await store.deleteBySource?.(namespace, { sourcePath: file.path });
    if (chunks.length > 0) {
      await store.upsert(namespace, chunks);
      chunkCount += chunks.length;
    }
  }

  return { files: files.length, chunks: chunkCount };
}
