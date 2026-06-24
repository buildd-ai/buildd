/**
 * Ingest a repo's code + docs into knowledge_chunks (Phase 2).
 *
 * Walks a directory, classifies files into the `code` and `docs` corpora,
 * chunks them, and upserts into the workspace's namespaces. Re-runnable:
 * each file's prior chunks are cleared before re-chunking.
 *
 * Usage:
 *   DATABASE_URL=... VOYAGE_API_KEY=... \
 *   bun packages/core/scripts/ingest-knowledge.ts <workspaceId> <dir> [--code-only|--docs-only]
 *
 * VOYAGE_API_KEY is optional — without it, chunks are stored text-only and
 * lexical (BM25) search still works.
 */
import { promises as fs } from 'fs';
import path from 'path';
import { PgVectorStore } from '../knowledge-store/pg-vector-store';
import { getVoyageEmbedder } from '../knowledge-store/voyage-embedder';
import { ingestFiles, type SourceFile } from '../knowledge-store/ingest';

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

async function walk(dir: string, root: string, out: string[]): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
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
  corpus: 'code' | 'docs',
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
        sources.push({ path: path.relative(root, f), content });
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
  const [workspaceId, dir] = process.argv.slice(2);
  const codeOnly = process.argv.includes('--code-only');
  const docsOnly = process.argv.includes('--docs-only');

  if (!workspaceId || !dir) {
    console.error('Usage: bun ingest-knowledge.ts <workspaceId> <dir> [--code-only|--docs-only]');
    process.exit(1);
  }

  const root = path.resolve(dir);
  const embedder = getVoyageEmbedder();
  if (!embedder) {
    console.warn('[ingest] VOYAGE_API_KEY not set — storing text-only (lexical search will still work)');
  } else {
    console.log('[ingest] Using voyage-4-large for general corpora; voyage-code-3 auto-selected for code/docs/spec');
  }
  // PgVectorStore selects voyage-code-3 internally for code/docs/spec corpora via getCodeEmbedder()
  const store = new PgVectorStore(embedder);

  const all: string[] = [];
  await walk(root, root, all);

  const keep = (f: string) => !(SKIP_TESTS && TEST_FILE_RE.test(path.basename(f)));
  const docFiles = all.filter(f => DOC_EXT.has(path.extname(f).toLowerCase())).filter(keep);
  const codeFiles = all.filter(f => CODE_EXT.has(path.extname(f).toLowerCase())).filter(keep);

  console.log(`[ingest] ${root}: ${codeFiles.length} code, ${docFiles.length} doc files`);

  if (!docsOnly) await ingestCorpus(store, workspaceId, 'code', codeFiles, root);
  if (!codeOnly) await ingestCorpus(store, workspaceId, 'docs', docFiles, root);

  console.log('[ingest] Complete.');
  process.exit(0);
}

main().catch(err => {
  console.error('[ingest] Error:', err);
  process.exit(1);
});
