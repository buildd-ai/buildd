import { describe, it, expect } from 'bun:test';
import {
  MISSION_BRANCH_PREFIX,
  isMissionIntegrationBase,
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
