// Which PRs into the production branch are this workspace's release PRs.
//
// Two shapes, both declared in `releaseConfig`, never guessed from a title:
//
//   - legacy: the fixed `releaseBranch → prodBranch` PR (e.g. dev → main), the
//     shape `isReleaseBranchPr` has always recognised;
//   - frozen candidate: a versioned branch (e.g. `release/v1.2.3`) cut from one
//     captured `sourceBranch` SHA by the repo's own release workflow, opened as
//     the single PR into `prodBranch`. Declared by `releaseConfig.candidate`.
//
// A candidate is a claim about provenance ("the release workflow cut this from
// dev@X"), so a matching branch name is not enough: anyone with push access can
// create `release/v9.9.9`. A PR counts as a candidate only when ALL hold:
//   - base is `prodBranch`, head matches one of `candidate.branches`;
//   - head lives in the base repo (not a fork);
//   - the PR author is one of `candidate.authors` (the release workflow's
//     identity — an author cannot be edited after the fact, a body can);
//   - the body carries the workflow's `<!-- release-candidate {...} -->`
//     metadata, naming this exact branch, base and source;
//   - the metadata's `candidateSha` is the PR's current head. A push onto the
//     branch that did not go through the workflow's explicit amendment (which
//     rewrites the metadata) leaves the two different, and the PR stops being
//     a candidate until someone amends it properly.
//
// What being a release PR grants is narrow, and is decided by each caller:
// composition review (each commit must still prove it is a reviewed change;
// review-composition.ts), the aggregate size-gate exemption (auto-merge.ts) and
// release tracking. It never skips CI, branch protection, path escalation or
// the migration inspector. Failing every check here just means "ordinary PR".
//
// The metadata format is owned by scripts/release-candidate.ts (sibling engine);
// `parseReleaseCandidateMeta` reads the same marker and is pinned to its
// renderer by packages/core/__tests__/release-candidate.test.ts.

import type { WorkspaceReleaseConfig } from './db/schema';

export interface ReleaseCandidateMeta {
  schema: 1;
  version: string;
  branch: string;
  sourceRef: string;
  sourceSha: string;
  candidateSha: string;
  baseRef: string;
  baseSha: string;
  previousTag: string | null;
  amendment: number;
  previousCandidateSha: string | null;
  supersedes: number | null;
  cutAt: string;
}

const META_RE = /<!-- release-candidate (\{[\s\S]*?\}) -->/;

/** The release workflow's candidate metadata from a PR body; null when absent or malformed. */
export function parseReleaseCandidateMeta(body: string | null | undefined): ReleaseCandidateMeta | null {
  const m = META_RE.exec(body ?? '');
  if (!m) return null;
  try {
    const meta = JSON.parse(m[1]) as Partial<ReleaseCandidateMeta> | null;
    if (!meta || meta.schema !== 1) return null;
    for (const k of ['version', 'branch', 'sourceRef', 'sourceSha', 'candidateSha', 'baseRef'] as const) {
      if (typeof meta[k] !== 'string' || !meta[k]) return null;
    }
    return meta as ReleaseCandidateMeta;
  } catch {
    return null;
  }
}

// ── Branch patterns ─────────────────────────────────────────────────────────

const PATTERN_CHARS = /^[A-Za-z0-9._\/-]+\*?$/;

/**
 * Why a candidate branch pattern is refused, or null when it is usable. A
 * pattern is an exact ref or a literal prefix ending in one `*`. The prefix is
 * required and must contain a `/` or be the whole ref, so `*`, `r*` or `release*`
 * (which would match `release-notes`) cannot turn ordinary branches into
 * release candidates.
 */
export function candidatePatternError(pattern: string): string | null {
  const p = pattern.trim();
  if (!p) return 'empty pattern';
  if (!PATTERN_CHARS.test(p)) return `"${p}": use an exact branch or a prefix ending in one *, e.g. release/v*`;
  if (p.endsWith('*') && !p.slice(0, -1).includes('/')) return `"${p}": a wildcard pattern needs a path prefix such as release/`;
  return null;
}

export function matchesCandidatePattern(pattern: string, ref: string): boolean {
  const p = pattern.trim();
  const r = ref.trim();
  if (!r || candidatePatternError(p)) return false;
  if (!p.endsWith('*')) return r === p;
  const prefix = p.slice(0, -1);
  return r.length > prefix.length && r.startsWith(prefix) && /^[A-Za-z0-9._\/-]+$/.test(r);
}

// ── Policy ──────────────────────────────────────────────────────────────────

export interface ReleaseCandidatePolicy {
  prodBranch: string;
  sourceBranch: string;
  branches: string[];
  /** Lower-cased GitHub logins. */
  authors: string[];
}

/**
 * The workspace's candidate policy, or null when it does not use candidates
 * (disabled, unconfigured, or configured unsafely). Every field is required:
 * there is no default branch pattern, source branch or author.
 */
export function releaseCandidatePolicy(config: WorkspaceReleaseConfig | null | undefined): ReleaseCandidatePolicy | null {
  if (!config?.enabled) return null;
  const c = config.candidate;
  const prodBranch = config.prodBranch?.trim();
  const sourceBranch = c?.sourceBranch?.trim();
  if (!c || !prodBranch || !sourceBranch || sourceBranch === prodBranch) return null;
  const branches = (c.branches ?? []).map((b) => b.trim()).filter(Boolean);
  const authors = (c.authors ?? []).map((a) => a.trim().toLowerCase()).filter(Boolean);
  if (branches.length === 0 || authors.length === 0) return null;
  if (branches.some((b) => candidatePatternError(b))) return null;
  // A pattern that matches the trunk or the prod branch would make every PR out of either a "candidate".
  if (branches.some((b) => matchesCandidatePattern(b, prodBranch) || matchesCandidatePattern(b, sourceBranch))) return null;
  return { prodBranch, sourceBranch, branches, authors };
}

/** Validation for the config write paths: the reason a `candidate` block is refused, or null. */
export function releaseCandidateConfigError(config: WorkspaceReleaseConfig): string | null {
  const c = config.candidate;
  if (!c) return null;
  const prod = config.prodBranch?.trim();
  const source = c.sourceBranch?.trim();
  if (!prod) return 'candidate: prodBranch is required';
  if (!source) return 'candidate.sourceBranch is required (the branch candidates are cut from, e.g. dev)';
  if (source === prod) return 'candidate.sourceBranch must differ from prodBranch';
  if (!c.branches?.length) return 'candidate.branches needs at least one pattern, e.g. release/v*';
  for (const b of c.branches) {
    const err = candidatePatternError(b);
    if (err) return `candidate.branches: ${err}`;
    if (matchesCandidatePattern(b, prod) || matchesCandidatePattern(b, source)) {
      return `candidate.branches: "${b}" matches ${prod} or ${source}`;
    }
  }
  if (!c.authors?.some((a) => a.trim())) return 'candidate.authors needs the GitHub login that opens candidate PRs, e.g. github-actions[bot]';
  return null;
}

// ── Classification ──────────────────────────────────────────────────────────

export interface ReleasePrFacts {
  headRef?: string | null;
  baseRef?: string | null;
  headSha?: string | null;
  /** The PR author's login (`pull.user.login`). */
  author?: string | null;
  headRepoFullName?: string | null;
  baseRepoFullName?: string | null;
  body?: string | null;
}

export type ReleasePrClass =
  | { kind: 'legacy'; headRef: string; baseRef: string }
  | { kind: 'candidate'; headRef: string; baseRef: string; sourceBranch: string; version: string; meta: ReleaseCandidateMeta }
  | { kind: 'none'; reason: ReleasePrRejection };

export type ReleasePrRejection =
  | 'not_release_shape'
  | 'cross_repository'
  | 'author_not_trusted'
  | 'metadata_missing'
  | 'metadata_mismatch'
  | 'candidate_sha_moved';

/** Legacy fixed-branch release PR (releaseBranch → prodBranch). Refs only. */
export function isLegacyReleasePr(
  config: WorkspaceReleaseConfig | null | undefined,
  refs: { headRef?: string | null; baseRef?: string | null },
): boolean {
  if (!config?.enabled) return false;
  const releaseBranch = config.releaseBranch?.trim();
  const prodBranch = config.prodBranch?.trim();
  if (!releaseBranch || !prodBranch) return false;
  return refs.headRef?.trim() === releaseBranch && refs.baseRef?.trim() === prodBranch;
}

/**
 * Refs only: does this head/base pair have the shape of a release PR (legacy,
 * or a candidate branch into prodBranch)? NOT proof of provenance. Use it only
 * where a false positive is harmless (suppressing a notice, narrowing which
 * merged PRs a reconciler looks at) — anything that relaxes a gate must use
 * `classifyReleasePr`.
 */
export function hasReleasePrShape(
  config: WorkspaceReleaseConfig | null | undefined,
  refs: { headRef?: string | null; baseRef?: string | null },
): boolean {
  if (isLegacyReleasePr(config, refs)) return true;
  const policy = releaseCandidatePolicy(config);
  if (!policy || refs.baseRef?.trim() !== policy.prodBranch) return false;
  const head = refs.headRef?.trim() ?? '';
  return policy.branches.some((b) => matchesCandidatePattern(b, head));
}

export function classifyReleasePr(config: WorkspaceReleaseConfig | null | undefined, pr: ReleasePrFacts): ReleasePrClass {
  const headRef = pr.headRef?.trim() ?? '';
  const baseRef = pr.baseRef?.trim() ?? '';
  if (isLegacyReleasePr(config, { headRef, baseRef })) return { kind: 'legacy', headRef, baseRef };

  const policy = releaseCandidatePolicy(config);
  if (!policy || baseRef !== policy.prodBranch || !policy.branches.some((b) => matchesCandidatePattern(b, headRef))) {
    return { kind: 'none', reason: 'not_release_shape' };
  }
  const headRepo = pr.headRepoFullName?.trim().toLowerCase();
  const baseRepo = pr.baseRepoFullName?.trim().toLowerCase();
  if (!headRepo || !baseRepo || headRepo !== baseRepo) return { kind: 'none', reason: 'cross_repository' };
  const author = pr.author?.trim().toLowerCase();
  if (!author || !policy.authors.includes(author)) return { kind: 'none', reason: 'author_not_trusted' };
  const meta = parseReleaseCandidateMeta(pr.body);
  if (!meta) return { kind: 'none', reason: 'metadata_missing' };
  if (meta.branch !== headRef || meta.baseRef !== policy.prodBranch || meta.sourceRef !== policy.sourceBranch) {
    return { kind: 'none', reason: 'metadata_mismatch' };
  }
  if (!pr.headSha || meta.candidateSha !== pr.headSha) return { kind: 'none', reason: 'candidate_sha_moved' };
  return { kind: 'candidate', headRef, baseRef, sourceBranch: policy.sourceBranch, version: meta.version.replace(/^v/, ''), meta };
}

/**
 * Where a release PR's constituent PRs merged: the legacy release branch itself
 * (dev → main is built from PRs into dev), or a candidate's source branch (a
 * `release/v1.2.3` branch is built from PRs into dev, never into itself).
 */
export function releaseConstituentBase(cls: ReleasePrClass): string | null {
  if (cls.kind === 'legacy') return cls.headRef;
  if (cls.kind === 'candidate') return cls.sourceBranch;
  return null;
}
