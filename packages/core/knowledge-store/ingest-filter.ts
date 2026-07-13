/**
 * Shared file-filter rules for knowledge ingestion.
 *
 * Used by both the bulk ingest script (`packages/core/scripts/ingest-knowledge.ts`)
 * and the serverless per-PR diff ingester (`apps/web/src/lib/knowledge-ingest.ts`)
 * so both paths agree on what belongs in the code/docs corpora.
 *
 * Pure — no I/O, no heavy imports — safe to load anywhere (including test envs
 * where drizzle/db modules are mocked).
 */

export const DOC_EXTENSIONS = new Set(['.md', '.mdx', '.markdown']);

export const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.java', '.rb', '.php', '.c', '.h', '.cc', '.cpp', '.hpp',
  '.cs', '.swift', '.kt', '.scala', '.sh', '.sql', '.css', '.scss',
]);

/** Directories that never contain retrieval-worthy source (deps, build output). */
export const DEFAULT_SKIP_DIRS = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', 'coverage', '.turbo', '.vercel',
]);

export const TEST_FILE_RE = /\.(test|spec)\.[tj]sx?$/;

/** Skip very large files (minified bundles, generated blobs). */
export const MAX_INGEST_FILE_BYTES = 512 * 1024;

const LOCKFILE_NAMES = new Set([
  'bun.lockb', 'bun.lock', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
  'cargo.lock', 'composer.lock', 'gemfile.lock', 'poetry.lock',
]);

/** Generated / migration paths — history, not current-state truth. */
const GENERATED_PATH_RE = /(^|\/)(drizzle|migrations|__generated__|generated)\//;

/**
 * Classify a repo-relative path into its ingest corpus:
 * markdown → `docs`, known source extensions → `code`, anything else → null.
 */
export function classifyIngestCorpus(filePath: string): 'code' | 'docs' | null {
  const normalized = filePath.replace(/\\/g, '/');
  const base = normalized.split('/').pop() ?? normalized;
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return null; // no extension (or dotfile)
  const ext = base.slice(dot).toLowerCase();
  if (DOC_EXTENSIONS.has(ext)) return 'docs';
  if (CODE_EXTENSIONS.has(ext)) return 'code';
  return null;
}

export interface ShouldIngestOptions {
  /** File size, when known. Files over MAX_INGEST_FILE_BYTES are rejected. */
  sizeBytes?: number;
  /** Drop test/spec files. Default true (they're history, not truth). */
  skipTests?: boolean;
  /** Directory names to skip. Defaults to DEFAULT_SKIP_DIRS. */
  skipDirs?: Set<string>;
}

/**
 * Single shared gate: should this file be ingested into the knowledge store?
 * Rejects tests, migrations/generated paths, lockfiles, dep/build dirs,
 * unknown/binary extensions, and oversized files.
 */
export function shouldIngestFile(filePath: string, opts: ShouldIngestOptions = {}): boolean {
  const { sizeBytes, skipTests = true, skipDirs = DEFAULT_SKIP_DIRS } = opts;
  const normalized = filePath.replace(/\\/g, '/');
  const base = normalized.split('/').pop() ?? normalized;

  if (normalized.split('/').some(segment => skipDirs.has(segment))) return false;
  if (GENERATED_PATH_RE.test(normalized)) return false;
  if (LOCKFILE_NAMES.has(base.toLowerCase()) || base.toLowerCase().endsWith('.lock')) return false;
  if (skipTests && TEST_FILE_RE.test(base)) return false;
  if (!classifyIngestCorpus(normalized)) return false;
  if (sizeBytes != null && sizeBytes > MAX_INGEST_FILE_BYTES) return false;
  return true;
}
