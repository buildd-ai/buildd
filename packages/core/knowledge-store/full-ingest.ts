// Client-side executor for `full`-scope knowledge ingest jobs (KM v2 spec
// §3.3/§3.4 — stream A2). Runs wherever a repo checkout exists — the runner
// fleet or any CI with BUILDD_API_KEY — and streams file batches to the
// server's ingest-job routes, which do the chunking/embedding/upserting.
//
// NOT re-exported from knowledge-store/index.ts: this module touches
// child_process and must never enter a serverless bundle graph.

import { execFileSync } from 'child_process';
import { shouldIngestFile, MAX_INGEST_FILE_BYTES } from './ingest-filter';

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
}

export interface IngestBatchStats {
  filesIngested: number;
  chunksUpserted: number;
  filesSkipped: number;
  filesDeleted: number;
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
}

export interface RepoReader {
  /** Repo-relative paths at the target sha. */
  listFiles(): Promise<string[]>;
  /** File content, or null when unreadable/binary/oversized. */
  readFile(path: string): Promise<string | null>;
  /** The sha actually read from, when known. */
  resolvedSha?: string | null;
}

// Batch caps sized for serverless request limits (Vercel bodies cap ~4.5 MB;
// stay well under so base64/JSON overhead never matters).
export const MAX_BATCH_FILES = 40;
export const MAX_BATCH_BYTES = 1_500_000;

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
      entries.push({ path, content });
    }

    let filesIngested = 0;
    let chunksUpserted = 0;
    for (const batch of planFileBatches(entries, caps)) {
      const res = await api.pushFiles(job.id, batch);
      filesIngested += res.filesIngested;
      chunksUpserted += res.chunksUpserted;
      skipped += res.filesSkipped;
    }

    const stats: Record<string, unknown> = {
      filesListed: allPaths.length,
      filesSent: entries.length,
      filesIngested,
      filesSkipped: skipped,
      chunksUpserted,
      durationMs: Date.now() - startedAt,
      ...(reader.resolvedSha ? { sha: reader.resolvedSha } : {}),
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
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const base = opts.serverUrl.replace(/\/$/, '');

  async function post<T>(path: string, body: unknown): Promise<T> {
    const res = await doFetch(`${base}${path}`, {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify(body),
    });
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
  };
}
