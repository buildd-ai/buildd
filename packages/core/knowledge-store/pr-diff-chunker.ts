// PR-diff corpus chunker (Workspace KM v2 spec §3.5 — stream A3).
//
// Turns per-file unified-diff patches (as returned by the GitHub PR files /
// compare APIs) into `pr`-corpus chunks: hunks greedily packed up to the chunk
// budget, source_id `pr:{prNumber}#{path}` (continuations get `#2`, `#3`, …).
// Pure — no I/O — so it's unit-testable without network.

import type { UpsertChunk } from './types';
import { chunkText, type ChunkOptions } from './chunker';

export interface PrDiffFileInput {
  /** Repo-relative path of the changed file. */
  path: string;
  /** Unified diff for this file. Absent for binary/oversized files — skipped. */
  patch?: string | null;
  /** GitHub file status (added/modified/removed/renamed…). */
  status?: string;
  /** Optional pointer to the raw patch blob (R2, spec §8) — passed through. */
  sourceUrl?: string | null;
}

export interface PrDiffMeta {
  prNumber: number;
  sha?: string | null;
  taskId?: string | null;
  missionId?: string | null;
  /** Merge time — drives recency decay (pr half-life 45d). */
  sourceTs?: Date | null;
}

// Same budget as code chunks; no overlap — hunks are already self-delimiting.
export const PR_DIFF_CHUNK_OPTIONS: ChunkOptions = { maxChars: 1600, overlap: 0 };

const HUNK_HEADER_RE = /^@@ /;

/** Split a unified diff into hunks, each starting at its `@@` header. */
export function splitPatchHunks(patch: string): string[] {
  if (!patch || !patch.trim()) return [];
  const lines = patch.split('\n');
  const hunks: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (HUNK_HEADER_RE.test(line) && current.length > 0) {
      hunks.push(current.join('\n'));
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0) hunks.push(current.join('\n'));
  return hunks;
}

/** Chunk one file's patch into upsertable `pr`-corpus chunks. */
export function chunkPrDiffFile(
  file: PrDiffFileInput,
  meta: PrDiffMeta,
  opts: ChunkOptions = PR_DIFF_CHUNK_OPTIONS,
): UpsertChunk[] {
  const hunks = splitPatchHunks(file.patch ?? '');
  if (hunks.length === 0) return [];

  // Greedy-pack hunks up to the budget; an oversized single hunk sub-splits
  // via the line-window splitter with its header re-attached for context.
  const pieces: string[] = [];
  let pack: string[] = [];
  let packSize = 0;
  const flush = () => {
    if (pack.length > 0) pieces.push(pack.join('\n'));
    pack = [];
    packSize = 0;
  };
  for (const hunk of hunks) {
    if (hunk.length > opts.maxChars) {
      flush();
      const header = HUNK_HEADER_RE.test(hunk) ? hunk.slice(0, hunk.indexOf('\n')) : null;
      for (const sub of chunkText(hunk, opts)) {
        const needsHeader = header && !sub.content.startsWith('@@');
        pieces.push(needsHeader ? `${header}\n${sub.content}` : sub.content);
      }
      continue;
    }
    if (pack.length > 0 && packSize + 1 + hunk.length > opts.maxChars) flush();
    pack.push(hunk);
    packSize += (pack.length > 1 ? 1 : 0) + hunk.length;
  }
  flush();

  const baseId = `pr:${meta.prNumber}#${file.path}`;
  return pieces.map((content, index) => ({
    // First chunk carries the spec id exactly; continuations suffix an index.
    id: index === 0 ? baseId : `${baseId}#${index + 1}`,
    content,
    lexicalText: `${file.path}\nPR #${meta.prNumber}\n\n${content}`,
    sourceType: 'pr',
    // Deliberately NOT sourcePath: path-keyed supersession (_markSuperseded)
    // would flip older PRs touching the same file to is_current=false, but the
    // pr corpus is history — every merged PR stays retrievable. The path lives
    // in metadata (and lexicalText) instead.
    sourcePath: null,
    sourceUrl: file.sourceUrl ?? undefined,
    sourceTs: meta.sourceTs ?? undefined,
    metadata: {
      prNumber: meta.prNumber,
      path: file.path,
      ...(meta.sha ? { sha: meta.sha } : {}),
      ...(meta.taskId ? { taskId: meta.taskId } : {}),
      ...(meta.missionId ? { missionId: meta.missionId } : {}),
      ...(file.status ? { status: file.status } : {}),
    },
  }));
}

/** Chunk a whole PR's file list. Files without a patch (binary/huge) are skipped. */
export function chunkPrDiff(
  files: PrDiffFileInput[],
  meta: PrDiffMeta,
  opts: ChunkOptions = PR_DIFF_CHUNK_OPTIONS,
): UpsertChunk[] {
  return files.flatMap(file => chunkPrDiffFile(file, meta, opts));
}
