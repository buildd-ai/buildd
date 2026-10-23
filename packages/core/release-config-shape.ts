// The pure shape of `releaseConfig`'s release-PR declarations: candidate branch
// patterns, the candidate policy, config-write validation, and the refs-only
// "is this head/base a release PR" test. No provenance, no I/O.
//
// Split out of release-candidate.ts so core callers (the workspace config write
// path, base-advance notices) can validate and read the config without
// importing the releases module; scripts/module-boundaries.ts lists this file
// as core. Provenance (`classifyReleasePr`) stays in release-candidate.ts,
// which re-exports everything here.

import type { ReleaseCandidateAmendContract, WorkspaceReleaseConfig } from './db/schema';

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
  return amendContractShapeError(config);
}

// ── Amend contract ──────────────────────────────────────────────────────────
//
// Where it lives: the declaration (which inputs mean "amend") is workspace
// config, next to the trust policy above, because a repo-editable file would
// let any PR author change what buildd dispatches. Whether the workflow CAN
// take those inputs is a fact about the workflow file, so it is read from the
// file at `ref` (lib/workflow-dispatch-inputs.ts) on save and again before
// every dispatch; the config cannot silently drift from the code.

const INPUT_NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/** The reason a `candidate.amend` declaration is refused on its own shape, or null. */
export function amendContractShapeError(config: WorkspaceReleaseConfig): string | null {
  const a = config.candidate?.amend as Partial<ReleaseCandidateAmendContract> & Record<string, unknown> | undefined;
  if (a === undefined) return null;
  if (!a || typeof a !== 'object') return 'candidate.amend must be { mode: "inputs", versionInput, confirmInput? } or { mode: "redispatch" }';
  if (config.strategy !== 'workflow_dispatch') return 'candidate.amend needs strategy workflow_dispatch: buildd amends a candidate only by dispatching your release workflow';
  if (a.mode === 'redispatch') return null;
  if (a.mode !== 'inputs') return 'candidate.amend.mode must be "inputs" or "redispatch"';
  if (typeof a.versionInput !== 'string' || !INPUT_NAME.test(a.versionInput)) return 'candidate.amend.versionInput must name a workflow_dispatch input, e.g. amend';
  if (a.confirmInput !== undefined && (typeof a.confirmInput !== 'string' || !INPUT_NAME.test(a.confirmInput))) {
    return 'candidate.amend.confirmInput must name a workflow_dispatch input, e.g. amend_confirm';
  }
  if (a.confirmInput === a.versionInput) return 'candidate.amend.confirmInput must differ from versionInput';
  return null;
}

/** The workflow_dispatch input names a contract needs the workflow to declare. */
export function amendContractInputs(contract: ReleaseCandidateAmendContract): string[] {
  if (contract.mode === 'redispatch') return [];
  return contract.confirmInput ? [contract.versionInput, contract.confirmInput] : [contract.versionInput];
}

/**
 * Why the workflow file cannot carry out this contract, or null when it can.
 * `declared` is the file's `on.workflow_dispatch.inputs` names, or null when
 * the file has no workflow_dispatch trigger at all. `where` names the file and
 * ref for the message.
 */
export function amendContractCapabilityError(
  contract: ReleaseCandidateAmendContract,
  declared: string[] | null,
  where: string,
): string | null {
  if (declared === null) return `${where} has no workflow_dispatch trigger, so buildd cannot dispatch it`;
  const missing = amendContractInputs(contract).filter((i) => !declared.includes(i));
  if (missing.length === 0) return null;
  return `${where} does not declare workflow_dispatch input${missing.length > 1 ? 's' : ''} ${missing.map((m) => `\`${m}\``).join(', ')}` +
    (declared.length ? ` (it declares ${declared.map((d) => `\`${d}\``).join(', ')})` : ' (it declares none)');
}

/** The inputs an amendment dispatch sends: the workflow's ordinary inputs plus the contract's version inputs. */
export function amendDispatchInputs(
  contract: ReleaseCandidateAmendContract,
  version: string,
  base: Record<string, string>,
): Record<string, string> {
  const out = { ...base };
  for (const name of amendContractInputs(contract)) out[name] = version;
  return out;
}

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
