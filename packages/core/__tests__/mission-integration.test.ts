import { describe, it, expect } from 'bun:test';
import {
  MISSION_BRANCH_PREFIX,
  isMissionIntegrationBase,
  isPrLegalForMissionTask,
  isStackedPhaseBase,
  looksLikeMissionIntegrationBranch,
  isMissionPrTask,
  MISSION_PR_TASK_PREFIX,
  resolveTaskPrBase,
  missionIntegrationBase,
} from '../mission-integration';

/**
 * Option A′ turns on exactly one question: is a given PR base the mission's
 * integration branch? Getting that answer wrong in the permissive direction
 * silently deletes a human review gate, so every test here that asserts
 * `false` / `null` is guarding the safety edge, not padding coverage.
 */

const OPTED_IN = { workingBranch: 'mission/checkout-arc-1a2b3c4d', integrationBranchEnabled: true };

describe('missionIntegrationBase', () => {
  it('returns the working branch for an opted-in mission', () => {
    expect(missionIntegrationBase(OPTED_IN)).toBe('mission/checkout-arc-1a2b3c4d');
  });

  it('returns null when the mission has not opted in', () => {
    expect(
      missionIntegrationBase({ ...OPTED_IN, integrationBranchEnabled: false }),
    ).toBeNull();
  });

  it('returns null when the flag is absent entirely', () => {
    // Callers that select a partial column set must not accidentally opt a
    // mission in by omitting the field.
    expect(missionIntegrationBase({ workingBranch: 'mission/x-1a2b3c4d' })).toBeNull();
  });

  it('returns null for a null/undefined mission', () => {
    expect(missionIntegrationBase(null)).toBeNull();
    expect(missionIntegrationBase(undefined)).toBeNull();
  });

  it('treats a missing or blank working branch as no base', () => {
    expect(missionIntegrationBase({ workingBranch: null, integrationBranchEnabled: true })).toBeNull();
    expect(missionIntegrationBase({ workingBranch: '   ', integrationBranchEnabled: true })).toBeNull();
  });

  it('trims surrounding whitespace off the branch name', () => {
    expect(
      missionIntegrationBase({ workingBranch: '  mission/x-1a2b3c4d  ', integrationBranchEnabled: true }),
    ).toBe('mission/x-1a2b3c4d');
  });
});

describe('isMissionIntegrationBase', () => {
  it('is true when the base ref is the mission integration branch', () => {
    expect(isMissionIntegrationBase({ baseRef: 'mission/checkout-arc-1a2b3c4d', mission: OPTED_IN })).toBe(true);
  });

  it('is false for a trunk-targeted PR of the same mission', () => {
    // This is the mission PR itself, and it is the one that must keep the tier.
    expect(isMissionIntegrationBase({ baseRef: 'dev', mission: OPTED_IN })).toBe(false);
  });

  it('is false when the base ref is unknown', () => {
    // "We do not know where this PR is going" must never resolve to "it is
    // quarantined" — that is the direction that removes a review gate.
    expect(isMissionIntegrationBase({ baseRef: null, mission: OPTED_IN })).toBe(false);
    expect(isMissionIntegrationBase({ baseRef: undefined, mission: OPTED_IN })).toBe(false);
    expect(isMissionIntegrationBase({ baseRef: '', mission: OPTED_IN })).toBe(false);
  });

  it('is false when the mission has not opted in, even on a mission/* base', () => {
    expect(
      isMissionIntegrationBase({
        baseRef: 'mission/checkout-arc-1a2b3c4d',
        mission: { ...OPTED_IN, integrationBranchEnabled: false },
      }),
    ).toBe(false);
  });

  it('is false for another mission’s integration branch', () => {
    // Branch names are data. A PR based on a DIFFERENT mission's branch is not
    // quarantined by this mission's gate.
    expect(
      isMissionIntegrationBase({ baseRef: 'mission/other-thing-99887766', mission: OPTED_IN }),
    ).toBe(false);
  });

  it('is false with no mission row at all', () => {
    expect(isMissionIntegrationBase({ baseRef: 'mission/checkout-arc-1a2b3c4d' })).toBe(false);
  });

  it('tolerates whitespace on either side of the comparison', () => {
    expect(
      isMissionIntegrationBase({ baseRef: ' mission/checkout-arc-1a2b3c4d ', mission: OPTED_IN }),
    ).toBe(true);
  });
});

describe('looksLikeMissionIntegrationBranch', () => {
  it('matches the mission branch shape', () => {
    expect(looksLikeMissionIntegrationBranch('mission/checkout-arc-1a2b3c4d')).toBe(true);
  });

  it('does not match trunk or task branches', () => {
    expect(looksLikeMissionIntegrationBranch('dev')).toBe(false);
    expect(looksLikeMissionIntegrationBranch('main')).toBe(false);
    expect(looksLikeMissionIntegrationBranch('buildd/1a2b3c4d-add-endpoint')).toBe(false);
  });

  it('does not match a branch that merely contains the prefix', () => {
    expect(looksLikeMissionIntegrationBranch('feat/mission/nested')).toBe(false);
  });

  it('handles null and undefined', () => {
    expect(looksLikeMissionIntegrationBranch(null)).toBe(false);
    expect(looksLikeMissionIntegrationBranch(undefined)).toBe(false);
  });

  it('exports the prefix the shape check uses', () => {
    expect(MISSION_BRANCH_PREFIX).toBe('mission/');
  });
});

describe('isMissionPrTask', () => {
  it('is true for a bookkeeping task with the exact prefix', () => {
    expect(isMissionPrTask({ taskClass: 'bookkeeping', title: `${MISSION_PR_TASK_PREFIX}Checkout arc` })).toBe(true);
  });

  it('is false for a non-bookkeeping task, even with the prefix', () => {
    expect(isMissionPrTask({ taskClass: 'attempt', title: `${MISSION_PR_TASK_PREFIX}Checkout arc` })).toBe(false);
  });

  it('is false for a bookkeeping task without the prefix', () => {
    expect(isMissionPrTask({ taskClass: 'bookkeeping', title: 'Checkout arc' })).toBe(false);
  });

  it('recognizes the owner task under a builder retry prefix', () => {
    expect(
      isMissionPrTask({
        taskClass: 'bookkeeping',
        title: `[builder · after review #1] ${MISSION_PR_TASK_PREFIX}Checkout arc`,
      }),
    ).toBe(true);
  });

  it('recognizes the owner task under a reviewer-retry prefix', () => {
    expect(
      isMissionPrTask({
        taskClass: 'bookkeeping',
        title: `[reviewer #2] ${MISSION_PR_TASK_PREFIX}Checkout arc`,
      }),
    ).toBe(true);
  });

  it('is false for null/undefined title', () => {
    expect(isMissionPrTask({ taskClass: 'bookkeeping', title: null })).toBe(false);
    expect(isMissionPrTask({ taskClass: 'bookkeeping' })).toBe(false);
  });
});

describe('isPrLegalForMissionTask', () => {
  it('is legal when the base equals the integration branch', () => {
    expect(
      isPrLegalForMissionTask({ baseRef: 'mission/checkout-arc-1a2b3c4d', mission: OPTED_IN, isMissionPrTask: false }),
    ).toBe(true);
  });

  it('is illegal when a task PR bases on trunk instead of the integration branch', () => {
    expect(
      isPrLegalForMissionTask({ baseRef: 'dev', mission: OPTED_IN, isMissionPrTask: false }),
    ).toBe(false);
  });

  it('is illegal when the base is unknown', () => {
    expect(
      isPrLegalForMissionTask({ baseRef: null, mission: OPTED_IN, isMissionPrTask: false }),
    ).toBe(false);
  });

  it('exempts the mission PR itself, whose base is trunk by design', () => {
    expect(
      isPrLegalForMissionTask({ baseRef: 'dev', mission: OPTED_IN, isMissionPrTask: true }),
    ).toBe(true);
  });

  it('is legal for any base when the mission has no integration base', () => {
    expect(
      isPrLegalForMissionTask({ baseRef: 'dev', mission: null, isMissionPrTask: false }),
    ).toBe(true);
    expect(
      isPrLegalForMissionTask({ baseRef: null, mission: { ...OPTED_IN, integrationBranchEnabled: false }, isMissionPrTask: false }),
    ).toBe(true);
  });
});

describe('isStackedPhaseBase', () => {
  const HEAD = 'buildd/deadbeef-do-thing';
  const PREDECESSOR_ID = '9f8e7d6c-1111-2222-3333-444444444444';
  const PREDECESSOR = `buildd/${PREDECESSOR_ID.slice(0, 8)}-earlier-thing`;
  const DEPENDS_ON = [PREDECESSOR_ID];

  it('is true for a genuine predecessor branch declaration named in dependsOn', () => {
    expect(
      isStackedPhaseBase({ contextBaseBranch: PREDECESSOR, head: HEAD, mission: OPTED_IN, dependsOn: DEPENDS_ON }),
    ).toBe(true);
  });

  // ── early release's stacking mechanics reuse this unchanged ──────────────
  //
  // A `start_stacked` early-release decision (docs/design/early-release.md,
  // "Stacking mechanics") writes the upstream task's own branch name into the
  // dependent's `context.baseBranch` — the exact same shape a plan-step
  // predecessor declaration produces, because the dependent already names the
  // upstream in its own `dependsOn` (that's why a `dependency_releases` row
  // exists for the pair at all). No change to this predicate was needed for
  // early release; this test documents and guards that reuse.
  it('is true for an early-release start_stacked base (dependent already depends on the upstream)', () => {
    const upstreamId = 'ab12cd34-5555-6666-7777-888899990000';
    const upstreamBranch = `buildd/${upstreamId.slice(0, 8)}-upstream-thing`;
    expect(
      isStackedPhaseBase({
        contextBaseBranch: upstreamBranch,
        head: HEAD,
        mission: OPTED_IN,
        dependsOn: [upstreamId],
      }),
    ).toBe(true);
  });

  it('is false when context.baseBranch is unset', () => {
    expect(isStackedPhaseBase({ contextBaseBranch: undefined, head: HEAD, mission: OPTED_IN, dependsOn: DEPENDS_ON })).toBe(false);
    expect(isStackedPhaseBase({ contextBaseBranch: null, head: HEAD, mission: OPTED_IN, dependsOn: DEPENDS_ON })).toBe(false);
  });

  it('is false when context.baseBranch is the Option A′ default (equals the integration branch)', () => {
    expect(
      isStackedPhaseBase({ contextBaseBranch: OPTED_IN.workingBranch, head: HEAD, mission: OPTED_IN, dependsOn: DEPENDS_ON }),
    ).toBe(false);
  });

  it('is false when context.baseBranch is the recovery-task current-head marker', () => {
    expect(
      isStackedPhaseBase({ contextBaseBranch: HEAD, head: HEAD, mission: OPTED_IN, dependsOn: DEPENDS_ON }),
    ).toBe(false);
  });

  it('is false when the mission has no integration base — nothing to stack against', () => {
    expect(
      isStackedPhaseBase({ contextBaseBranch: PREDECESSOR, head: HEAD, mission: null, dependsOn: DEPENDS_ON }),
    ).toBe(false);
  });

  it('is false for a stray worker-scoped mission branch — not a genuine predecessor', () => {
    // The runner's checkout guard (PR #2521) diverts a worker onto
    // `mission/<slug>-w<workerId8>` instead of the shared integration branch.
    // If that value gets copied into context.baseBranch by a retry/resume
    // path, it must not be accepted as a stacked-phase predecessor — that was
    // the mechanism behind a PR landing on a dead branch and stranding
    // reviewed, CI-green commits.
    const strayWorkerBranch = 'mission/checkout-arc-w1a2b3c4';
    expect(
      isStackedPhaseBase({ contextBaseBranch: strayWorkerBranch, head: HEAD, mission: OPTED_IN, dependsOn: DEPENDS_ON }),
    ).toBe(false);
  });

  it('is false for another mission’s integration branch used as context.baseBranch', () => {
    expect(
      isStackedPhaseBase({
        contextBaseBranch: 'mission/other-thing-99887766',
        head: HEAD,
        mission: OPTED_IN,
        dependsOn: DEPENDS_ON,
      }),
    ).toBe(false);
  });

  // ── the tightening this file closes ───────────────────────────────────
  //
  // Before this, ANY non-empty context.baseBranch that wasn't the
  // integration branch or the task's own head was accepted as a stacked
  // declaration — with no check that it actually named a task this one
  // depends on. A baseBranch pointing at an unrelated branch (copied
  // forward by a retry/resume path, or simply stale) fell through
  // unenforced instead of being routed to the mission's integration branch.

  it('is false when no dependsOn is supplied at all', () => {
    expect(
      isStackedPhaseBase({ contextBaseBranch: PREDECESSOR, head: HEAD, mission: OPTED_IN }),
    ).toBe(false);
    expect(
      isStackedPhaseBase({ contextBaseBranch: PREDECESSOR, head: HEAD, mission: OPTED_IN, dependsOn: [] }),
    ).toBe(false);
  });

  it('is false for a baseBranch naming an unrelated branch with no dependsOn edge', () => {
    // Looks exactly like a real stacked predecessor branch, but this task
    // never declared a dependency on the task it names.
    const unrelatedId = 'aaaaaaaa-0000-0000-0000-000000000000';
    const unrelatedBranch = `buildd/${unrelatedId.slice(0, 8)}-some-other-task`;
    expect(
      isStackedPhaseBase({
        contextBaseBranch: unrelatedBranch,
        head: HEAD,
        mission: OPTED_IN,
        dependsOn: DEPENDS_ON, // names PREDECESSOR_ID, not unrelatedId
      }),
    ).toBe(false);
  });
});

// ── resolveTaskPrBase: the one answer both the prompt and the guard read ─────
//
// The divergence this closes was not a wrong predicate — it was TWO derivations.
// The runner's Git Workflow block said "PR to <trunk>" (it never looked at the
// mission) while create_pr derived the integration branch and refused trunk, so
// the worker was instructed to do the exact thing the server would not accept.
// Every assertion below is therefore about agreement, not just correctness.

describe('resolveTaskPrBase', () => {
  const TRUNK_FALLBACKS = ['dev', 'main'];

  it('is the mission integration branch for an ordinary mission task', () => {
    const got = resolveTaskPrBase({
      mission: OPTED_IN,
      task: { title: 'Do the thing', taskClass: 'work' },
      head: 'buildd/abc12345-do-the-thing',
      fallbacks: TRUNK_FALLBACKS,
    });
    expect(got).toEqual({
      base: OPTED_IN.workingBranch,
      source: 'mission_integration',
      integrationBase: OPTED_IN.workingBranch,
      enforced: true,
    });
  });

  it('outranks a caller-supplied base — derive, do not accept', () => {
    const got = resolveTaskPrBase({
      mission: OPTED_IN,
      task: { title: 'Do the thing', taskClass: 'work' },
      head: 'buildd/abc12345-do-the-thing',
      callerBase: 'dev',
      fallbacks: TRUNK_FALLBACKS,
    });
    expect(got.base).toBe(OPTED_IN.workingBranch);
    expect(got.enforced).toBe(true);
  });

  it('exempts the mission PR owner — its base is trunk by design', () => {
    const got = resolveTaskPrBase({
      mission: OPTED_IN,
      task: { title: `${MISSION_PR_TASK_PREFIX}Checkout arc`, taskClass: 'bookkeeping' },
      head: OPTED_IN.workingBranch,
      fallbacks: TRUNK_FALLBACKS,
    });
    expect(got).toEqual({
      base: 'dev',
      source: 'workspace',
      integrationBase: OPTED_IN.workingBranch,
      enforced: false,
    });
  });

  it('falls back to the integration branch when a stacked phase base is gone', () => {
    const got = resolveTaskPrBase({
      mission: OPTED_IN,
      task: {
        title: 'Phase 2',
        taskClass: 'work',
        context: { baseBranch: 'buildd/99999999-phase-1' },
      },
      head: 'buildd/abc12345-phase-2',
      fallbacks: TRUNK_FALLBACKS,
      stackedBaseMissing: true,
    });
    expect(got.base).toBe(OPTED_IN.workingBranch);
    expect(got.source).toBe('mission_integration');
    expect(got.enforced).toBe(true);
  });

  it('exempts a stacked plan phase — its base is the predecessor branch', () => {
    const got = resolveTaskPrBase({
      mission: OPTED_IN,
      task: {
        title: 'Phase 2',
        taskClass: 'work',
        context: { baseBranch: 'buildd/99999999-phase-1' },
        dependsOn: ['99999999-0000-0000-0000-000000000000'],
      },
      head: 'buildd/abc12345-phase-2',
      fallbacks: TRUNK_FALLBACKS,
    });
    expect(got.base).toBe('buildd/99999999-phase-1');
    expect(got.source).toBe('stacked_phase');
    expect(got.enforced).toBe(false);
  });

  it('does not exempt a baseBranch that looks like a stacked phase but names no dependsOn edge', () => {
    // The tightening this file closes: an unverified baseBranch must fall
    // through to the mission's real integration branch, enforced — not be
    // handed back as an unenforced "stacked phase".
    const got = resolveTaskPrBase({
      mission: OPTED_IN,
      task: {
        title: 'Phase 2',
        taskClass: 'work',
        context: { baseBranch: 'buildd/99999999-phase-1' },
        // No dependsOn at all — the declaration this task's own schema
        // allows (planning.ts: baseBranch and dependsOn are "usually", not
        // always, paired) was never made.
      },
      head: 'buildd/abc12345-phase-2',
      fallbacks: TRUNK_FALLBACKS,
    });
    expect(got).toEqual({
      base: OPTED_IN.workingBranch,
      source: 'mission_integration',
      integrationBase: OPTED_IN.workingBranch,
      enforced: true,
    });
  });

  it('falls back to trunk for a task with no mission', () => {
    const got = resolveTaskPrBase({
      mission: null,
      task: { title: 'Do the thing', taskClass: 'work' },
      head: 'buildd/abc12345-do-the-thing',
      fallbacks: TRUNK_FALLBACKS,
    });
    expect(got).toEqual({
      base: 'dev',
      source: 'workspace',
      integrationBase: null,
      enforced: false,
    });
  });

  it('honours a caller base when there is no mission integration branch', () => {
    const got = resolveTaskPrBase({
      mission: null,
      task: { title: 'Hotfix', taskClass: 'work' },
      head: 'buildd/abc12345-hotfix',
      callerBase: 'main',
      fallbacks: TRUNK_FALLBACKS,
    });
    expect(got.base).toBe('main');
    expect(got.source).toBe('caller');
  });

  it('ignores a context.baseBranch that is the recovery-task current-head marker', () => {
    const got = resolveTaskPrBase({
      mission: null,
      task: { title: 'Recovery', taskClass: 'work', context: { baseBranch: 'buildd/abc12345-x' } },
      head: 'buildd/abc12345-x',
      fallbacks: TRUNK_FALLBACKS,
    });
    expect(got.base).toBe('dev');
    expect(got.source).toBe('workspace');
  });

  it('re-enforces the integration branch when context.baseBranch is a stray worker-scoped branch', () => {
    // Regression for the PR #2565 incident: a retry/resume path had copied a
    // worker-scoped emergency-diversion branch into context.baseBranch, and
    // isStackedPhaseBase's old exact-match check let it through unenforced as
    // the PR base. It must instead be rejected as a stacked declaration and
    // fall through to the mission's real integration branch, enforced.
    const got = resolveTaskPrBase({
      mission: OPTED_IN,
      task: {
        title: 'Do the thing',
        taskClass: 'work',
        context: { baseBranch: 'mission/checkout-arc-w1a2b3c4' },
      },
      head: 'buildd/abc12345-do-the-thing',
      fallbacks: TRUNK_FALLBACKS,
    });
    expect(got).toEqual({
      base: OPTED_IN.workingBranch,
      source: 'mission_integration',
      integrationBase: OPTED_IN.workingBranch,
      enforced: true,
    });
  });

  // ── the route out, when the integration branch no longer exists ───────────
  //
  // Part 2. A mission whose PR merged early had its integration branch deleted
  // by design; without this, every later worker on that mission derives a base
  // that 404s and has no way to deliver its PR at all.

  it('stops enforcing a mission integration base that is gone from the remote', () => {
    const got = resolveTaskPrBase({
      mission: OPTED_IN,
      task: { title: 'Late slice', taskClass: 'work' },
      head: 'buildd/abc12345-late-slice',
      fallbacks: TRUNK_FALLBACKS,
      integrationBaseMissing: true,
    });
    expect(got.base).toBe('dev');
    expect(got.enforced).toBe(false);
    // Still reported, so a caller can say in its note WHICH branch vanished.
    expect(got.integrationBase).toBe(OPTED_IN.workingBranch);
  });

  it('does not fall back onto the vanished branch via context.baseBranch', () => {
    // Option A′ writes the integration branch into context.baseBranch at task
    // creation, so the fallback chain would otherwise route straight back to the
    // deleted ref and 422 again.
    const got = resolveTaskPrBase({
      mission: OPTED_IN,
      task: {
        title: 'Late slice',
        taskClass: 'work',
        context: { baseBranch: OPTED_IN.workingBranch },
      },
      head: 'buildd/abc12345-late-slice',
      fallbacks: TRUNK_FALLBACKS,
      integrationBaseMissing: true,
    });
    expect(got.base).toBe('dev');
  });
});
