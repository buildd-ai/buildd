import { describe, it, expect } from 'bun:test';
import {
  MISSION_BRANCH_PREFIX,
  shouldAnnounceBaseAdvance,
  isMissionIntegrationBase,
  isPrLegalForMissionTask,
  isStackedPhaseBase,
  looksLikeMissionIntegrationBranch,
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

describe('shouldAnnounceBaseAdvance', () => {
  const MISSION_BASE = 'mission/checkout-arc-1a2b3c4d';

  it('announces when a PR merges into a mission integration branch', () => {
    expect(shouldAnnounceBaseAdvance({ merged: true, baseRef: MISSION_BASE })).toBe(true);
  });

  it('does not announce for a PR closed without merging', () => {
    // Nothing moved, so refreshing the graph for that base would be work over a
    // base that did not advance.
    expect(shouldAnnounceBaseAdvance({ merged: false, baseRef: MISSION_BASE })).toBe(false);
  });

  it('does not announce when merged is absent', () => {
    expect(shouldAnnounceBaseAdvance({ baseRef: MISSION_BASE })).toBe(false);
    expect(shouldAnnounceBaseAdvance({ merged: null, baseRef: MISSION_BASE })).toBe(false);
  });

  it('does not announce for a merge into trunk', () => {
    // Trunk advances constantly and its seed is the default slot on the normal
    // cooldown; announcing every trunk merge would rebuild it every time.
    expect(shouldAnnounceBaseAdvance({ merged: true, baseRef: 'dev' })).toBe(false);
    expect(shouldAnnounceBaseAdvance({ merged: true, baseRef: 'main' })).toBe(false);
  });

  it('does not announce for a merge into a task branch', () => {
    expect(shouldAnnounceBaseAdvance({ merged: true, baseRef: 'buildd/1a2b3c4d-add-endpoint' })).toBe(false);
  });

  it('does not announce when the base ref is unknown', () => {
    expect(shouldAnnounceBaseAdvance({ merged: true, baseRef: null })).toBe(false);
    expect(shouldAnnounceBaseAdvance({ merged: true })).toBe(false);
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
  const PREDECESSOR = 'buildd/predecessor00-earlier-thing';

  it('is true for a genuine predecessor branch declaration', () => {
    expect(
      isStackedPhaseBase({ contextBaseBranch: PREDECESSOR, head: HEAD, mission: OPTED_IN }),
    ).toBe(true);
  });

  it('is false when context.baseBranch is unset', () => {
    expect(isStackedPhaseBase({ contextBaseBranch: undefined, head: HEAD, mission: OPTED_IN })).toBe(false);
    expect(isStackedPhaseBase({ contextBaseBranch: null, head: HEAD, mission: OPTED_IN })).toBe(false);
  });

  it('is false when context.baseBranch is the Option A′ default (equals the integration branch)', () => {
    expect(
      isStackedPhaseBase({ contextBaseBranch: OPTED_IN.workingBranch, head: HEAD, mission: OPTED_IN }),
    ).toBe(false);
  });

  it('is false when context.baseBranch is the recovery-task current-head marker', () => {
    expect(
      isStackedPhaseBase({ contextBaseBranch: HEAD, head: HEAD, mission: OPTED_IN }),
    ).toBe(false);
  });

  it('is false when the mission has no integration base — nothing to stack against', () => {
    expect(
      isStackedPhaseBase({ contextBaseBranch: PREDECESSOR, head: HEAD, mission: null }),
    ).toBe(false);
  });
});
