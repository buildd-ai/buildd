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
import {
  isLegacyReleasePr,
  matchesCandidatePattern,
  releaseCandidatePolicy,
} from './release-config-shape';

export {
  candidatePatternError,
  hasReleasePrShape,
  isLegacyReleasePr,
  matchesCandidatePattern,
  releaseCandidateConfigError,
  releaseCandidatePolicy,
  type ReleaseCandidatePolicy,
} from './release-config-shape';

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
