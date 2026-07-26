/**
 * Pure anchor extractor — no DB, no network, no side effects.
 *
 * Implements docs/design/task-subject-anchors.md §2 (Extraction and precedence).
 * Precedence order (high → low):
 *   1. Trusted system context (webhook, watcher, organizer, retry)
 *   2. Explicit API subjectAnchor
 *   3. Exact GitHub PR URLs in title/description
 *   4. Conservative text patterns (PR #N, pull request #N)
 *   5. Legacy context keys (prNumber/pr, headSha, frictionSignature, baseBranch, …)
 *   6. No anchor
 *
 * Normalization rules are load-bearing — see individual function docs.
 */

import type { TaskSubjectAnchor } from '@buildd/shared';

// ── Known error-scanner slug catalog ─────────────────────────────────────────

/**
 * Stable slugs produced by apps/runner/src/error-trace-scanner.ts.
 * Free-form error text is NEVER a valid errorSignature; only these slugs
 * (or namespaced system signatures like "namespace:slug") are accepted.
 */
export const KNOWN_ERROR_SLUGS: ReadonlySet<string> = new Set([
  'cd_no_such_file',
  'no_such_file',
  'permission_denied',
  'command_not_found',
  'enoent',
  'oom_killed',
  'git_fatal',
  'git_error',
  'rate_limit',
  'connection_refused',
  'timeout',
  'bwrap_namespace_denied',
  'sandbox_mount_gap',
]);

// ── Normalization functions ───────────────────────────────────────────────────

/**
 * Normalize a commit SHA.
 * Returns lowercase hex string, or null if the input is invalid.
 * Valid: lowercase hexadecimal, 7–64 characters.
 */
export function normalizeHeadSha(sha: string): string | null {
  if (!sha || typeof sha !== 'string') return null;
  const lower = sha.toLowerCase();
  if (!/^[0-9a-f]{7,64}$/.test(lower)) return null;
  return lower;
}

/**
 * Normalize a branch name.
 * Strips an optional `refs/heads/` prefix; otherwise preserves case exactly.
 * Returns null for empty or whitespace-only strings.
 */
export function normalizeBranch(branch: string): string | null {
  if (!branch || typeof branch !== 'string') return null;
  const trimmed = branch.trim();
  if (!trimmed) return null;
  return trimmed.startsWith('refs/heads/') ? trimmed.slice('refs/heads/'.length) : trimmed;
}

/**
 * Normalize an error signature.
 * Accepts:
 *   - a known scanner slug (see KNOWN_ERROR_SLUGS)
 *   - a namespaced system signature: "namespace:slug" where both parts are non-empty
 *     and contain only word chars / hyphens.
 * Rejects free-form error text, empty strings, and unknown bare slugs.
 */
export function normalizeErrorSignature(sig: string): string | null {
  if (!sig || typeof sig !== 'string') return null;
  if (KNOWN_ERROR_SLUGS.has(sig)) return sig;
  // Namespaced system signature: word chars and hyphens on both sides of exactly one colon
  const nsMatch = /^([A-Za-z0-9_-]+):([A-Za-z0-9_-]+)$/.exec(sig);
  if (nsMatch) return sig;
  return null;
}

/**
 * Normalize failing check names.
 * Each entry is trimmed and case-preserved. Empty-after-trim entries are dropped.
 * The result is deduplicated, sorted lexicographically, and bounded to 50 entries
 * of 200 characters each. Entries longer than 200 chars are dropped (not truncated).
 */
export function normalizeFailingCheckNames(names: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of names) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.length > 200 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  result.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return result.slice(0, 50);
}

// ── Input types ───────────────────────────────────────────────────────────────

export interface SystemContext {
  prNumber?: number;
  headSha?: string;
  branch?: string;
  errorSignature?: string;
  failingCheckNames?: string[];
  subjectMissionId?: string;
  origin: 'webhook' | 'watcher' | 'organizer' | 'retry';
}

export interface AnchorExtractionInput {
  title?: string;
  description?: string;
  /** Legacy context bag from task.context (prNumber, pr, headSha, frictionSignature, …) */
  context?: Record<string, unknown>;
  /** Trusted system context — highest precedence. */
  systemContext?: SystemContext;
  /** Explicit subject anchor from API caller — second precedence. */
  subjectAnchor?: Partial<TaskSubjectAnchor>;
  /**
   * Workspace repository slug (e.g. "buildd-ai/buildd").
   * Required for URL-parsed and text-pattern anchors so the PR repo can be validated.
   */
  workspaceRepo?: string;
}

export interface AnchorExtractionResult {
  anchor: TaskSubjectAnchor | null;
  warnings: string[];
}

// ── GitHub PR URL pattern ─────────────────────────────────────────────────────

const GITHUB_PR_URL_RE = /https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:[?#][^\s]*)?\b/g;

// PR text pattern: "PR #N" or "pull request #N" (case-insensitive)
const PR_TEXT_RE = /\b(?:pull\s+request|pr)\s+#(\d+)\b/gi;

interface ParsedPrUrl {
  owner: string;
  repo: string;
  prNumber: number;
}

function parsePrUrls(text: string): ParsedPrUrl[] {
  const results: ParsedPrUrl[] = [];
  for (const m of text.matchAll(GITHUB_PR_URL_RE)) {
    const prNumber = parseInt(m[3], 10);
    if (prNumber <= 0) continue;
    results.push({ owner: m[1], repo: m[2], prNumber });
  }
  return results;
}

function parsePrTextMatches(text: string): number[] {
  const numbers: number[] = [];
  for (const m of text.matchAll(PR_TEXT_RE)) {
    const n = parseInt(m[1], 10);
    if (n > 0) numbers.push(n);
  }
  return numbers;
}

// ── Kind resolution ───────────────────────────────────────────────────────────

function resolveKind(
  prNumber: number | undefined,
  errorSignature: string | undefined,
  subjectMissionId: string | undefined,
  branch: string | undefined,
): TaskSubjectAnchor['kind'] | null {
  if (prNumber !== undefined) return 'pull_request';
  if (errorSignature !== undefined) return 'error';
  if (subjectMissionId !== undefined) return 'mission';
  if (branch !== undefined) return 'branch';
  return null;
}

// ── Main extractor ────────────────────────────────────────────────────────────

/**
 * Extract and normalize a TaskSubjectAnchor from task creation inputs.
 * Pure function — no I/O, no DB, no network.
 */
export function extractSubjectAnchor(input: AnchorExtractionInput): AnchorExtractionResult {
  const warnings: string[] = [];

  // ── 1. Trusted system context (highest precedence) ──────────────────────────
  if (input.systemContext) {
    const sc = input.systemContext;
    const prNumber = typeof sc.prNumber === 'number' && sc.prNumber > 0 ? sc.prNumber : undefined;
    const headSha = sc.headSha ? (normalizeHeadSha(sc.headSha) ?? undefined) : undefined;
    const branch = sc.branch ? (normalizeBranch(sc.branch) ?? undefined) : undefined;
    const errorSignature = sc.errorSignature
      ? (normalizeErrorSignature(sc.errorSignature) ?? undefined)
      : undefined;

    if (sc.errorSignature && !errorSignature) {
      // Invalid errorSignature — no anchor from system context
      return { anchor: null, warnings };
    }

    const failingCheckNames = sc.failingCheckNames
      ? normalizeFailingCheckNames(sc.failingCheckNames)
      : undefined;
    const subjectMissionId = typeof sc.subjectMissionId === 'string' ? sc.subjectMissionId : undefined;

    const kind = resolveKind(prNumber, errorSignature, subjectMissionId, branch);
    if (kind !== null) {
      return {
        anchor: {
          version: 1,
          kind,
          ...(prNumber !== undefined && { prNumber }),
          ...(headSha !== undefined && { headSha }),
          ...(branch !== undefined && { branch }),
          ...(errorSignature !== undefined && { errorSignature }),
          ...(failingCheckNames !== undefined && failingCheckNames.length > 0 && { failingCheckNames }),
          ...(subjectMissionId !== undefined && { subjectMissionId }),
          source: 'system',
          confidence: 'exact',
        },
        warnings,
      };
    }
  }

  // ── 2. Explicit API subjectAnchor (second precedence) ──────────────────────
  if (input.subjectAnchor) {
    const sa = input.subjectAnchor;
    const prNumber = typeof sa.prNumber === 'number' && sa.prNumber > 0 ? sa.prNumber : undefined;
    const headSha = sa.headSha ? (normalizeHeadSha(sa.headSha) ?? undefined) : undefined;
    const branch = sa.branch ? (normalizeBranch(sa.branch) ?? undefined) : undefined;
    const errorSignature = sa.errorSignature
      ? (normalizeErrorSignature(sa.errorSignature) ?? undefined)
      : undefined;
    const failingCheckNames = sa.failingCheckNames
      ? normalizeFailingCheckNames(sa.failingCheckNames)
      : undefined;
    const subjectMissionId = typeof sa.subjectMissionId === 'string' ? sa.subjectMissionId : undefined;

    const kind = sa.kind ?? resolveKind(prNumber, errorSignature, subjectMissionId, branch);
    if (kind !== null) {
      return {
        anchor: {
          version: 1,
          kind,
          ...(prNumber !== undefined && { prNumber }),
          ...(headSha !== undefined && { headSha }),
          ...(branch !== undefined && { branch }),
          ...(errorSignature !== undefined && { errorSignature }),
          ...(failingCheckNames !== undefined && failingCheckNames.length > 0 && { failingCheckNames }),
          ...(subjectMissionId !== undefined && { subjectMissionId }),
          source: sa.source ?? 'context',
          confidence: sa.confidence ?? 'derived',
        },
        warnings,
      };
    }
  }

  // ── 3. Exact GitHub PR URLs in title/description ────────────────────────────
  if (input.workspaceRepo) {
    const [wsOwner, wsRepo] = input.workspaceRepo.split('/');
    const searchText = [input.title ?? '', input.description ?? ''].join(' ');
    const parsed = parsePrUrls(searchText).filter(
      (p) => p.owner === wsOwner && p.repo === wsRepo,
    );

    const uniqueNumbers = [...new Set(parsed.map((p) => p.prNumber))];
    if (uniqueNumbers.length === 1) {
      return {
        anchor: {
          version: 1,
          kind: 'pull_request',
          prNumber: uniqueNumbers[0],
          source: 'url',
          confidence: 'derived',
        },
        warnings,
      };
    } else if (uniqueNumbers.length > 1) {
      warnings.push(
        `ambiguous: multiple PR numbers found in text (${uniqueNumbers.join(', ')}); provide explicit subjectAnchor to select one`,
      );
      // Fall through — no anchor from URLs
    }
  }

  // ── 4. Conservative text patterns (PR #N, pull request #N) ─────────────────
  if (input.workspaceRepo) {
    const searchText = [input.title ?? '', input.description ?? ''].join(' ');
    const textNumbers = [...new Set(parsePrTextMatches(searchText))];

    if (textNumbers.length === 1) {
      return {
        anchor: {
          version: 1,
          kind: 'pull_request',
          prNumber: textNumbers[0],
          source: 'text',
          confidence: 'derived',
        },
        warnings,
      };
    } else if (textNumbers.length > 1) {
      if (!warnings.some((w) => w.startsWith('ambiguous'))) {
        warnings.push(
          `ambiguous: multiple PR numbers found in text (${textNumbers.join(', ')}); provide explicit subjectAnchor to select one`,
        );
      }
    }
  }

  // ── 5. Legacy context key mapping ──────────────────────────────────────────
  if (input.context) {
    const ctx = input.context;

    // CI retry fields take precedence over other context fields
    const ciPrNum = typeof ctx.ciRetryPrNumber === 'number' && ctx.ciRetryPrNumber > 0
      ? ctx.ciRetryPrNumber
      : undefined;
    const ciHeadSha = typeof ctx.ciRetryHeadSha === 'string'
      ? (normalizeHeadSha(ctx.ciRetryHeadSha) ?? undefined)
      : undefined;

    const legacyPrNum = typeof ctx.prNumber === 'number' && ctx.prNumber > 0
      ? ctx.prNumber
      : typeof ctx.pr === 'number' && (ctx.pr as number) > 0
      ? (ctx.pr as number)
      : undefined;

    const prNumber = ciPrNum ?? legacyPrNum;

    const rawHeadSha = typeof ctx.headSha === 'string' ? ctx.headSha : undefined;
    const headSha = ciHeadSha ?? (rawHeadSha ? (normalizeHeadSha(rawHeadSha) ?? undefined) : undefined);

    // errorSignature from frictionSignature
    const rawFriction = typeof ctx.frictionSignature === 'string' ? ctx.frictionSignature : undefined;
    const errorSignature = rawFriction ? (normalizeErrorSignature(rawFriction) ?? undefined) : undefined;
    if (rawFriction && !errorSignature) {
      // Free-form friction text — reject, no anchor
      return { anchor: null, warnings };
    }

    // branch from baseBranch or resumeBranch
    const rawBranch = typeof ctx.baseBranch === 'string'
      ? ctx.baseBranch
      : typeof ctx.resumeBranch === 'string'
      ? ctx.resumeBranch
      : undefined;
    const branch = rawBranch ? (normalizeBranch(rawBranch) ?? undefined) : undefined;

    const subjectMissionId = typeof ctx.subjectMissionId === 'string' ? ctx.subjectMissionId : undefined;

    const kind = resolveKind(prNumber, errorSignature, subjectMissionId, branch);
    if (kind !== null) {
      return {
        anchor: {
          version: 1,
          kind,
          ...(prNumber !== undefined && { prNumber }),
          ...(headSha !== undefined && { headSha }),
          ...(branch !== undefined && { branch }),
          ...(errorSignature !== undefined && { errorSignature }),
          ...(subjectMissionId !== undefined && { subjectMissionId }),
          source: 'context',
          confidence: 'exact',
        },
        warnings,
      };
    }
  }

  // ── 6. No anchor ─────────────────────────────────────────────────────────────
  return { anchor: null, warnings };
}
