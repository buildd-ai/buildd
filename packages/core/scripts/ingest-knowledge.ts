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
import { ingestFiles, type SourceFile } from '../knowledge-store/ingest';
import type { Corpus } from '../knowledge-store/types';

const DOC_EXT = new Set(['.md', '.mdx', '.markdown']);
const CODE_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.java', '.rb', '.php', '.c', '.h', '.cc', '.cpp', '.hpp',
  '.cs', '.swift', '.kt', '.scala', '.sh', '.sql', '.css', '.scss',
]);
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', 'coverage', '.turbo', '.vercel',
  // Caller-supplied extra dirs (comma-separated), e.g. INGEST_SKIP_DIRS=drizzle,__tests__
  ...(process.env.INGEST_SKIP_DIRS?.split(',').map(s => s.trim()).filter(Boolean) ?? []),
]);
// When set, drop test/spec files from the corpus (history, not current-state truth).
const SKIP_TESTS = !!process.env.INGEST_SKIP_TESTS;
const TEST_FILE_RE = /\.(test|spec)\.[tj]sx?$/;
const MAX_FILE_BYTES = 512 * 1024; // skip very large files (minified bundles, lockfiles)
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
): Promise<void> {
  let done = 0;
  let chunks = 0;
  for (let i = 0; i < files.length; i += BATCH) {
    const batch = files.slice(i, i + BATCH);
    const sources: SourceFile[] = [];
    for (const f of batch) {
      try {
        const stat = await fs.stat(f);
        if (stat.size > MAX_FILE_BYTES) continue;
        const content = await fs.readFile(f, 'utf8');
        sources.push({ path: path.relative(root, f), content, sourceTs: stat.mtime });
      } catch {
        // unreadable / binary — skip
      }
    }
    const res = await ingestFiles(store, workspaceId, corpus, sources);
    done += res.files;
    chunks += res.chunks;
    console.log(`[ingest:${corpus}] ${done}/${files.length} files, ${chunks} chunks`);
  }
  console.log(`[ingest:${corpus}] done — ${files.length} files -> ${chunks} chunks`);
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

  const root = path.resolve(dirArg);

  const all: string[] = [];
  await walk(root, root, all);

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
    await ingestCorpus(store, workspaceId, corpusFlag, files, root);
  } else {
    // Auto-classify mode (legacy): separate embedders per corpus.
    if (!docsOnly) {
      const embedder = getVoyageEmbedderForCorpus('code');
      if (!embedder) {
        console.warn('[ingest] VOYAGE_API_KEY not set — storing text-only (lexical search will still work)');
      }
      const store = new PgVectorStore(embedder);
      await ingestCorpus(store, workspaceId, 'code', codeFiles, root);
    }
    if (!codeOnly) {
      const embedder = getVoyageEmbedderForCorpus('docs');
      const store = new PgVectorStore(embedder);
      await ingestCorpus(store, workspaceId, 'docs', docFiles, root);
    }
  }

  console.log('[ingest] Complete.');
  process.exit(0);
}

main().catch(err => {
  console.error('[ingest] Error:', err);
  process.exit(1);
});
