/**
 * The bound on an unattended merge driven by a *model* verdict.
 *
 * A reviewer agent's `approve` can drive auto-merge, but the trade only holds
 * because of where the merge lands. Under the mission integration model a task
 * PR targets `mission/<slug>`, an approved merge lands in a quarantined branch,
 * and the human gate sits once at the integration → trunk PR. An injected or
 * manipulated `approve` therefore costs a bad commit on a branch that is itself
 * reviewed before anything reaches the trunk.
 *
 * That argument evaporates the moment the base ref *is* the trunk. So the
 * permission keys off the PR's actual base ref — never a workspace-level flag —
 * and a workspace that still merges task PRs straight into `dev` cannot inherit
 * unattended merges by accident.
 *
 * Everything here is a pure function of server-read GitHub state (base ref,
 * check runs, file list). Nothing in it reads model-reported text such as
 * `escalationReason`, which is attacker-influenced.
 */

import { isSchemaTouchingFile } from './migration-safety';

export const MISSION_BRANCH_PREFIX = 'mission/';

/**
 * Check-run name tokens that identify the repo's build/test workflow.
 *
 * GitHub names an Actions check run after the *job*, not the workflow, so this
 * matches on substrings ('build', 'test', 'typecheck') exactly as the
 * CI-completeness warning in `evaluateAutoMergeSafety` already does.
 */
export const BUILD_PROOF_CHECK_TOKENS = ['typecheck', 'build', 'test'] as const;

export type BoundVerdict = { permitted: true } | { permitted: false; reason: string };

export interface CheckRunState {
  name: string;
  status: string;
  conclusion: string | null;
}

/**
 * True for a mission integration branch — the only base a model verdict may
 * merge into unattended.
 *
 * Deliberately a prefix test on the whole ref: `feat/mission/x` is somebody's
 * feature branch, `missionary/x` is not a mission branch, and a bare
 * `mission/` is not a branch at all.
 */
export function isMissionIntegrationBranch(ref: string | null | undefined): boolean {
  if (typeof ref !== 'string') return false;
  if (!ref.startsWith(MISSION_BRANCH_PREFIX)) return false;
  return ref.length > MISSION_BRANCH_PREFIX.length;
}

/**
 * The branches a model verdict may never merge into: the workspace's own trunk
 * (`gitConfig.targetBranch` / `defaultBranch` — `dev` here), its production
 * branch (`releaseConfig.prodBranch`), and `main` unconditionally.
 *
 * `main` is included even when unconfigured: a workspace that has not filled in
 * a release config must not become the one where an unattended merge reaches
 * production. A release PR is exactly a PR whose base is `main`/`prodBranch`,
 * so this list is also what makes release PRs unmergeable on a model verdict.
 */
export function protectedBaseBranches(input: {
  gitConfig?: { targetBranch?: string | null; defaultBranch?: string | null } | null;
  releaseConfig?: { prodBranch?: string | null } | null;
}): string[] {
  const names = [
    'main',
    input.gitConfig?.targetBranch,
    input.gitConfig?.defaultBranch,
    input.releaseConfig?.prodBranch,
  ].filter((b): b is string => typeof b === 'string' && b.length > 0);
  return [...new Set(names)];
}

/**
 * Require positive proof that the build/test workflow ran AND succeeded for
 * this head SHA.
 *
 * "Checks are not failing" is not "checks passed". `.github/workflows/build.yml`
 * filters `pull_request` by base branch, so a PR based on an unlisted branch
 * gets no run at all — and a zero-run PR is indistinguishable from a green one
 * to any predicate that only looks for failures. A skipped or neutral
 * conclusion is likewise not a pass.
 */
export function hasBuildProof(checkRuns: CheckRunState[]): BoundVerdict {
  const named = checkRuns.filter((run) =>
    BUILD_PROOF_CHECK_TOKENS.some((token) => run.name.toLowerCase().includes(token)),
  );
  if (named.length === 0) {
    return {
      permitted: false,
      reason:
        'no build/test check reported for this head SHA — a PR with zero runs is not a green PR '
        + `(saw: ${checkRuns.map((r) => r.name).join(', ') || 'nothing'})`,
    };
  }
  const passed = named.some((run) => run.status === 'completed' && run.conclusion === 'success');
  if (!passed) {
    return {
      permitted: false,
      reason:
        'no build/test check reached a successful conclusion: '
        + named.map((r) => `${r.name}=${r.conclusion ?? r.status}`).join(', '),
    };
  }
  return { permitted: true };
}

export interface ModelApproveBoundInput {
  /** `pull_request.base.ref` as read from GitHub. Never taken from the model. */
  baseRef: string | null | undefined;
  /** From `protectedBaseBranches` for the PR's workspace. */
  protectedBranches: string[];
  /** Check runs GitHub reports for the PR's head SHA. */
  checkRuns: CheckRunState[];
  /** The PR's file list, as read from GitHub. */
  files: Array<{ filename: string }>;
}

/**
 * Decide whether a model `approve` may merge this PR unattended.
 *
 * Refusal is not a rejection of the PR — the caller leaves it for a human,
 * which is what `escalate` would have produced anyway.
 */
export function evaluateModelApproveBound(input: ModelApproveBoundInput): BoundVerdict {
  // 1. File-list gates first: these hold regardless of verdict or base, and are
  //    read from GitHub's file list rather than anything the model reported.
  const schemaHit = input.files.find((file) => isSchemaTouchingFile(file.filename));
  if (schemaHit) {
    return {
      permitted: false,
      reason: `model approve cannot merge a schema change unattended (${schemaHit.filename}) — human merge required`,
    };
  }

  // 2. Unknown base ref ⇒ fail closed. We cannot bound what we cannot read.
  const baseRef = input.baseRef;
  if (typeof baseRef !== 'string' || baseRef.length === 0) {
    return {
      permitted: false,
      reason: 'model approve: PR base ref is unknown — refusing an unattended merge',
    };
  }

  // 3. Explicit trunk deny list, checked BEFORE the positive mission test so a
  //    workspace whose trunk happens to match the naming convention cannot
  //    inherit unattended merges from it.
  if (input.protectedBranches.includes(baseRef)) {
    return {
      permitted: false,
      reason: `model approve: base '${baseRef}' is a protected trunk branch — human merge required`,
    };
  }

  // 4. Positive test: only a quarantined mission integration branch qualifies.
  if (!isMissionIntegrationBranch(baseRef)) {
    return {
      permitted: false,
      reason:
        `model approve: base '${baseRef}' is not a mission integration branch `
        + `(${MISSION_BRANCH_PREFIX}**) — human merge required`,
    };
  }

  // 5. CI must have actually run and passed on this head SHA.
  return hasBuildProof(input.checkRuns);
}

/** Passed to `evaluateAutoMergeSafety` when a model verdict is driving the merge. */
export interface ModelApproveBound {
  protectedBranches: string[];
}
