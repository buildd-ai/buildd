#!/usr/bin/env bun
/**
 * Bulk-ingest a large local repo checkout into a workspace's knowledge store,
 * embedding through a self-hosted OpenAI-compatible endpoint (Ollama, vLLM, ...)
 * instead of the platform Voyage key. Run it on the owner's PC or a runner.
 *
 * Reuses the product ingest path: `shouldIngestFile` + the full-ingest ceilings
 * from ingest-filter, `ingestFiles` for chunking and hash-skip, `PgVectorStore`
 * for writes (chunks are tagged with the endpoint's embedding_model).
 *
 * Refuses to run when the workspace's embedding config would be Voyage, or the
 * workspace has knowledge ingest switched off.
 *
 *   DATABASE_URL=... EMBEDDING_PROVIDER=openai_compat EMBEDDING_BASE_URL=... \
 *   EMBEDDING_MODEL=... bun scripts/knowledge-bulk-ingest.ts \
 *     --workspace <id> --repo <path> [--checkpoint <file>] [--batch 20] [--dry-run]
 *
 * See docs/knowledge-store.md → "Bulk ingest".
 */
import { createHash } from 'crypto';
import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'fs';
import { join, relative, resolve } from 'path';
import {
  DEFAULT_SKIP_DIRS,
  MAX_FULL_INGEST_BYTES,
  MAX_FULL_INGEST_FILES,
  MAX_INGEST_FILE_BYTES,
  capFullIngest,
  classifyIngestCorpus,
  shouldIngestFile,
} from '../packages/core/knowledge-store/ingest-filter';
import { fileToChunks, ingestFiles, type SourceFile } from '../packages/core/knowledge-store/ingest';
import { getEmbedderForCorpus, resolveEmbeddingConfig, type EmbeddingConfig } from '../packages/core/knowledge-store/embedding-config';
import { estimateTextTokens } from '../packages/core/voyage-budget';
import type { Corpus, KnowledgeStore } from '../packages/core/knowledge-store/types';

/** A precondition failed; nothing was read or written. */
export class BulkIngestRefusal extends Error {}

export interface BulkIngestOptions {
  repoPath: string;
  workspaceId: string;
  checkpointPath: string;
  dryRun: boolean;
  /** Files per ingest batch; the checkpoint is saved after each. Default 20. */
  batchSize?: number;
}

export interface BulkIngestDeps {
  resolveConfig: (workspaceId: string) => Promise<EmbeddingConfig>;
  isIngestEnabled: (workspaceId: string) => Promise<boolean>;
  makeStore: (cfg: EmbeddingConfig) => KnowledgeStore;
  log: (msg: string) => void;
}

export interface BulkIngestResult {
  dryRun: boolean;
  /** Files that pass the filter and ceilings. */
  files: number;
  filesOverCeiling: number;
  estimatedTokens: number;
  /** USD at the configured price; 0 when unmetered, null when no price is set. */
  estimatedCostUsd: number | null;
  skippedCheckpoint: number;
  skippedUnchanged: number;
  ingested: number;
  chunks: number;
}

interface Checkpoint {
  version: 1;
  workspaceId: string;
  embeddingModel: string;
  files: Record<string, string>;
}

function walk(root: string, dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!DEFAULT_SKIP_DIRS.has(entry.name) && entry.name !== '.git') walk(root, join(dir, entry.name), out);
    } else if (entry.isFile()) {
      out.push(relative(root, join(dir, entry.name)).split('\\').join('/'));
    }
  }
}

/** Eligible files in a stable order, so a re-run sees the same set and the same ceiling cut. */
function collectFiles(repoPath: string): { files: SourceFile[]; overCeiling: number } {
  const all: string[] = [];
  walk(repoPath, repoPath, all);
  all.sort();
  const sized: Array<{ path: string; size: number }> = [];
  for (const path of all) {
    const size = statSync(join(repoPath, path)).size;
    if (shouldIngestFile(path, { sizeBytes: size })) sized.push({ path, size });
  }
  const capped = capFullIngest(sized, f => f.size, { maxFiles: MAX_FULL_INGEST_FILES, maxBytes: MAX_FULL_INGEST_BYTES });
  const files: SourceFile[] = [];
  for (const { path } of capped.kept) {
    const buf = readFileSync(join(repoPath, path));
    if (buf.includes(0)) continue; // binary
    const content = buf.toString('utf8');
    files.push({ path, content, fileHash: createHash('sha256').update(content).digest('hex') });
  }
  return { files, overCeiling: capped.dropped };
}

function loadCheckpoint(path: string, workspaceId: string, model: string): Checkpoint {
  const fresh: Checkpoint = { version: 1, workspaceId, embeddingModel: model, files: {} };
  if (!existsSync(path)) return fresh;
  try {
    const cp = JSON.parse(readFileSync(path, 'utf8')) as Checkpoint;
    // A checkpoint is only valid for the workspace and model it embedded with.
    if (cp.version === 1 && cp.workspaceId === workspaceId && cp.embeddingModel === model) return cp;
  } catch { /* unreadable: start over */ }
  return fresh;
}

function saveCheckpoint(path: string, cp: Checkpoint): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(cp));
  renameSync(tmp, path);
}

export async function runBulkIngest(opts: BulkIngestOptions, deps: BulkIngestDeps): Promise<BulkIngestResult> {
  const { workspaceId, dryRun } = opts;
  const cfg = await deps.resolveConfig(workspaceId);
  if (cfg.provider !== 'openai_compat') {
    throw new BulkIngestRefusal(
      'Refusing to run: this workspace would embed with the platform Voyage key. Set EMBEDDING_PROVIDER=openai_compat ' +
        '(with EMBEDDING_BASE_URL and EMBEDDING_MODEL), or pick an embedding provider for the team on Settings › Providers.',
    );
  }
  const embedder = getEmbedderForCorpus('code', cfg);
  if (!embedder) throw new BulkIngestRefusal(`Refusing to run: ${cfg.unavailable ?? 'the embedding endpoint needs both a base URL and a model.'}`);
  if (!(await deps.isIngestEnabled(workspaceId))) {
    throw new BulkIngestRefusal(`Refusing to run: knowledge ingest is switched off for workspace ${workspaceId}.`);
  }

  const { files, overCeiling } = collectFiles(resolve(opts.repoPath));
  const result: BulkIngestResult = {
    dryRun, files: files.length, filesOverCeiling: overCeiling, estimatedTokens: 0, estimatedCostUsd: null,
    skippedCheckpoint: 0, skippedUnchanged: 0, ingested: 0, chunks: 0,
  };

  if (dryRun) {
    for (const f of files) {
      const corpus = classifyIngestCorpus(f.path) as Corpus;
      for (const c of await fileToChunks(f, corpus)) result.estimatedTokens += estimateTextTokens(c.lexicalText ?? c.content);
    }
    result.estimatedCostUsd = cfg.unmetered ? 0 : cfg.pricePerMTokens != null ? (result.estimatedTokens * cfg.pricePerMTokens) / 1_000_000 : null;
    return result;
  }

  const cp = loadCheckpoint(opts.checkpointPath, workspaceId, embedder.model);
  const pending = files.filter(f => cp.files[f.path] !== f.fileHash);
  result.skippedCheckpoint = files.length - pending.length;
  const store = deps.makeStore(cfg);
  const batchSize = Math.max(1, opts.batchSize ?? 20);

  for (let i = 0; i < pending.length; i += batchSize) {
    const batch = pending.slice(i, i + batchSize);
    for (const corpus of ['code', 'docs'] as const) {
      const group = batch.filter(f => classifyIngestCorpus(f.path) === corpus);
      if (group.length === 0) continue;
      const res = await ingestFiles(store, workspaceId, corpus, group);
      result.skippedUnchanged += res.skippedUnchanged;
      result.chunks += res.chunks;
      result.ingested += group.length - res.skippedUnchanged;
    }
    for (const f of batch) cp.files[f.path] = f.fileHash!;
    saveCheckpoint(opts.checkpointPath, cp);
    deps.log(`[bulk-ingest] ${Math.min(i + batchSize, pending.length)}/${pending.length} files`);
  }
  return result;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]) {
  const get = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    workspaceId: get('workspace'),
    repoPath: get('repo'),
    checkpoint: get('checkpoint'),
    batch: get('batch') ? Number(get('batch')) : undefined,
    dryRun: argv.includes('--dry-run'),
  };
}

async function main(argv: string[]): Promise<number> {
  const a = parseArgs(argv);
  if (!a.workspaceId || !a.repoPath) {
    console.error('usage: bun scripts/knowledge-bulk-ingest.ts --workspace <id> --repo <path> [--checkpoint <file>] [--batch N] [--dry-run]');
    return 2;
  }
  const deps: BulkIngestDeps = {
    resolveConfig: id => resolveEmbeddingConfig(id),
    isIngestEnabled: async id => {
      const [{ db }, { workspaces }, { eq }] = await Promise.all([
        import('../packages/core/db'), import('../packages/core/db/schema'), import('drizzle-orm'),
      ]);
      const [row] = await db.select({ on: workspaces.knowledgeIngest }).from(workspaces).where(eq(workspaces.id, id)).limit(1);
      if (!row) throw new BulkIngestRefusal(`Workspace ${id} not found.`);
      return row.on !== false;
    },
    makeStore: cfg => {
      const { PgVectorStore } = require('../packages/core/knowledge-store/pg-vector-store') as typeof import('../packages/core/knowledge-store/pg-vector-store');
      return new PgVectorStore(null, null, { caller: 'bulk-ingest', embeddingConfig: async () => cfg });
    },
    log: msg => console.log(msg),
  };
  try {
    const res = await runBulkIngest({
      repoPath: a.repoPath,
      workspaceId: a.workspaceId,
      checkpointPath: resolve(a.checkpoint ?? `.knowledge-bulk-ingest.${a.workspaceId}.json`),
      dryRun: a.dryRun,
      batchSize: a.batch,
    }, deps);
    if (res.dryRun) {
      const cost = res.estimatedCostUsd == null ? 'unknown (no price configured)' : `$${res.estimatedCostUsd.toFixed(4)}`;
      console.log(`dry run: ${res.files} files, ~${res.estimatedTokens} tokens, est. cost ${cost}` +
        (res.filesOverCeiling ? `, ${res.filesOverCeiling} files over the ingest ceiling` : '') + '. Nothing written.');
    } else {
      console.log(`done: ${res.ingested} ingested, ${res.skippedUnchanged} unchanged, ${res.skippedCheckpoint} already in checkpoint, ${res.chunks} chunks.`);
    }
    return 0;
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    return err instanceof BulkIngestRefusal ? 3 : 1;
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
