/**
 * Ingest a repo's code + docs into knowledge_chunks (Phase 2).
 *
 * Walks one or more source directories, classifies files into the `code`,
 * `docs`, or `spec` corpora, chunks them, and upserts into the workspace's
 * namespaces. Re-runnable: each file's prior chunks are cleared before re-chunking.
 *
 * Usage:
 *   DATABASE_URL=... VOYAGE_API_KEY=... WORKSPACE_ID=<uuid> \
 *   bun packages/core/scripts/ingest-knowledge.ts [--corpus code|docs|spec] <dir> [<dir2> ...]
 *
 * Or with positional workspaceId:
 *   bun packages/core/scripts/ingest-knowledge.ts <workspaceId> <dir> [<dir2> ...] [--code-only|--docs-only]
 *
 * Flags:
 *   --corpus <name>      Force all matching files into this corpus (skips auto-classify).
 *                        code → code files only; docs/spec → markdown files only.
 *   --source-dir <dir>   Single source directory (legacy; use positional args for multi-dir).
 *   --code-only          Only ingest code files (legacy; use --corpus code instead).
 *   --docs-only          Only ingest doc files (legacy; use --corpus docs instead).
 *
 * Multi-directory (recommended for code corpus):
 *   bun ingest-knowledge.ts --corpus code packages apps
 *   All dirs are walked in one pass; the orphan sweep covers the whole namespace,
 *   so a file that moved out of one sub-tree is correctly evicted even if it isn't
 *   under the other sub-tree's prefix.
 *
 * Embedder selection (per-corpus):
 *   code / docs / spec → voyage-code-3
 *   all others          → voyage-4-large
 *
 * VOYAGE_API_KEY is optional — without it, chunks are stored text-only and
 * lexical (BM25) search still works.
 */
import { promises as fs } from 'fs';
import path from 'path';
import { PgVectorStore } from '../knowledge-store/pg-vector-store';
import { getVoyageEmbedderForCorpus } from '../knowledge-store/voyage-embedder';
import { ingestFiles, pruneOrphans, type SourceFile } from '../knowledge-store/ingest';
import type { Corpus } from '../knowledge-store/types';
import {
  DOC_EXTENSIONS as DOC_EXT,
  CODE_EXTENSIONS as CODE_EXT,
  DEFAULT_SKIP_DIRS,
  TEST_FILE_RE,
  MAX_INGEST_FILE_BYTES as MAX_FILE_BYTES,
} from '../knowledge-store/ingest-filter';

const SKIP_DIRS = new Set([
  ...DEFAULT_SKIP_DIRS,
  // Caller-supplied extra dirs (comma-separated), e.g. INGEST_SKIP_DIRS=drizzle,__tests__
  ...(process.env.INGEST_SKIP_DIRS?.split(',').map(s => s.trim()).filter(Boolean) ?? []),
]);
// When set, drop test/spec files from the corpus (history, not current-state truth).
const SKIP_TESTS = !!process.env.INGEST_SKIP_TESTS;
// When set, skip pruning chunks for files no longer on disk (safety escape hatch).
const NO_PRUNE = !!process.env.INGEST_NO_PRUNE;
const BATCH = 50;

function getFlag(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}

async function walk(dirOrFile: string, root: string, out: string[]): Promise<void> {
  const stat = await fs.stat(dirOrFile);
  if (stat.isFile()) {
    out.push(dirOrFile);
    return;
  }
  const entries = await fs.readdir(dirOrFile, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dirOrFile, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      await walk(full, root, out);
    } else if (e.isFile()) {
      out.push(full);
    }
  }
}

/**
 * Ingest one corpus from a pre-collected file list. Returns the set of
 * repo-relative paths that were present on disk (including size-skipped files
 * so they aren't pruned — they still exist on disk). Callers accumulate these
 * across multiple walk directories, then pass the union to pruneOrphans once,
 * covering the whole namespace rather than just one prefix.
 */
async function ingestCorpus(
  store: PgVectorStore,
  workspaceId: string,
  corpus: Corpus,
  files: string[],
  root: string,
): Promise<Set<string>> {
  let done = 0;
  let chunks = 0;
  let skipped = 0;
  for (let i = 0; i < files.length; i += BATCH) {
    const batch = files.slice(i, i + BATCH);
    const sources: SourceFile[] = [];
    for (const f of batch) {
      try {
        const stat = await fs.stat(f);
        if (stat.size > MAX_FILE_BYTES) continue;
        const content = await fs.readFile(f, 'utf8');
        sources.push({ path: path.relative(root, f), content });
      } catch {
        // unreadable / binary — skip
      }
    }
    const res = await ingestFiles(store, workspaceId, corpus, sources);
    done += res.files;
    chunks += res.chunks;
    skipped += res.skippedUnchanged;
    console.log(
      `[ingest:${corpus}] ${done}/${files.length} files, ${chunks} chunks, ${skipped} unchanged`,
    );
  }
  console.log(
    `[ingest:${corpus}] done — ${files.length} files -> ${chunks} chunks (${skipped} unchanged, skipped)`,
  );

  // Return all walked paths (size-skipped included) so callers can build the
  // complete "seen" set for a namespace-wide orphan sweep.
  return new Set(files.map(f => path.relative(root, f)));
}

async function main() {
  // Parse flags before positional args so they don't interfere.
  const corpusFlag = getFlag('--corpus') as Corpus | undefined;
  const sourceDirFlag = getFlag('--source-dir');
  const codeOnly = process.argv.includes('--code-only');
  const docsOnly = process.argv.includes('--docs-only');

  // Collect positional args (skip flags and their values).
  const skipNext = new Set(['--corpus', '--source-dir']);
  const positional: string[] = [];
  const rawArgs = process.argv.slice(2);
  for (let i = 0; i < rawArgs.length; i++) {
    if (rawArgs[i].startsWith('--')) {
      if (skipNext.has(rawArgs[i])) i++; // consume value
      continue;
    }
    positional.push(rawArgs[i]);
  }

  // workspaceId: env var takes precedence over first positional arg.
  const workspaceId = process.env.WORKSPACE_ID ?? positional[0];

  // Source directories: --source-dir (legacy, single dir) OR remaining positionals.
  // When WORKSPACE_ID is set via env, all positionals are dirs.
  // When not set, the first positional is workspaceId and the rest are dirs.
  let dirArgs: string[];
  if (sourceDirFlag) {
    dirArgs = [sourceDirFlag];
  } else {
    dirArgs = process.env.WORKSPACE_ID ? positional : positional.slice(1);
  }

  if (!workspaceId || dirArgs.length === 0) {
    console.error(
      'Usage: WORKSPACE_ID=<uuid> bun ingest-knowledge.ts [--corpus code|docs|spec] <dir> [<dir2> ...]\n' +
      '  or:  bun ingest-knowledge.ts <workspaceId> <dir> [<dir2> ...] [--code-only|--docs-only]',
    );
    process.exit(1);
  }

  if (!process.env.DATABASE_URL) {
    console.warn('[ingest] DATABASE_URL not set — skipping (knowledge base not configured)');
    process.exit(0);
  }

  // neon() throws on invalid URLs — validate format before trying to connect.
  try {
    new URL(process.env.DATABASE_URL);
  } catch {
    console.warn('[ingest] DATABASE_URL is not a valid URL — skipping (check the DATABASE_URL secret)');
    process.exit(0);
  }

  // root: repo root (process.cwd()) so chunk source_paths are full repo-relative
  // (packages/core/..., apps/web/...) rather than subdir-relative (core/..., web/...).
  // This makes deleteBySource reliable when a CI-ingested file is later touched via a PR diff.
  const root = process.cwd();

  // Walk all source directories and collect files.
  const allFiles: string[] = [];
  for (const dirArg of dirArgs) {
    const walkStart = path.resolve(dirArg);
    await walk(walkStart, walkStart, allFiles);
  }

  const keep = (f: string) => !(SKIP_TESTS && TEST_FILE_RE.test(path.basename(f)));
  const docFiles = allFiles.filter(f => DOC_EXT.has(path.extname(f).toLowerCase())).filter(keep);
  const codeFiles = allFiles.filter(f => CODE_EXT.has(path.extname(f).toLowerCase())).filter(keep);

  const dirsLabel = dirArgs.join(', ');
  console.log(`[ingest] ${root}: ${codeFiles.length} code, ${docFiles.length} doc files (from ${dirsLabel})`);

  if (corpusFlag) {
    // Forced-corpus mode: all matching files go into the specified corpus.
    const embedder = getVoyageEmbedderForCorpus(corpusFlag);
    if (!embedder) {
      console.warn(`[ingest] VOYAGE_API_KEY not set — storing text-only (lexical search will still work)`);
    }
    const store = new PgVectorStore(embedder);
    const files = corpusFlag === 'code' ? codeFiles : docFiles;
    const seen = await ingestCorpus(store, workspaceId, corpusFlag, files, root);

    // Namespace-wide orphan sweep: covers ALL source paths in the namespace,
    // not just those under the current dir prefix. A file moved from design/
    // to docs/design/ in a previous commit will have its old chunk evicted here
    // even though the old path is outside the current walk directory.
    if (!NO_PRUNE) {
      const orphans = await pruneOrphans(store, workspaceId, corpusFlag, '', seen);
      if (orphans.length > 0) {
        console.log(
          `[ingest:${corpusFlag}] pruned ${orphans.length} orphaned path(s) across namespace`,
        );
      }
    }
  } else {
    // Auto-classify mode (legacy): separate embedders per corpus.
    if (!docsOnly) {
      const embedder = getVoyageEmbedderForCorpus('code');
      if (!embedder) {
        console.warn('[ingest] VOYAGE_API_KEY not set — storing text-only (lexical search will still work)');
      }
      const store = new PgVectorStore(embedder);
      const seen = await ingestCorpus(store, workspaceId, 'code', codeFiles, root);
      if (!NO_PRUNE) {
        const orphans = await pruneOrphans(store, workspaceId, 'code', '', seen);
        if (orphans.length > 0) {
          console.log(`[ingest:code] pruned ${orphans.length} orphaned path(s) across namespace`);
        }
      }
    }
    if (!codeOnly) {
      const embedder = getVoyageEmbedderForCorpus('docs');
      const store = new PgVectorStore(embedder);
      const seen = await ingestCorpus(store, workspaceId, 'docs', docFiles, root);
      if (!NO_PRUNE) {
        const orphans = await pruneOrphans(store, workspaceId, 'docs', '', seen);
        if (orphans.length > 0) {
          console.log(`[ingest:docs] pruned ${orphans.length} orphaned path(s) across namespace`);
        }
      }
    }
  }

  console.log('[ingest] Complete.');
  process.exit(0);
}

main().catch(err => {
  console.error('[ingest] Error:', err);
  process.exit(1);
});
