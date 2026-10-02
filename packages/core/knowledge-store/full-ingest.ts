// Client-side executor for `full`-scope knowledge ingest jobs (KM v2 spec
// §3.3/§3.4 — stream A2). Runs wherever a repo checkout exists — the runner
// fleet or any CI with BUILDD_API_KEY — and streams file batches to the
// server's ingest-job routes, which do the chunking/embedding/upserting.
//
// NOT re-exported from knowledge-store/index.ts: this module touches
// child_process and must never enter a serverless bundle graph.

import * as childProcess from 'node:child_process';
const { execFileSync } = childProcess;
import { createHash } from 'crypto';
import { shouldIngestFile, MAX_INGEST_FILE_BYTES } from './ingest-filter';
import type { ScipGraph } from './scip-parser';
import { BuilddTransport } from '../buildd-transport';

/** Serializable code-graph payload transmitted to the server for persistence. */
export type IngestGraphPayload = Pick<ScipGraph, 'entities' | 'edges' | 'aliases'>;

export interface FullIngestJob {
  id: string;
  workspaceId: string;
  repo: string;
  sha?: string | null;
  scope: string;
  trigger: string;
}

export interface IngestFileEntry {
  path: string;
  content: string;
  /** SHA-256 of the full file content. Server uses this to skip unchanged files. */
  fileHash?: string;
}

export interface IngestBatchStats {
  filesIngested: number;
  chunksUpserted: number;
  filesSkipped: number;
  filesDeleted: number;
  /** Files skipped because their content hash matched what is already in the store. */
  skippedUnchanged?: number;
}

export interface FullIngestCompletion {
  status: 'done' | 'error';
  stats?: Record<string, unknown>;
  error?: string;
  /** Ask the server to prune file-derived chunks not refreshed by this run. */
  sweep?: boolean;
}

export interface FullIngestApiClient {
  /** Claim the oldest queued full job for one of the given "owner/name" repos. */
  claimJob(repos: string[]): Promise<FullIngestJob | null>;
  pushFiles(jobId: string, files: IngestFileEntry[]): Promise<IngestBatchStats>;
  completeJob(jobId: string, result: FullIngestCompletion): Promise<void>;
  /**
   * Hand a claimed job back to the queue without running it, recording why
   * (e.g. this runner's checkout cannot fetch the repo). The job stays eligible
   * for another runner or the serverless fallback. Optional for older servers.
   */
  releaseJob?(jobId: string, reason: string): Promise<void>;
  /**
   * Persist a precise code graph (SCIP) ADDITIVELY alongside the ast-grep
   * edges built during file ingest — stream B2b. Optional: clients/servers that
   * don't yet support graph persistence simply omit it, and the SCIP layer
   * degrades to a no-op. Returns the count of edges/aliases the server wrote.
   */
  pushGraph?(jobId: string, graph: IngestGraphPayload): Promise<{ edges: number; aliases: number }>;
}

export interface RepoReader {
  /** Repo-relative paths at the target sha. */
  listFiles(): Promise<string[]>;
  /** File content, or null when unreadable/binary/oversized. */
  readFile(path: string): Promise<string | null>;
  /** The sha actually read from, when known. */
  resolvedSha?: string | null;
}

// Batch caps sized for the server's TIME budget, not just its body limit. The
// files route chunks and embeds every byte it is sent before answering, so a
// 1.5 MB batch of large markdown outran the client timeout even though it fit
// the ~4.5 MB body cap. A batch that still times out (or gets a 5xx) is halved
// and retried — see pushBatchAdaptive.
export const MAX_BATCH_FILES = 16;
export const MAX_BATCH_BYTES = 300_000;

/**
 * Whether a failed batch push is worth retrying smaller: a client-side timeout
 * or any 5xx from the ingest API. A 4xx (job no longer running, bad request)
 * means retrying cannot help.
 */
export function isRetryableBatchError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return true;
  if (/timed out/i.test(err.message)) return true;
  return /ingest API error 5\d\d\b/.test(err.message);
}

interface AdaptivePushTotals {
  filesIngested: number;
  chunksUpserted: number;
  filesSkipped: number;
  skippedUnchanged: number;
  batchRetries: number;
}

/**
 * Push one batch; on a retryable failure split it in half and push each half,
 * recursively, down to a single file. A single file that still fails fails the
 * job with the original error.
 */
async function pushBatchAdaptive(
  api: FullIngestApiClient,
  jobId: string,
  batch: IngestFileEntry[],
  totals: AdaptivePushTotals,
): Promise<void> {
  try {
    const res = await api.pushFiles(jobId, batch);
    totals.filesIngested += res.filesIngested;
    totals.chunksUpserted += res.chunksUpserted;
    totals.filesSkipped += res.filesSkipped;
    totals.skippedUnchanged += res.skippedUnchanged ?? 0;
  } catch (err) {
    if (batch.length < 2 || !isRetryableBatchError(err)) throw err;
    totals.batchRetries++;
    const mid = Math.ceil(batch.length / 2);
    await pushBatchAdaptive(api, jobId, batch.slice(0, mid), totals);
    await pushBatchAdaptive(api, jobId, batch.slice(mid), totals);
  }
}

export interface BatchCaps {
  maxFiles: number;
  maxBytes: number;
}

/** Greedy batch planner: consecutive files up to the file-count and byte caps. */
export function planFileBatches(
  files: IngestFileEntry[],
  caps: BatchCaps = { maxFiles: MAX_BATCH_FILES, maxBytes: MAX_BATCH_BYTES },
): IngestFileEntry[][] {
  const batches: IngestFileEntry[][] = [];
  let batch: IngestFileEntry[] = [];
  let batchBytes = 0;
  for (const file of files) {
    const size = Buffer.byteLength(file.content, 'utf8');
    if (batch.length > 0 && (batch.length >= caps.maxFiles || batchBytes + size > caps.maxBytes)) {
      batches.push(batch);
      batch = [];
      batchBytes = 0;
    }
    batch.push(file);
    batchBytes += size;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

export interface RunFullIngestResult {
  status: 'done' | 'error';
  stats?: Record<string, unknown>;
  error?: string;
}

/** Outcome of a SCIP enrichment attempt (see scip-runner.ts). */
export interface ScipEnrichResult {
  graph: ScipGraph | null;
  cached?: boolean;
  skippedReason?: string;
}

export interface RunFullIngestOptions {
  /**
   * Optional precise-graph enrichment for this checkout (SCIP, stream B2b).
   * When provided and it yields a graph, the graph is transmitted via
   * `api.pushGraph` for ADDITIVE persistence. Any failure is swallowed — SCIP
   * is an enhancement, never a dependency, and never affects the file ingest.
   */
  scipEnrich?: (job: FullIngestJob) => Promise<ScipEnrichResult | null>;
  log?: (msg: string) => void;
}

/**
 * Run the optional SCIP enrichment and transmit the resulting graph. Never
 * throws; returns a compact stats object for the job row (or undefined when no
 * enricher ran). The ast-grep edges built during file ingest are untouched
 * regardless of outcome.
 */
async function enrichWithScip(
  job: FullIngestJob,
  api: FullIngestApiClient,
  opts: RunFullIngestOptions,
): Promise<Record<string, unknown> | undefined> {
  if (!opts.scipEnrich) return undefined;
  const log = opts.log ?? (() => {});
  try {
    const result = await opts.scipEnrich(job);
    if (!result) return undefined;
    if (!result.graph) {
      return { attempted: true, ...(result.skippedReason ? { skippedReason: result.skippedReason } : {}) };
    }
    const graph = result.graph;
    const base: Record<string, unknown> = {
      attempted: true,
      cached: !!result.cached,
      ...graph.stats,
    };
    if (!api.pushGraph) {
      // Graph computed but the transport isn't available — record counts so the
      // health UI still reflects that SCIP ran; persistence lands once the
      // server graph route ships.
      return { ...base, persisted: false };
    }
    const written = await api.pushGraph(job.id, {
      entities: graph.entities,
      edges: graph.edges,
      aliases: graph.aliases,
    });
    log(`[knowledge-ingest] SCIP persisted ${written.edges} edges, ${written.aliases} aliases`);
    return { ...base, persisted: true, edgesWritten: written.edges, aliasesWritten: written.aliases };
  } catch (err) {
    log(`[knowledge-ingest] SCIP enrichment skipped: ${err instanceof Error ? err.message : err}`);
    return { attempted: true, skippedReason: err instanceof Error ? err.message.slice(0, 200) : String(err) };
  }
}

/**
 * Execute a claimed full ingest job: list files at the target sha, apply the
 * shared ingest filter, push batches to the server, and record the outcome on
 * the job row. Never throws — failures are reported via completeJob.
 */
export async function runFullIngestJob(
  job: FullIngestJob,
  reader: RepoReader,
  api: FullIngestApiClient,
  caps: BatchCaps = { maxFiles: MAX_BATCH_FILES, maxBytes: MAX_BATCH_BYTES },
  opts: RunFullIngestOptions = {},
): Promise<RunFullIngestResult> {
  const startedAt = Date.now();
  try {
    const allPaths = await reader.listFiles();
    const keepPaths = allPaths.filter(p => shouldIngestFile(p));

    let skipped = 0;
    const entries: IngestFileEntry[] = [];
    for (const path of keepPaths) {
      const content = await reader.readFile(path);
      if (content === null) {
        skipped++;
        continue;
      }
      const fileHash = createHash('sha256').update(content).digest('hex');
      entries.push({ path, content, fileHash });
    }

    const totals: AdaptivePushTotals = {
      filesIngested: 0,
      chunksUpserted: 0,
      filesSkipped: 0,
      skippedUnchanged: 0,
      batchRetries: 0,
    };
    for (const batch of planFileBatches(entries, caps)) {
      await pushBatchAdaptive(api, job.id, batch, totals);
    }
    const { filesIngested, chunksUpserted, skippedUnchanged, batchRetries } = totals;
    skipped += totals.filesSkipped;

    // Precise code-graph enrichment (SCIP). Runs after files are ingested so
    // its edges layer ADDITIVELY on top of the ast-grep graph. Best-effort:
    // a null/failed result never affects the 'done' status below.
    const scipStats = await enrichWithScip(job, api, opts);

    const stats: Record<string, unknown> = {
      filesListed: allPaths.length,
      filesSent: entries.length,
      filesIngested,
      filesSkipped: skipped,
      skippedUnchanged,
      chunksUpserted,
      batchRetries,
      durationMs: Date.now() - startedAt,
      ...(reader.resolvedSha ? { sha: reader.resolvedSha } : {}),
      ...(scipStats ? { scip: scipStats } : {}),
    };
    // sweep: a full run touched every current file, so the server can prune
    // file-derived chunks in this workspace's code/docs namespaces that this
    // run did not refresh (deleted/renamed files since the last full sync).
    await api.completeJob(job.id, { status: 'done', stats, sweep: true });
    return { status: 'done', stats };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      await api.completeJob(job.id, { status: 'error', error: message });
    } catch {
      // Server unreachable — the job stays 'running' until retried/expired.
    }
    return { status: 'error', error: message };
  }
}

// ── Git-backed repo reader ───────────────────────────────────────────────────

function git(repoPath: string, args: string[], maxBuffer = 10 * 1024 * 1024): Buffer {
  return execFileSync('git', args, { cwd: repoPath, maxBuffer, stdio: ['pipe', 'pipe', 'pipe'] });
}

function tryResolveSha(repoPath: string, sha?: string | null): string {
  if (sha) {
    try {
      return git(repoPath, ['rev-parse', '--verify', `${sha}^{commit}`]).toString().trim();
    } catch {
      // Local clone may be behind — fetch the sha, then retry once.
      try {
        git(repoPath, ['fetch', '--quiet', 'origin', sha]);
        return git(repoPath, ['rev-parse', '--verify', `${sha}^{commit}`]).toString().trim();
      } catch {
        // Fall through to HEAD — an index at current HEAD beats no index.
      }
    }
  }
  return git(repoPath, ['rev-parse', 'HEAD']).toString().trim();
}

export type CheckoutCheck = { ok: true } | { ok: false; reason: string };

/** Fetches can hang on an unreachable host; never let one stall the runner. */
const CHECKOUT_FETCH_TIMEOUT_MS = 60_000;

function gitErrorLine(err: unknown): string {
  const e = err as { stderr?: Buffer | string; message?: string };
  const stderr = e?.stderr ? e.stderr.toString() : '';
  const line = stderr.split('\n').map(l => l.trim()).find(Boolean) ?? e?.message ?? String(err);
  return line.slice(0, 300);
}

/**
 * Can this checkout serve the job? A sha already present locally needs no
 * network. Otherwise (a sha we do not have, or no sha, meaning "current
 * default branch") the checkout must be able to fetch `origin`; if it cannot —
 * an SSH remote with no key, a revoked token, a dead host — the reason is
 * returned instead of quietly ingesting a stale HEAD.
 */
export async function checkCheckoutFetchable(repoPath: string, sha?: string | null): Promise<CheckoutCheck> {
  if (sha) {
    try {
      git(repoPath, ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`]);
      return { ok: true };
    } catch {
      // Not present locally — must fetch.
    }
  }
  try {
    execFileSync('git', sha ? ['fetch', '--quiet', 'origin', sha] : ['fetch', '--quiet', 'origin'], {
      cwd: repoPath,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: CHECKOUT_FETCH_TIMEOUT_MS,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
  } catch (err) {
    return { ok: false, reason: `git fetch origin failed: ${gitErrorLine(err)}` };
  }
  if (sha) {
    try {
      git(repoPath, ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`]);
    } catch {
      return { ok: false, reason: `sha ${sha.slice(0, 12)} not found on origin after fetch` };
    }
  }
  return { ok: true };
}

/**
 * Read a repo's tree at a given sha via `git ls-tree` / `git show` — no
 * working-tree checkout or mutation, so it's safe on dirty/in-use clones.
 * Binary (NUL-containing) and oversized blobs read as null.
 */
export function createGitRepoReader(repoPath: string, sha?: string | null): RepoReader {
  const resolvedSha = tryResolveSha(repoPath, sha);
  return {
    resolvedSha,
    async listFiles() {
      const out = git(repoPath, ['ls-tree', '-r', '--name-only', '-z', resolvedSha], 50 * 1024 * 1024);
      return out.toString('utf8').split('\0').filter(Boolean);
    },
    async readFile(path: string) {
      let buf: Buffer;
      try {
        buf = git(repoPath, ['show', `${resolvedSha}:${path}`], MAX_INGEST_FILE_BYTES + 1024);
      } catch {
        return null; // missing path or blob larger than maxBuffer
      }
      if (buf.byteLength > MAX_INGEST_FILE_BYTES) return null;
      if (buf.subarray(0, 8192).includes(0)) return null; // binary
      return buf.toString('utf8');
    },
  };
}

// ── HTTP API client ──────────────────────────────────────────────────────────

export interface HttpIngestApiOptions {
  serverUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  /** Per-request timeout (ms). Embedding batches can take a while. */
  timeoutMs?: number;
}

/** Fetch-backed client for the /api/knowledge/ingest-jobs routes. */
export function createHttpIngestApi(opts: HttpIngestApiOptions): FullIngestApiClient {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const base = opts.serverUrl.replace(/\/$/, '');

  // 120s timeout: embedding batches can take a while — longer than the runner
  // (30s) and MCP server (no timeout). Divergence preserved via transport config.
  const transport = new BuilddTransport({
    baseUrl: base,
    apiKey: opts.apiKey,
    timeoutMs,
  });

  // opts.fetchImpl injection stays supported for tests by swapping globalThis.fetch
  // before construction; the transport picks up whatever fetch is in scope.
  // If a custom fetchImpl is passed, proxy through it by overriding globalThis temporarily
  // is undesirable — instead we keep the post() wrapper so test injection still works.
  const doFetch = opts.fetchImpl;

  async function post<T>(path: string, body: unknown): Promise<T> {
    let res: Response;
    if (doFetch) {
      // Custom fetchImpl (tests) — keep compatibility by calling it directly.
      res = await doFetch(`${base}${path}`, {
        method: 'POST',
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${opts.apiKey}`,
        },
        body: JSON.stringify(body),
      });
    } else {
      res = await transport.request(path, {
        method: 'POST',
        body: JSON.stringify(body),
      });
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`ingest API error ${res.status}: ${text.slice(0, 500)}`);
    }
    return res.json() as Promise<T>;
  }

  return {
    async claimJob(repos) {
      const data = await post<{ job: FullIngestJob | null }>('/api/knowledge/ingest-jobs/claim', { repos });
      return data.job ?? null;
    },
    async pushFiles(jobId, files) {
      return post<IngestBatchStats>(`/api/knowledge/ingest-jobs/${jobId}/files`, { files });
    },
    async completeJob(jobId, result) {
      await post(`/api/knowledge/ingest-jobs/${jobId}/complete`, result);
    },
    async releaseJob(jobId, reason) {
      await post(`/api/knowledge/ingest-jobs/${jobId}/complete`, { status: 'released', error: reason });
    },
    async pushGraph(jobId, graph) {
      return post<{ edges: number; aliases: number }>(
        `/api/knowledge/ingest-jobs/${jobId}/graph`,
        graph,
      );
    },
  };
}
