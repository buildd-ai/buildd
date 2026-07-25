/**
 * One-shot sweep: evict knowledge_chunks for source paths that no longer
 * exist in the current repo checkout.
 *
 * Run this after deploying the ingest-knowledge.ts multi-dir fix to clean up
 * any orphaned chunks that accumulated before the fix (e.g. design/<name>.md
 * chunks that survived after files were moved to docs/design/<name>.md).
 *
 * Usage:
 *   DATABASE_URL=... WORKSPACE_ID=<uuid> \
 *   bun packages/core/scripts/backfill-evict-orphans.ts [--apply]
 *
 * Without --apply (default): prints orphaned paths per corpus, makes no changes.
 * With --apply: deletes the orphaned chunks from the database.
 *
 * The script walks the standard source directories used by knowledge-ingest.yml
 * (packages/, apps/, docs/) and compares them against stored source paths in the
 * workspace's code, docs, and spec namespaces. Any stored path absent from the
 * current filesystem is treated as an orphan.
 *
 * Safety: a bug in the seen-set would silently delete live chunks. Always run
 * without --apply first, review the output, then re-run with --apply.
 */
import { promises as fs } from 'fs';
import path from 'path';
import { PgVectorStore } from '../knowledge-store/pg-vector-store';
import { pruneOrphans } from '../knowledge-store/ingest';
import type { Corpus, KnowledgeStore } from '../knowledge-store/types';
import {
  DOC_EXTENSIONS,
  CODE_EXTENSIONS,
  DEFAULT_SKIP_DIRS,
  TEST_FILE_RE,
  MAX_INGEST_FILE_BYTES,
} from '../knowledge-store/ingest-filter';

const DRY_RUN = !process.argv.includes('--apply');

const SKIP_DIRS = new Set([
  ...DEFAULT_SKIP_DIRS,
  ...(process.env.INGEST_SKIP_DIRS?.split(',').map(s => s.trim()).filter(Boolean) ?? []),
]);

async function walk(dirOrFile: string, out: string[]): Promise<void> {
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(dirOrFile);
  } catch {
    return; // dir doesn't exist in this checkout — skip silently
  }
  if (stat.isFile()) {
    out.push(dirOrFile);
    return;
  }
  const entries = await fs.readdir(dirOrFile, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dirOrFile, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      await walk(full, out);
    } else if (e.isFile()) {
      out.push(full);
    }
  }
}

/**
 * Build a set of repo-relative paths for a given corpus by walking the
 * provided directories. Mirrors the walk done by knowledge-ingest.yml.
 *
 * Files are included regardless of size — a large file that exists on disk
 * should not have its (possibly pre-existing) chunks pruned.
 */
async function buildSeenSet(
  corpus: Corpus,
  dirs: string[],
  root: string,
): Promise<Set<string>> {
  const seen = new Set<string>();
  for (const dir of dirs) {
    const all: string[] = [];
    await walk(path.resolve(dir), all);
    const skipTests = corpus === 'code'; // tests excluded from code ingest
    for (const f of all) {
      if (skipTests && TEST_FILE_RE.test(path.basename(f))) continue;
      const ext = path.extname(f).toLowerCase();
      const isCode = CODE_EXTENSIONS.has(ext);
      const isDoc = DOC_EXTENSIONS.has(ext);
      if (corpus === 'code' && isCode) seen.add(path.relative(root, f));
      if ((corpus === 'docs' || corpus === 'spec') && isDoc) seen.add(path.relative(root, f));
    }
  }
  return seen;
}

async function sweepCorpus(
  store: KnowledgeStore,
  workspaceId: string,
  corpus: Corpus,
  dirs: string[],
  root: string,
): Promise<number> {
  const seen = await buildSeenSet(corpus, dirs, root);
  console.log(`[evict:${corpus}] ${seen.size} current paths from ${dirs.join(', ')}`);

  if (DRY_RUN) {
    // List stored paths without deleting; pruneOrphans would delete, so go direct.
    const stored = store.listSourcePaths ? await store.listSourcePaths(`${workspaceId}:${corpus}`, '') : [];
    const orphans = stored.filter(p => !seen.has(p));
    if (orphans.length === 0) {
      console.log(`[evict:${corpus}] no orphans found`);
    } else {
      console.log(`[evict:${corpus}] ${orphans.length} orphan(s) would be evicted:`);
      for (const p of orphans) {
        console.log(`  - ${p}`);
      }
    }
    return orphans.length;
  }

  // Live run: delegate to pruneOrphans which deletes and returns evicted paths.
  const orphans = await pruneOrphans(store, workspaceId, corpus, '', seen);
  if (orphans.length === 0) {
    console.log(`[evict:${corpus}] no orphans found`);
  } else {
    console.log(`[evict:${corpus}] evicted ${orphans.length} orphan(s):`);
    for (const p of orphans) {
      console.log(`  - ${p}`);
    }
  }
  return orphans.length;
}

async function main() {
  const workspaceId = process.env.WORKSPACE_ID;
  if (!workspaceId) {
    console.error('[evict] WORKSPACE_ID is required');
    process.exit(1);
  }

  if (!process.env.DATABASE_URL) {
    console.error('[evict] DATABASE_URL is required');
    process.exit(1);
  }

  try {
    new URL(process.env.DATABASE_URL);
  } catch {
    console.error('[evict] DATABASE_URL is not a valid URL');
    process.exit(1);
  }

  const root = process.cwd();

  if (DRY_RUN) {
    console.log('[evict] DRY RUN — pass --apply to delete orphans');
  } else {
    console.log('[evict] LIVE RUN — orphaned chunks will be deleted');
  }

  // No embedder needed — we only read/delete, never embed.
  const store: KnowledgeStore = new PgVectorStore(null);

  const corpora: Array<{ corpus: Corpus; dirs: string[] }> = [
    { corpus: 'code', dirs: ['packages', 'apps'] },
    { corpus: 'docs', dirs: ['docs'] },
    { corpus: 'spec', dirs: ['docs'] },
  ];

  let totalOrphans = 0;
  for (const { corpus, dirs } of corpora) {
    const count = await sweepCorpus(store, workspaceId, corpus, dirs, root);
    totalOrphans += count;
  }

  console.log(`\n[evict] Total orphans ${DRY_RUN ? 'found' : 'evicted'}: ${totalOrphans}`);
  if (DRY_RUN && totalOrphans > 0) {
    console.log('[evict] Re-run with --apply to delete them.');
  }
  process.exit(0);
}

main().catch(err => {
  console.error('[evict] Error:', err);
  process.exit(1);
});
