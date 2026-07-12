/**
 * Retrieval eval harness — Phase 0 baseline.
 *
 * Extends assess-knowledge.ts with:
 *   - A curated golden query set (eval/golden-queries.json) covering code, docs, spec corpora
 *   - Self-retrieval probes for dynamic corpora (memory, task, artifact, pr)
 *   - Metrics: recall@k, MRR, NDCG@10 per query and aggregated by corpus
 *   - JSON output fixture (committed as baseline; Phases 1-3 report deltas)
 *
 * Pipeline under test: RRF hybrid (vector + BM25), no reranker, no recency signal.
 *
 * Usage:
 *   DATABASE_URL=... VOYAGE_API_KEY=... \
 *   bun packages/core/scripts/eval-retrieval.ts <workspaceId> [--k <n>] [--output <file>]
 *
 * Namespace resolution:
 *   code, docs → SPEC_SYNC_NAMESPACE env var (or default 471effe1-...)
 *   spec       → workspaceId:spec  (override via SPEC_NS env var)
 *   memory     → teamId:memory    (resolved from workspaces table)
 *   task/pr/artifact → workspaceId:{corpus}
 */

import { db } from '../db/index';
import { sql, eq } from 'drizzle-orm';
import { workspaces } from '../db/schema';
import { PgVectorStore, buildNamespace } from '../knowledge-store/pg-vector-store';
import { getVoyageEmbedder } from '../knowledge-store/voyage-embedder';
import type { Corpus } from '../knowledge-store/types';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import path from 'path';

// ── Constants ────────────────────────────────────────────────────────────────

const SPEC_SYNC_NS_DEFAULT = '471effe1-4668-4cc9-9fa3-e20a56769deb';
const SCRIPT_DIR = path.dirname(new URL(import.meta.url).pathname);
const DEFAULT_OUTPUT = path.join(SCRIPT_DIR, 'eval', 'baseline-results.json');

// ── Metric helpers ───────────────────────────────────────────────────────────

/** Derive a realistic query from a chunk's own content. */
function queryFromChunk(text: string): string {
  const lines = text
    .split('\n')
    .map(l => l.replace(/^#+\s*/, '').replace(/^[-*]\s*/, '').trim())
    .filter(Boolean);
  return (lines[0] || text).slice(0, 200);
}

/**
 * Discounted Cumulative Gain at k with binary relevance.
 * relevantSet: set of relevant result IDs (or source paths).
 * results: ordered list of {id, sourcePath} from the retriever.
 */
function dcg(results: Array<{ id: string; sourcePath: string | null }>, relevantSet: Set<string>, k: number): number {
  let gain = 0;
  const capped = results.slice(0, k);
  for (let i = 0; i < capped.length; i++) {
    const r = capped[i];
    const relevant = relevantSet.has(r.id) || (r.sourcePath !== null && relevantSet.has(r.sourcePath));
    if (relevant) {
      gain += 1 / Math.log2(i + 2); // log2(rank+1), rank is 1-based → i+2
    }
  }
  return gain;
}

/** Ideal DCG: all relevant items at the top. */
function idcg(numRelevant: number, k: number): number {
  const n = Math.min(numRelevant, k);
  let gain = 0;
  for (let i = 0; i < n; i++) {
    gain += 1 / Math.log2(i + 2);
  }
  return gain;
}

function ndcg(results: Array<{ id: string; sourcePath: string | null }>, relevantSet: Set<string>, k: number): number {
  const ideal = idcg(relevantSet.size, k);
  if (ideal === 0) return 0;
  return dcg(results, relevantSet, k) / ideal;
}

/**
 * Reciprocal rank: 1/rank of first relevant result (0 if none in top-k).
 */
function reciprocalRank(results: Array<{ id: string; sourcePath: string | null }>, relevantSet: Set<string>, k: number): number {
  for (let i = 0; i < Math.min(results.length, k); i++) {
    const r = results[i];
    if (relevantSet.has(r.id) || (r.sourcePath !== null && relevantSet.has(r.sourcePath))) {
      return 1 / (i + 1);
    }
  }
  return 0;
}

/** recall@k: fraction of relevant items found in top-k (capped at 1.0 for multi-relevant). */
function recallAtK(results: Array<{ id: string; sourcePath: string | null }>, relevantSet: Set<string>, k: number): number {
  if (relevantSet.size === 0) return 0;
  const topK = results.slice(0, k);
  const found = topK.filter(r => relevantSet.has(r.id) || (r.sourcePath !== null && relevantSet.has(r.sourcePath))).length;
  return found / relevantSet.size;
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

// ── Types ────────────────────────────────────────────────────────────────────

interface CuratedQuery {
  id: string;
  corpus: string;
  query: string;
  expectedSourcePaths: string[];
  notes?: string;
}

interface SampledConfig {
  corpus: string;
  sampleSize: number;
  k: number;
  notes?: string;
}

interface GoldenQuerySet {
  version: number;
  curated: CuratedQuery[];
  sampled: SampledConfig[];
}

interface QueryResult {
  queryId: string;
  corpus: string;
  query: string;
  mode: 'curated' | 'sampled';
  recall5: number;
  recall10: number;
  mrr: number;
  ndcg10: number;
  topResults: Array<{ rank: number; sourcePath: string | null; sourceType: string; score: number; relevant: boolean }>;
  skipped?: string;
}

interface CorpusSummary {
  corpus: string;
  queriesRun: number;
  queriesSkipped: number;
  recallAt5: number;
  recallAt10: number;
  mrr: number;
  ndcg10: number;
}

interface EvalResults {
  schemaVersion: 1;
  runAt: string;
  workspaceId: string;
  k: number;
  pipeline: string;
  overall: {
    queriesRun: number;
    queriesSkipped: number;
    recallAt5: number;
    recallAt10: number;
    mrr: number;
    ndcg10: number;
  };
  byCorpus: CorpusSummary[];
  queries: QueryResult[];
}

// ── Namespace resolution ─────────────────────────────────────────────────────

function resolveNamespace(corpus: Corpus, workspaceId: string, teamId: string | null): string {
  if (corpus === 'code' || corpus === 'docs') {
    const specSyncId = process.env.SPEC_SYNC_NAMESPACE || SPEC_SYNC_NS_DEFAULT;
    return buildNamespace(specSyncId, corpus);
  }
  if (corpus === 'memory') {
    return buildNamespace(teamId ?? workspaceId, 'memory');
  }
  if (corpus === 'spec') {
    return process.env.SPEC_NS ? buildNamespace(process.env.SPEC_NS, 'spec') : buildNamespace(workspaceId, 'spec');
  }
  return buildNamespace(workspaceId, corpus);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const workspaceId = args.find(a => !a.startsWith('--'));
  if (!workspaceId) {
    console.error('Usage: bun eval-retrieval.ts <workspaceId> [--k <n>] [--output <file>]');
    process.exit(1);
  }

  const kIdx = args.indexOf('--k');
  const k = kIdx !== -1 ? parseInt(args[kIdx + 1], 10) : 10;
  const outIdx = args.indexOf('--output');
  const outputFile = outIdx !== -1 ? args[outIdx + 1] : DEFAULT_OUTPUT;

  if (!process.env.DATABASE_URL) {
    console.error('[eval] DATABASE_URL is required');
    process.exit(1);
  }

  const embedder = getVoyageEmbedder();
  if (!embedder) console.warn('[eval] VOYAGE_API_KEY not set — lexical-only evaluation (vector recall will be 0)');

  // No reranker — measuring the current RRF hybrid baseline without rerank.
  const store = new PgVectorStore(embedder, null);
  const pipelineLabel = embedder
    ? 'rrf-hybrid-no-rerank-no-recency'
    : 'bm25-lexical-only-no-voyage-key';

  // Resolve team ID for memory corpus
  const ws = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, workspaceId),
    columns: { teamId: true },
  });
  const teamId = ws?.teamId ?? null;

  // Load golden query set
  const goldenPath = path.join(SCRIPT_DIR, 'eval', 'golden-queries.json');
  if (!existsSync(goldenPath)) {
    console.error(`[eval] golden-queries.json not found at ${goldenPath}`);
    process.exit(1);
  }
  const golden: GoldenQuerySet = JSON.parse(readFileSync(goldenPath, 'utf8'));

  const allResults: QueryResult[] = [];

  // ── Curated queries ──────────────────────────────────────────────────────

  console.log('\n[eval] Running curated queries...');
  for (const q of golden.curated) {
    const corpus = q.corpus as Corpus;
    const ns = resolveNamespace(corpus, workspaceId, teamId);

    // Check if namespace has any chunks
    const countRes = await db.execute(sql`
      SELECT count(*)::int AS cnt FROM knowledge_chunks WHERE namespace = ${ns} LIMIT 1
    `);
    const cnt = (countRes.rows[0] as { cnt: number }).cnt;

    if (cnt === 0) {
      console.log(`  [skip] ${q.id} — namespace ${ns} empty`);
      allResults.push({
        queryId: q.id,
        corpus: q.corpus,
        query: q.query,
        mode: 'curated',
        recall5: 0,
        recall10: 0,
        mrr: 0,
        ndcg10: 0,
        topResults: [],
        skipped: `namespace ${ns} empty`,
      });
      continue;
    }

    let results;
    try {
      // trackHits: false — eval runs must not pollute retrieval-hit stats
      results = await store.query(ns, { text: q.query, topK: k, mode: 'hybrid', trackHits: false });
    } catch (err: any) {
      console.warn(`  [warn] ${q.id} query failed: ${err.message}`);
      allResults.push({
        queryId: q.id,
        corpus: q.corpus,
        query: q.query,
        mode: 'curated',
        recall5: 0,
        recall10: 0,
        mrr: 0,
        ndcg10: 0,
        topResults: [],
        skipped: `query error: ${err.message}`,
      });
      continue;
    }

    const relevantSet = new Set(q.expectedSourcePaths);
    const slim = results.map(r => ({ id: r.id, sourcePath: r.sourcePath }));

    const r5 = recallAtK(slim, relevantSet, 5);
    const r10 = recallAtK(slim, relevantSet, k);
    const mrr = reciprocalRank(slim, relevantSet, k);
    const n10 = ndcg(slim, relevantSet, k);

    const topResults = results.map((r, i) => ({
      rank: i + 1,
      sourcePath: r.sourcePath,
      sourceType: r.sourceType,
      score: r.score,
      relevant: relevantSet.has(r.sourcePath ?? '') || relevantSet.has(r.id),
    }));

    const hit = topResults.find(r => r.relevant);
    const hitStr = hit ? `✓ rank ${hit.rank}` : '✗ miss';
    console.log(`  ${q.id}: ${hitStr}  ndcg=${n10.toFixed(3)}  mrr=${mrr.toFixed(3)}`);

    allResults.push({ queryId: q.id, corpus: q.corpus, query: q.query, mode: 'curated', recall5: r5, recall10: r10, mrr, ndcg10: n10, topResults });
  }

  // ── Sampled queries (self-retrieval) ─────────────────────────────────────

  for (const cfg of golden.sampled) {
    const corpus = cfg.corpus as Corpus;
    const ns = resolveNamespace(corpus, workspaceId, teamId);
    const sampleSize = cfg.sampleSize;

    console.log(`\n[eval] Sampling ${corpus} corpus (ns=${ns}, n=${sampleSize})...`);

    const sample = await db.execute(sql`
      SELECT source_id, content, lexical_text
      FROM knowledge_chunks
      WHERE namespace = ${ns}
      ORDER BY random()
      LIMIT ${sampleSize}
    `);
    const rows = sample.rows as Array<{ source_id: string; content: string; lexical_text: string | null }>;

    if (rows.length === 0) {
      console.log(`  [skip] ${corpus} namespace ${ns} empty`);
      allResults.push({
        queryId: `${corpus}-sampled`,
        corpus,
        query: '(sampled)',
        mode: 'sampled',
        recall5: 0,
        recall10: 0,
        mrr: 0,
        ndcg10: 0,
        topResults: [],
        skipped: `namespace ${ns} empty`,
      });
      continue;
    }

    const perQueryR5: number[] = [];
    const perQueryR10: number[] = [];
    const perQueryMrr: number[] = [];
    const perQueryNdcg: number[] = [];

    for (const row of rows) {
      const q = queryFromChunk(row.lexical_text || row.content);
      let results;
      try {
        // trackHits: false — eval runs must not pollute retrieval-hit stats
        results = await store.query(ns, { text: q, topK: k, mode: 'hybrid', trackHits: false });
      } catch {
        continue;
      }

      const relevantSet = new Set([row.source_id]);
      const slim = results.map(r => ({ id: r.id, sourcePath: r.sourcePath }));
      perQueryR5.push(recallAtK(slim, relevantSet, 5));
      perQueryR10.push(recallAtK(slim, relevantSet, k));
      perQueryMrr.push(reciprocalRank(slim, relevantSet, k));
      perQueryNdcg.push(ndcg(slim, relevantSet, k));
    }

    const r5 = mean(perQueryR5);
    const r10 = mean(perQueryR10);
    const mrr = mean(perQueryMrr);
    const n10 = mean(perQueryNdcg);

    console.log(`  recall@5=${(r5 * 100).toFixed(1)}%  recall@${k}=${(r10 * 100).toFixed(1)}%  mrr=${mrr.toFixed(3)}  ndcg@${k}=${n10.toFixed(3)}  (n=${rows.length})`);

    allResults.push({
      queryId: `${corpus}-sampled`,
      corpus,
      query: `(${rows.length} self-retrieval probes)`,
      mode: 'sampled',
      recall5: r5,
      recall10: r10,
      mrr,
      ndcg10: n10,
      topResults: [],
    });
  }

  // ── Aggregate ────────────────────────────────────────────────────────────

  const ran = allResults.filter(r => !r.skipped);
  const corpusNames = [...new Set(allResults.map(r => r.corpus))];

  const byCorpus: CorpusSummary[] = corpusNames.map(corpus => {
    const cRan = allResults.filter(r => r.corpus === corpus && !r.skipped);
    const cSkipped = allResults.filter(r => r.corpus === corpus && r.skipped);
    return {
      corpus,
      queriesRun: cRan.length,
      queriesSkipped: cSkipped.length,
      recallAt5: mean(cRan.map(r => r.recall5)),
      recallAt10: mean(cRan.map(r => r.recall10)),
      mrr: mean(cRan.map(r => r.mrr)),
      ndcg10: mean(cRan.map(r => r.ndcg10)),
    };
  });

  const results: EvalResults = {
    schemaVersion: 1,
    runAt: new Date().toISOString(),
    workspaceId,
    k,
    pipeline: pipelineLabel,
    overall: {
      queriesRun: ran.length,
      queriesSkipped: allResults.length - ran.length,
      recallAt5: mean(ran.map(r => r.recall5)),
      recallAt10: mean(ran.map(r => r.recall10)),
      mrr: mean(ran.map(r => r.mrr)),
      ndcg10: mean(ran.map(r => r.ndcg10)),
    },
    byCorpus,
    queries: allResults,
  };

  // ── Print summary ────────────────────────────────────────────────────────

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  Retrieval Eval — Phase 0 Baseline');
  console.log(`  Pipeline: ${results.pipeline}`);
  if (!embedder) console.log('  ⚠ VOYAGE_API_KEY not set — vector arm disabled; results reflect BM25 only');
  console.log(`  Workspace: ${workspaceId}  k=${k}`);
  console.log('───────────────────────────────────────────────────────────');
  console.log(`  Overall (${ran.length} queries):  recall@5=${(results.overall.recallAt5 * 100).toFixed(1)}%  recall@${k}=${(results.overall.recallAt10 * 100).toFixed(1)}%  MRR=${results.overall.mrr.toFixed(3)}  NDCG@${k}=${results.overall.ndcg10.toFixed(3)}`);
  console.log('───────────────────────────────────────────────────────────');
  console.log('  By corpus:');
  for (const c of byCorpus) {
    if (c.queriesRun === 0) {
      console.log(`  ${c.corpus.padEnd(10)} (${c.queriesSkipped} skipped — namespace empty)`);
    } else {
      console.log(`  ${c.corpus.padEnd(10)}  recall@5=${(c.recallAt5 * 100).toFixed(1)}%  recall@${k}=${(c.recallAt10 * 100).toFixed(1)}%  MRR=${c.mrr.toFixed(3)}  NDCG@${k}=${c.ndcg10.toFixed(3)}  (n=${c.queriesRun})`);
    }
  }
  console.log('═══════════════════════════════════════════════════════════');

  // ── Write JSON fixture ────────────────────────────────────────────────────

  writeFileSync(outputFile, JSON.stringify(results, null, 2) + '\n');
  console.log(`\n[eval] Results written to ${outputFile}`);

  process.exit(0);
}

main().catch(err => {
  console.error('[eval] Error:', err);
  process.exit(1);
});
