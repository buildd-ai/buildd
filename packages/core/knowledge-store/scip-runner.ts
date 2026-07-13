// Side-effectful `scip-typescript` invocation for runner full-ingest jobs
// (KM v2 spec §4 / §8, stream B2b). This is the ONLY module that shells out to
// the SCIP indexer; the actual index → graph derivation lives in the pure,
// unit-tested `scip-parser.ts`. Keeping the split lets the whole side-effect
// surface (child_process, fs) degrade to a graceful no-op while the parser
// stays trivially testable.
//
// SCIP is an ENHANCEMENT, never a hard dependency: a missing `scip-typescript`
// binary, a project that won't index, a decode error — any of these returns a
// null graph and leaves the ast-grep edges from the normal ingest path fully
// intact. Nothing here throws.
//
// NOT re-exported from knowledge-store/index.ts — like full-ingest.ts and
// symbol-extractor.ts, it touches child_process and must never be pulled into
// a serverless bundle graph. Reach it only via dynamic import() from the runner.

import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { decodeScipIndex, buildScipGraph, type ScipGraph } from './scip-parser';

export interface ScipRunnerOptions {
  /** Working-tree checkout to index. scip-typescript compiles the project here. */
  repoPath: string;
  /** Resolved commit sha, for SHA-keyed caching. When absent, no cache reuse. */
  sha?: string | null;
  workspaceId: string;
  /** "owner/name" or similar — namespaces the on-disk cache. */
  repoSlug?: string;
  /** Hard cap on the indexer run (default 5 min). */
  timeoutMs?: number;
  cacheDir?: string;
  /** Test hook: produce the SCIP index at `outputPath`, throwing on failure. */
  invoke?: (args: { repoPath: string; outputPath: string; timeoutMs: number }) => void;
  /** Test hook: read a produced index file (null when unreadable). */
  readIndexFile?: (path: string) => Buffer | null;
  log?: (msg: string) => void;
}

export interface ScipRunResult {
  graph: ScipGraph | null;
  /** True when a prior index for this sha was reused (scip-typescript skipped). */
  cached: boolean;
  /** Populated when no graph was produced — for stats/observability. */
  skippedReason?: string;
}

const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const MAX_INDEX_BYTES = 128 * 1024 * 1024; // sanity cap on the .scip blob

/**
 * Run (or reuse a cached) SCIP index over a checkout and derive the precise
 * code graph. Never throws — failures surface as `{ graph: null, skippedReason }`.
 */
export async function runScipGraph(opts: ScipRunnerOptions): Promise<ScipRunResult> {
  const log = opts.log ?? (() => {});
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const readIndex = opts.readIndexFile ?? defaultReadIndexFile;
  const invoke = opts.invoke ?? defaultInvoke;

  const outputPath = resolveOutputPath(opts);
  let cached = false;

  try {
    // ── SHA cache: reuse a prior index for this sha (content check, no schema) ─
    if (opts.sha && fileHasContent(outputPath)) {
      cached = true;
      log(`[scip] reusing cached index for sha ${opts.sha} at ${outputPath}`);
    } else {
      try {
        mkdirSync(dirOf(outputPath), { recursive: true });
      } catch {
        // best-effort — invoke may still succeed with an existing dir
      }
      invoke({ repoPath: opts.repoPath, outputPath, timeoutMs });
    }

    const buf = readIndex(outputPath);
    if (!buf || buf.byteLength === 0) {
      return { graph: null, cached, skippedReason: 'no-index-produced' };
    }
    if (buf.byteLength > MAX_INDEX_BYTES) {
      return { graph: null, cached, skippedReason: 'index-too-large' };
    }

    const index = decodeScipIndex(buf);
    const graph = buildScipGraph(index, { workspaceId: opts.workspaceId });
    log(
      `[scip] parsed ${graph.stats.documents} docs → ${graph.edges.length} edges ` +
        `(${graph.stats.definitions} def / ${graph.stats.references} ref / ${graph.stats.imports} imp), ` +
        `${graph.aliases.length} aliases${cached ? ' [cached]' : ''}`,
    );
    return { graph, cached };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log(`[scip] skipped: ${reason}`);
    return { graph: null, cached, skippedReason: reason.slice(0, 200) };
  }
}

// ── Defaults (real side effects) ──────────────────────────────────────────────

function defaultInvoke(args: { repoPath: string; outputPath: string; timeoutMs: number }): void {
  const indexArgs = ['index', '--output', args.outputPath];
  const attempts: Array<{ cmd: string; argv: string[] }> = [];
  // 1. Explicit override (deployment sets this to the installed binary).
  if (process.env.SCIP_TYPESCRIPT_BIN) attempts.push({ cmd: process.env.SCIP_TYPESCRIPT_BIN, argv: indexArgs });
  // 2. A node_modules/.bin binary hoisted somewhere above this module (monorepo).
  const localBin = findLocalBin();
  if (localBin) attempts.push({ cmd: localBin, argv: indexArgs });
  // 3. On PATH (globally installed), then npx without an implicit install.
  attempts.push({ cmd: 'scip-typescript', argv: indexArgs });
  attempts.push({ cmd: 'npx', argv: ['--no-install', '@sourcegraph/scip-typescript', ...indexArgs] });

  let lastErr: unknown;
  for (const attempt of attempts) {
    try {
      execFileSync(attempt.cmd, attempt.argv, {
        cwd: args.repoPath,
        timeout: args.timeoutMs,
        stdio: ['ignore', 'ignore', 'pipe'],
        maxBuffer: 16 * 1024 * 1024,
      });
      return; // succeeded
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(
    `scip-typescript unavailable or failed: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
  );
}

/** Walk up from this module looking for a hoisted scip-typescript binary. */
function findLocalBin(): string | null {
  let dir: string;
  try {
    // Bun/ESM: import.meta.dir; fall back to cwd when unavailable.
    dir = (import.meta as { dir?: string }).dir ?? process.cwd();
  } catch {
    dir = process.cwd();
  }
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, 'node_modules', '.bin', 'scip-typescript');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function defaultReadIndexFile(path: string): Buffer | null {
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path);
  } catch {
    return null;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function resolveOutputPath(opts: ScipRunnerOptions): string {
  const base = opts.cacheDir ?? join(tmpdir(), 'buildd-scip');
  const slug = (opts.repoSlug ?? 'repo').replace(/[^a-zA-Z0-9._-]/g, '_');
  const sha = opts.sha ? opts.sha.slice(0, 40) : `nosha-${process.pid}`;
  return join(base, `${slug}-${sha}.scip`);
}

function dirOf(p: string): string {
  return p.split('/').slice(0, -1).join('/') || '.';
}

function fileHasContent(path: string): boolean {
  try {
    return statSync(path).size > 0;
  } catch {
    return false;
  }
}
