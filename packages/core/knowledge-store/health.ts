import { sql } from 'drizzle-orm';
import type { Corpus } from './types';

/**
 * Workspace Knowledge Management v2 §6.3 — read-only knowledge health.
 *
 * Pure DB aggregation over already-indexed tables (`knowledge_chunks`,
 * `knowledge_ingest_jobs`, `pending_entity_refs`). No LLM work, no writes, no
 * embedding calls — just cheap, LIMITed reads that answer "is my workspace's
 * knowledge current?" at a glance. Consumed by the workspace-settings health
 * panel via the `/api/workspaces/[id]/knowledge-health` route.
 *
 * Namespaces are `${scopeId}:${corpus}` (see buildNamespace in
 * pg-vector-store.ts). A namespace holds exactly one corpus, so we enumerate
 * the workspace's possible namespaces (workspaceId × every corpus) and filter
 * `knowledge_chunks.namespace IN (...)` — an index-friendly exact match rather
 * than a `LIKE 'prefix%'` scan.
 */

// Lazy DB import — avoids hitting DATABASE_URL during build/test.
async function getDb() {
  const { db } = await import('../db/index');
  return db;
}

/** All corpora a workspace can hold. Kept in sync with the `Corpus` union. */
export const ALL_CORPORA: Corpus[] = [
  'memory',
  'code',
  'docs',
  'spec',
  'task',
  'artifact',
  'pr',
  'plan',
  'session',
];

/** A `done` code ingest older than this (days) flips freshness to 'stale'. */
export const DEFAULT_STALE_AFTER_DAYS = 14;

/** Hard cap on how many per-repo latest-ingest rows we return. */
const MAX_REPOS = 25;

export type FreshnessVerdict = 'fresh' | 'stale' | 'no-index';

export interface CorpusStat {
  corpus: Corpus;
  /** Count of `is_current = true` chunks in this corpus for the workspace. */
  currentChunks: number;
}

export interface LastIngestJob {
  repo: string;
  sha: string | null;
  status: 'queued' | 'running' | 'done' | 'error';
  scope: 'diff' | 'full';
  trigger: string;
  prNumber: number | null;
  finishedAt: Date | null;
  createdAt: Date | null;
  error: string | null;
}

export interface KnowledgeHealth {
  workspaceId: string;
  corpora: CorpusStat[];
  totalCurrentChunks: number;
  /** Latest ingest job per repo bound to this workspace (most recent first). */
  lastIngestByRepo: LastIngestJob[];
  /** Unresolved `pending_entity_refs` awaiting auto-heal / confirmation. */
  pendingEntityRefs: number;
  /** True when the `${workspaceId}:code` namespace holds ≥1 current chunk. */
  hasCodeIndex: boolean;
  /** finished_at of the most recent successful (`done`) ingest job, if any. */
  lastSuccessfulIngestAt: Date | null;
  staleAfterDays: number;
  freshness: FreshnessVerdict;
}

export interface FreshnessInput {
  /** Does the workspace have a code index at all? No index → 'no-index'. */
  hasCodeIndex: boolean;
  /** finished_at of the latest successful ingest job, or null if none. */
  lastSuccessfulIngestAt: Date | null;
  now?: Date;
  staleAfterDays?: number;
}

/**
 * Freshness verdict (pure, deterministic — unit-tested in isolation):
 *  - no code index at all            → 'no-index'  (retires the #1159 dead end)
 *  - code index but no successful job → 'stale'    (chunks exist, provenance unknown)
 *  - last `done` job older than N days→ 'stale'
 *  - otherwise                        → 'fresh'
 *
 * When repo HEAD is cheaply available a vs-HEAD SHA comparison would be more
 * precise; this signal is last-successful-ingest age only (no GitHub call in
 * the read path). See the route/PR notes.
 */
export function computeFreshness(input: FreshnessInput): FreshnessVerdict {
  if (!input.hasCodeIndex) return 'no-index';
  const last = input.lastSuccessfulIngestAt;
  if (!last) return 'stale';
  const staleAfterDays = input.staleAfterDays ?? DEFAULT_STALE_AFTER_DAYS;
  const now = input.now ?? new Date();
  const ageDays = (now.getTime() - last.getTime()) / 86_400_000;
  return ageDays > staleAfterDays ? 'stale' : 'fresh';
}

type DbLike = { execute: (q: unknown) => Promise<{ rows: Array<Record<string, unknown>> }> };

export interface GetKnowledgeHealthOptions {
  /** Inject a db for testing; defaults to the lazy core `db`. */
  db?: DbLike;
  now?: Date;
  staleAfterDays?: number;
}

function toDate(v: unknown): Date | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return isNaN(d.getTime()) ? null : d;
}

function toNum(v: unknown): number {
  const n = Number(v);
  return isNaN(n) ? 0 : n;
}

/**
 * Aggregate a workspace's knowledge health from indexed tables. Four cheap,
 * LIMITed reads — per-corpus current-chunk counts, latest ingest per repo,
 * most-recent successful ingest timestamp, and the pending-entity-refs count.
 */
export async function getKnowledgeHealth(
  workspaceId: string,
  opts: GetKnowledgeHealthOptions = {},
): Promise<KnowledgeHealth> {
  const db = opts.db ?? (await getDb());
  const staleAfterDays = opts.staleAfterDays ?? DEFAULT_STALE_AFTER_DAYS;

  // Enumerate the workspace's namespaces (exact IN match → uses namespace idx).
  const namespaces = ALL_CORPORA.map((c) => `${workspaceId}:${c}`);
  const nsIn = sql.join(namespaces.map((ns) => sql`${ns}`), sql`, `);

  // 1. Per-corpus current-chunk counts.
  const corpusRes = await db.execute(sql`
    SELECT corpus, count(*)::int AS current_chunks
    FROM knowledge_chunks
    WHERE namespace IN (${nsIn})
      AND is_current = true
    GROUP BY corpus
    ORDER BY corpus
  `);
  const corpora: CorpusStat[] = (corpusRes.rows as Array<Record<string, unknown>>).map((r) => ({
    corpus: String(r.corpus) as Corpus,
    currentChunks: toNum(r.current_chunks),
  }));
  const totalCurrentChunks = corpora.reduce((sum, c) => sum + c.currentChunks, 0);
  const hasCodeIndex = corpora.some((c) => c.corpus === 'code' && c.currentChunks > 0);

  // 2. Latest ingest job per repo for this workspace.
  const jobsRes = await db.execute(sql`
    SELECT DISTINCT ON (repo)
      repo, sha, status, scope, trigger, pr_number, finished_at, created_at, error
    FROM knowledge_ingest_jobs
    WHERE workspace_id = ${workspaceId}
    ORDER BY repo, created_at DESC
    LIMIT ${MAX_REPOS}
  `);
  const lastIngestByRepo: LastIngestJob[] = (jobsRes.rows as Array<Record<string, unknown>>)
    .map((r) => ({
      repo: String(r.repo),
      sha: r.sha ? String(r.sha) : null,
      status: String(r.status) as LastIngestJob['status'],
      scope: String(r.scope) as LastIngestJob['scope'],
      trigger: String(r.trigger),
      prNumber: r.pr_number == null ? null : toNum(r.pr_number),
      finishedAt: toDate(r.finished_at),
      createdAt: toDate(r.created_at),
      error: r.error ? String(r.error) : null,
    }))
    // Most recently created repo-job first for display.
    .sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0));

  // 3. Most-recent successful ingest timestamp (drives freshness age).
  const doneRes = await db.execute(sql`
    SELECT max(finished_at) AS last_done
    FROM knowledge_ingest_jobs
    WHERE workspace_id = ${workspaceId}
      AND status = 'done'
  `);
  const lastSuccessfulIngestAt = toDate((doneRes.rows[0] as Record<string, unknown> | undefined)?.last_done);

  // 4. Unresolved pending entity refs.
  const pendingRes = await db.execute(sql`
    SELECT count(*)::int AS pending
    FROM pending_entity_refs
    WHERE workspace_id = ${workspaceId}
      AND resolved_at IS NULL
  `);
  const pendingEntityRefs = toNum((pendingRes.rows[0] as Record<string, unknown> | undefined)?.pending);

  const freshness = computeFreshness({
    hasCodeIndex,
    lastSuccessfulIngestAt,
    now: opts.now,
    staleAfterDays,
  });

  return {
    workspaceId,
    corpora,
    totalCurrentChunks,
    lastIngestByRepo,
    pendingEntityRefs,
    hasCodeIndex,
    lastSuccessfulIngestAt,
    staleAfterDays,
    freshness,
  };
}
