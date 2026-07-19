/**
 * Ingest a repo's code + docs into knowledge_chunks (Phase 2).
 *
 * Walks a directory (or reads a single file), classifies files into the `code`,
 * `docs`, or `spec` corpora, chunks them, and upserts into the workspace's
 * namespaces. Re-runnable: each file's prior chunks are cleared before re-chunking.
 *
 * Usage:
 *   DATABASE_URL=... VOYAGE_API_KEY=... WORKSPACE_ID=<uuid> \
 *   bun packages/core/scripts/ingest-knowledge.ts [--corpus code|docs|spec] <dir>
 *
 * Or with positional workspaceId:
 *   bun packages/core/scripts/ingest-knowledge.ts <workspaceId> <dir> [--code-only|--docs-only]
 *
 * Flags:
 *   --corpus <name>      Force all matching files into this corpus (skips auto-classify).
 *                        code → code files only; docs/spec → markdown files only.
 *   --source-dir <dir>   Alternative to positional <dir> argument.
 *   --code-only          Only ingest code files (legacy; use --corpus code instead).
 *   --docs-only          Only ingest doc files (legacy; use --corpus docs instead).
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

async function ingestCorpus(
  store: PgVectorStore,
  workspaceId: string,
  corpus: Corpus,
  files: string[],
  root: string,
  prefix: string,
): Promise<void> {
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

  // Remove chunks for files that no longer exist on disk under this prefix.
  // `files` are the corpus-matched paths the walk found (size-skipped ones stay
  // in the seen set so they aren't pruned — they still exist on disk).
  if (!NO_PRUNE) {
    const seen = new Set(files.map(f => path.relative(root, f)));
    const orphans = await pruneOrphans(store, workspaceId, corpus, prefix, seen);
    if (orphans.length > 0) {
      console.log(
        `[ingest:${corpus}] pruned ${orphans.length} orphaned file(s) under ${prefix || '<root>'}`,
      );
    }
  }
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

  // dir: --source-dir flag → (WORKSPACE_ID set: first positional, else second positional).
  const dirArg = sourceDirFlag ?? (process.env.WORKSPACE_ID ? positional[0] : positional[1]);

  if (!workspaceId || !dirArg) {
    console.error(
      'Usage: WORKSPACE_ID=<uuid> bun ingest-knowledge.ts [--corpus code|docs|spec] <dir>\n' +
      '  or:  bun ingest-knowledge.ts <workspaceId> <dir> [--code-only|--docs-only]',
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

  // walkStart: the directory to walk (dirArg resolved).
  // root: repo root (process.cwd()) so chunk source_paths are full repo-relative
  // (packages/core/..., apps/web/...) rather than subdir-relative (core/..., web/...).
  // This makes deleteBySource reliable when a CI-ingested file is later touched via a PR diff.
  const walkStart = path.resolve(dirArg);
  const root = process.cwd();
  // prefix scopes orphan pruning to the walked directory so separate walks into
  // the same namespace (e.g. code corpus over packages/ then apps/) don't prune
  // each other's chunks. "" when walking the repo root.
  const prefix = path.relative(root, walkStart);

  const all: string[] = [];
  await walk(walkStart, walkStart, all);

  const keep = (f: string) => !(SKIP_TESTS && TEST_FILE_RE.test(path.basename(f)));
  const docFiles = all.filter(f => DOC_EXT.has(path.extname(f).toLowerCase())).filter(keep);
  const codeFiles = all.filter(f => CODE_EXT.has(path.extname(f).toLowerCase())).filter(keep);

  console.log(`[ingest] ${root}: ${codeFiles.length} code, ${docFiles.length} doc files`);

  if (corpusFlag) {
    // Forced-corpus mode: all matching files go into the specified corpus.
    const embedder = getVoyageEmbedderForCorpus(corpusFlag);
    if (!embedder) {
      console.warn(`[ingest] VOYAGE_API_KEY not set — storing text-only (lexical search will still work)`);
    }
    const store = new PgVectorStore(embedder);
    const files = corpusFlag === 'code' ? codeFiles : docFiles;
    await ingestCorpus(store, workspaceId, corpusFlag, files, root, prefix);
  } else {
    // Auto-classify mode (legacy): separate embedders per corpus.
    if (!docsOnly) {
      const embedder = getVoyageEmbedderForCorpus('code');
      if (!embedder) {
        console.warn('[ingest] VOYAGE_API_KEY not set — storing text-only (lexical search will still work)');
      }
      const store = new PgVectorStore(embedder);
      await ingestCorpus(store, workspaceId, 'code', codeFiles, root, prefix);
    }
    if (!codeOnly) {
      const embedder = getVoyageEmbedderForCorpus('docs');
      const store = new PgVectorStore(embedder);
      await ingestCorpus(store, workspaceId, 'docs', docFiles, root, prefix);
    }
  }

  console.log('[ingest] Complete.');
  process.exit(0);
}

main().catch(err => {
  console.error('[ingest] Error:', err);
  process.exit(1);
});
