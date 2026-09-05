/**
 * The bound on an unattended merge driven by a *model* verdict.
 *
 * A reviewer agent's `approve` can drive auto-merge, but the trade only holds
 * because of where the merge lands. Under the mission integration model a task
 * PR targets the mission's integration branch, an approved merge lands in a
 * quarantined branch, and the human gate sits once at the integration → trunk
 * PR. An injected or manipulated `approve` therefore costs a bad commit on a
 * branch that is itself reviewed before anything reaches the trunk.
 *
 * That argument evaporates the moment the base ref *is* the trunk. So the
 * permission keys off the PR's actual base ref — never a workspace-level flag —
 * and a workspace that still merges task PRs straight into its trunk cannot
 * inherit unattended merges by accident.
 *
 * The base-ref test itself is `isMissionIntegrationBase` from `core`: it
 * compares the ref against the mission's own `workingBranch` rather than
 * pattern-matching a name. A shape heuristic is the wrong instrument for a
 * permission — a workspace is free to carry a `mission/…` branch that no
 * mission owns, and a false positive here is exactly the direction that removes
 * a human gate.
 *
 * Everything here is a pure function of server-read GitHub state (base ref,
 * check runs) plus the mission row. Nothing in it reads model-reported text
 * such as `escalationReason`, which is attacker-influenced.
 */

import { isMissionIntegrationBase, type MissionIntegrationFields } from '@buildd/core/mission-integration';

/**
 * Check-run name tokens that identify the repo's build/test workflow.
 *
 * GitHub names an Actions check run after the *job*, not the workflow, so this
 * matches on substrings ('build', 'test', 'typecheck'). Exported and consumed
 * by the CI-completeness warning in `evaluateAutoMergeSafety` too, so the
 * warning and the hard refusal can never drift apart on which checks count.
 */
export const BUILD_PROOF_CHECK_TOKENS = ['typecheck', 'build', 'test'] as const;

export type BoundVerdict = { permitted: true } | { permitted: false; reason: string };

export interface CheckRunState {
  name: string;
  status: string;
  conclusion: string | null;
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
 *
 * Not redundant with the positive mission test below, because the mission row
 * is data an agent can write: a mission whose `workingBranch` had been set to
 * the workspace trunk would otherwise satisfy `isMissionIntegrationBase` for a
 * PR based on trunk. This list is checked first so it cannot.
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
 * "Checks are not failing" is not "checks passed", and that is the gap this
 * closes: `evaluateAutoMergeSafety` rejects pending and failed check runs, but
 * when the expected checks are *absent* it only warns — so a PR with zero runs
 * is indistinguishable from a green one. `.github/workflows/build.yml` filters
 * `pull_request` by base branch, which is exactly how a PR ends up with no run
 * at all. A skipped or neutral conclusion is likewise not a pass.
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
  /**
   * `pull_request.base.ref` as read from GitHub. Never taken from the model.
   *
   * The BASE ref, because the PR being gated here is a *task* PR: task branch →
   * integration branch. (The size-gate exemption in `evaluateAutoMergeSafety`
   * asks the same question of the mission PR, whose integration branch is its
   * HEAD ref because its base is trunk.)
   */
  baseRef: string | null | undefined;
  /** The mission row that says which branch is its integration branch. */
  mission: MissionIntegrationFields | null | undefined;
  /** From `protectedBaseBranches` for the PR's workspace. */
  protectedBranches: string[];
  /** Check runs GitHub reports for the PR's head SHA. */
  checkRuns: CheckRunState[];
}

/**
 * Decide whether a model `approve` may merge this PR unattended.
 *
 * Refusal is not a rejection of the PR — the caller leaves it for a human,
 * which is what `escalate` would have produced anyway.
 *
 * Schema and migration files are deliberately NOT re-gated here. That gate is
 * already enforced on this exact path, twice: `enforceServerSideEscalation`
 * rewrites a model `approve` to `escalate` at verdict time from the PR's
 * current file list, and `evaluateAutoMergeSafety` runs the migration
 * operation-class inspector before it reaches this function. A third copy would
 * only differ by overriding the inspector's deliberate EXPAND-passes rule,
 * which is a separate policy decision and not this bound's job.
 */
export function evaluateModelApproveBound(input: ModelApproveBoundInput): BoundVerdict {
  // 1. Unknown base ref ⇒ fail closed. We cannot bound what we cannot read.
  const baseRef = input.baseRef;
  if (typeof baseRef !== 'string' || baseRef.length === 0) {
    return {
      permitted: false,
      reason: 'model approve: PR base ref is unknown — refusing an unattended merge',
    };
  }

  // 2. Explicit trunk deny list, checked BEFORE the positive mission test so a
  //    mission whose working branch had been pointed at the trunk cannot make
  //    the trunk look quarantined.
  if (input.protectedBranches.includes(baseRef)) {
    return {
      permitted: false,
      reason: `model approve: base '${baseRef}' is a protected trunk branch — human merge required`,
    };
  }

  // 3. Positive test: only the mission's own integration branch qualifies.
  //    Authoritative (mission row), not a `mission/` name-shape heuristic — a
  //    mission that has not opted in, or a ref that is not its working branch,
  //    is false and therefore refused.
  if (!isMissionIntegrationBase({ baseRef, mission: input.mission })) {
    return {
      permitted: false,
      reason:
        `model approve: base '${baseRef}' is not this mission's integration branch `
        + '— human merge required',
    };
  }

  // 4. CI must have actually run and passed on this head SHA.
  return hasBuildProof(input.checkRuns);
}

/** Passed in `evaluateAutoMergeSafety`'s opts when a model verdict is driving the merge. */
export interface ModelApproveBound {
  protectedBranches: string[];
}
