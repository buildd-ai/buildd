/**
 * Semantic overlap check before a clean base refresh
 * (conflict-aware-orchestration.md §4).
 *
 * A behind-only PR can merge the base in cleanly and still be wrong: the base
 * and the PR edited the same function in different hunks. Before refreshing,
 * this compares the PR's and the newly arrived base's changes from their common
 * ancestor and, where both touch the same file, maps the changed hunks to symbol
 * identities through a revision-pinned symbol index, then intersects symbols —
 * not filenames.
 *
 * Verdicts:
 *  - `disjoint_paths`   — complete file lists share no path. No symbol lookup.
 *  - `same_symbol`      — a verified symbol is edited on both sides (evidence).
 *  - `disjoint_symbols` — every shared file resolved at pinned revisions, no
 *                         common symbol. The only verified clearance for a
 *                         shared file.
 *  - `unknown`          — anything short of that: no index, a stale index, a
 *                         truncated list, a missing patch, a budget overrun, a
 *                         GitHub read failure. NEVER treated as disjoint.
 *  - `head_changed`     — the PR moved under us; re-read, do not judge.
 *
 * Revision coverage. No symbol index is reachable from the server, let alone
 * one that answers at an exact commit. `getServerSymbolProvider()` therefore returns the unavailable provider,
 * so every shared-file refresh reads `unknown` and semantic auto-clearance is in
 * effect disabled — as the design requires when pinned revisions cannot be
 * supplied. Plugging in a provider that answers at the requested revision is the
 * one change needed to enable it; a provider answering at any other revision is
 * stale and reads `unknown`.
 *
 * Pure apart from the injected GitHub reader and provider: no DB, no model call.
 */

import type { WorkspaceGitConfig } from '@buildd/core/db/schema';
import { githubApi } from '@/lib/github';

export type SemanticRefreshMode = 'off' | 'shadow' | 'enforce';

/** Default off: absent, null, 'off' or any unrecognised value. */
export function resolveSemanticRefreshMode(gitConfig: WorkspaceGitConfig | null | undefined): SemanticRefreshMode {
  const mode = (gitConfig as { semanticRefresh?: unknown } | null | undefined)?.semanticRefresh;
  return mode === 'shadow' || mode === 'enforce' ? mode : 'off';
}

// ── Hunks ─────────────────────────────────────────────────────────────────────

export interface LineRange { start: number; end: number }

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function range(start: number, count: number): LineRange | null {
  return count > 0 ? { start, end: start + count - 1 } : null;
}

/**
 * Old-side and new-side line ranges of a unified-diff patch. Null when there is
 * no hunk or any `@@` line fails to parse — a partial reading is not evidence.
 */
export function parseHunkRanges(patch: string): { old: LineRange[]; new: LineRange[] } | null {
  const out = { old: [] as LineRange[], new: [] as LineRange[] };
  let hunks = 0;
  for (const line of patch.split('\n')) {
    if (!line.startsWith('@@')) continue;
    const m = HUNK.exec(line);
    if (!m) return null;
    hunks++;
    const o = range(Number(m[1]), m[2] === undefined ? 1 : Number(m[2]));
    const n = range(Number(m[3]), m[4] === undefined ? 1 : Number(m[4]));
    if (o) out.old.push(o);
    if (n) out.new.push(n);
  }
  return hunks > 0 ? out : null;
}

// ── Symbol provider ──────────────────────────────────────────────────────────

export interface SymbolLookupRequest {
  repoFullName: string;
  /** Exact commit the ranges refer to. */
  revision: string;
  path: string;
  ranges: LineRange[];
}

export type SymbolLookupResult =
  | { status: 'ok'; revision: string; symbols: string[] }
  | { status: 'unavailable' | 'unindexed' | 'stale'; reason: string };

export interface RevisionSymbolProvider {
  lookup(req: SymbolLookupRequest): Promise<SymbolLookupResult>;
}

export const UNAVAILABLE_SYMBOL_PROVIDER: RevisionSymbolProvider = {
  async lookup() {
    return {
      status: 'unavailable',
      reason: 'no revision-pinned symbol index is reachable from the server',
    };
  },
};

/** The provider the deployed server uses. See the header: none can pin revisions yet. */
export function getServerSymbolProvider(): RevisionSymbolProvider {
  return UNAVAILABLE_SYMBOL_PROVIDER;
}

// ── Assessment ───────────────────────────────────────────────────────────────

export type SemanticVerdict = 'disjoint_paths' | 'same_symbol' | 'disjoint_symbols' | 'unknown' | 'head_changed';

export interface SemanticAssessment {
  verdict: SemanticVerdict;
  reason: string;
  baseRef?: string | null;
  baseSha?: string | null;
  mergeBaseSha?: string | null;
  sharedPaths?: string[];
  evidence?: Array<{ path: string; symbols: string[] }>;
  lookups?: number;
}

export interface SemanticLimits {
  maxSharedFiles: number;
  maxLookups: number;
  lookupTimeoutMs: number;
}

export const DEFAULT_SEMANTIC_LIMITS: SemanticLimits = { maxSharedFiles: 20, maxLookups: 80, lookupTimeoutMs: 5000 };

/**
 * Longest a default-limits check can spend in symbol lookups: every lookup in
 * the budget running to its timeout. The refresh lease must outlive this.
 */
export const SEMANTIC_CHECK_WORST_CASE_MS = DEFAULT_SEMANTIC_LIMITS.maxLookups * DEFAULT_SEMANTIC_LIMITS.lookupTimeoutMs;

/** GitHub's compare endpoint lists at most this many files; a full page may be truncated. */
const COMPARE_FILE_CAP = 300;

type Api = (installationId: number, path: string, init?: RequestInit) => Promise<unknown>;

interface CompareFile { filename: string; patch?: string; previous_filename?: string }

function asFiles(raw: unknown): CompareFile[] | null {
  const files = (raw as { files?: unknown } | null)?.files;
  if (!Array.isArray(files)) return null;
  const out: CompareFile[] = [];
  for (const f of files) {
    if (!f || typeof f !== 'object' || typeof (f as CompareFile).filename !== 'string') return null;
    out.push(f as CompareFile);
  }
  return out;
}

function pathsOf(f: CompareFile): string[] {
  return f.previous_filename && f.previous_filename !== f.filename ? [f.filename, f.previous_filename] : [f.filename];
}

class Unknown extends Error {}

export async function assessSemanticOverlap(params: {
  installationId: number;
  repoFullName: string;
  prNumber: number;
  headSha: string;
  api?: Api;
  provider?: RevisionSymbolProvider;
  limits?: Partial<SemanticLimits>;
  /**
   * Judge against this exact base commit instead of the PR's live base tip, and
   * skip the live-head check. Used to re-verify a refresh after the fact
   * (base-refresh.ts `checkBaseRefreshHold`): the PR head is then the
   * update-branch merge commit, and both ends of the comparison are history.
   */
  pinnedBaseSha?: string;
}): Promise<SemanticAssessment> {
  const api = params.api ?? githubApi;
  const provider = params.provider ?? getServerSymbolProvider();
  const limits = { ...DEFAULT_SEMANTIC_LIMITS, ...params.limits };
  const repo = `/repos/${params.repoFullName}`;
  const { headSha } = params;

  let baseRef: string | null = null;
  let baseSha: string | null = null;
  let mergeBaseSha: string | null = null;
  let prFiles: CompareFile[] | null;
  let baseFiles: CompareFile[] | null;
  try {
    if (params.pinnedBaseSha) {
      baseSha = params.pinnedBaseSha;
    } else {
      const pr = (await api(params.installationId, `${repo}/pulls/${params.prNumber}`)) as {
        head?: { sha?: string }; base?: { ref?: string };
      } | null;
      const liveHead = pr?.head?.sha ?? null;
      if (liveHead !== headSha) {
        return { verdict: 'head_changed', reason: `the PR head is ${liveHead?.slice(0, 7) ?? 'unknown'}, not the evaluated ${headSha.slice(0, 7)}` };
      }
      baseRef = pr?.base?.ref ?? null;
      if (!baseRef) return { verdict: 'unknown', reason: 'GitHub returned no base branch for the PR' };
      const tip = (await api(params.installationId, `${repo}/commits/${encodeURIComponent(baseRef)}`)) as { sha?: string } | null;
      baseSha = typeof tip?.sha === 'string' ? tip.sha : null;
      if (!baseSha) return { verdict: 'unknown', reason: `could not resolve the tip of ${baseRef}`, baseRef };
    }
    const prSide = await api(params.installationId, `${repo}/compare/${baseSha}...${headSha}`);
    const baseSide = await api(params.installationId, `${repo}/compare/${headSha}...${baseSha}`);
    const mbA = (prSide as { merge_base_commit?: { sha?: string } } | null)?.merge_base_commit?.sha ?? null;
    const mbB = (baseSide as { merge_base_commit?: { sha?: string } } | null)?.merge_base_commit?.sha ?? null;
    if (!mbA || mbA !== mbB) return { verdict: 'unknown', reason: 'could not establish one common ancestor', baseRef, baseSha };
    mergeBaseSha = mbA;
    prFiles = asFiles(prSide);
    baseFiles = asFiles(baseSide);
  } catch (err) {
    return {
      verdict: 'unknown',
      reason: `could not read the diff from GitHub: ${err instanceof Error ? err.message : String(err)}`,
      baseRef,
      baseSha,
    };
  }
  const ids = { baseRef, baseSha, mergeBaseSha };

  if (!prFiles || !baseFiles) return { verdict: 'unknown', reason: 'malformed file list from GitHub', ...ids };
  if (prFiles.length >= COMPARE_FILE_CAP || baseFiles.length >= COMPARE_FILE_CAP) {
    return { verdict: 'unknown', reason: `a side lists ${COMPARE_FILE_CAP}+ files; the list may be truncated`, ...ids };
  }

  const basePaths = new Map<string, CompareFile>();
  for (const f of baseFiles) for (const p of pathsOf(f)) basePaths.set(p, f);
  const pairs: Array<{ path: string; pr: CompareFile; base: CompareFile }> = [];
  for (const f of prFiles) {
    const hit = pathsOf(f).map((p) => basePaths.get(p)).find(Boolean);
    if (hit) pairs.push({ path: f.filename, pr: f, base: hit });
  }
  const sharedPaths = pairs.map((p) => p.path);
  if (pairs.length === 0) return { verdict: 'disjoint_paths', reason: 'the PR and the base changed no file in common', ...ids, sharedPaths };
  if (pairs.length > limits.maxSharedFiles) {
    return { verdict: 'unknown', reason: `${pairs.length} shared files exceed the bound of ${limits.maxSharedFiles}`, ...ids, sharedPaths };
  }

  let lookups = 0;
  const lookup = async (revision: string, path: string, ranges: LineRange[]): Promise<string[]> => {
    if (ranges.length === 0) return [];
    if (++lookups > limits.maxLookups) throw new Unknown(`symbol lookup budget of ${limits.maxLookups} exhausted`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Unknown(`symbol lookup for ${path} timed out`)), limits.lookupTimeoutMs);
    });
    let res: SymbolLookupResult;
    try {
      res = await Promise.race([provider.lookup({ repoFullName: params.repoFullName, revision, path, ranges }), timeout]);
    } catch (err) {
      throw err instanceof Unknown ? err : new Unknown(`symbol lookup for ${path} failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(timer);
    }
    if (res.status !== 'ok') throw new Unknown(`symbol index ${res.status}: ${res.reason}`);
    if (res.revision !== revision) throw new Unknown(`symbol index answered at revision ${res.revision.slice(0, 7)}, not ${revision.slice(0, 7)}`);
    if (res.symbols.length === 0) throw new Unknown(`a changed range in ${path} maps to no symbol`);
    return res.symbols;
  };

  const sideSymbols = async (f: CompareFile, tip: string): Promise<Set<string>> => {
    if (typeof f.patch !== 'string') throw new Unknown(`GitHub sent no patch for ${f.filename}`);
    const hunks = parseHunkRanges(f.patch);
    if (!hunks) throw new Unknown(`could not parse the hunks of ${f.filename}`);
    const out = new Set<string>();
    for (const s of await lookup(mergeBaseSha!, f.previous_filename ?? f.filename, hunks.old)) out.add(s);
    for (const s of await lookup(tip, f.filename, hunks.new)) out.add(s);
    return out;
  };

  const evidence: Array<{ path: string; symbols: string[] }> = [];
  try {
    for (const pair of pairs) {
      const mine = await sideSymbols(pair.pr, headSha);
      const theirs = await sideSymbols(pair.base, baseSha!);
      const both = [...mine].filter((s) => theirs.has(s)).sort();
      if (both.length > 0) evidence.push({ path: pair.path, symbols: both });
    }
  } catch (err) {
    if (err instanceof Unknown) return { verdict: 'unknown', reason: err.message, ...ids, sharedPaths, lookups };
    throw err;
  }

  if (evidence.length > 0) {
    return { verdict: 'same_symbol', reason: `both sides edit ${evidence.flatMap((e) => e.symbols).join(', ')}`, ...ids, sharedPaths, evidence, lookups };
  }
  return { verdict: 'disjoint_symbols', reason: 'shared files resolved at pinned revisions; no symbol edited on both sides', ...ids, sharedPaths, lookups };
}
