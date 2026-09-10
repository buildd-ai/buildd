/**
 * Option A′ — the shared base guard, replayed over the production sequence that
 * produced this fix.
 *
 * The sequence: a mission is created with an integration branch (resolved at
 * creation, branch ensured on the remote in the same call), tasks are claimed
 * against it, and a task PR is then registered with trunk as its base. Every
 * door that can register that PR asks this module, so the fixture below is the
 * one place all four answers are compared side by side — a door that stops
 * asking shows up as a route test failing, not as a silent second opinion.
 *
 * The exemptions are asserted here too, because "refuses everything" is a way
 * to pass a refusal test and break a mission.
 */

import { describe, it, expect } from 'bun:test';
import { buildMissionBaseGuard } from './mission-base-guard';
import { MISSION_PR_TASK_PREFIX } from '@buildd/core/mission-integration';

const INTEGRATION_BRANCH = 'mission/example-slug-0a1b2c3d';
const TRUNK = 'dev';
const TASK_BRANCH = 'buildd/abc12345-fix-a-thing';

const OPTED_IN_MISSION = {
  workingBranch: INTEGRATION_BRANCH,
  integrationBranchEnabled: true,
};

function taskGuard(overrides: Record<string, unknown> = {}, head: string = TASK_BRANCH) {
  return buildMissionBaseGuard({
    mission: OPTED_IN_MISSION,
    task: {
      title: 'Fix a thing',
      taskClass: 'work',
      missionId: 'mission-1',
      context: null,
      ...overrides,
    },
    head,
  });
}

describe('mission base guard — enforcement', () => {
  it('refuses trunk as the base of a mission task PR', () => {
    const guard = taskGuard();
    expect(guard.enforced).toBe(true);
    expect(guard.allows(TRUNK)).toBe(false);
    expect(guard.refusal(TRUNK)).not.toBeNull();
  });

  it('allows the mission integration branch', () => {
    const guard = taskGuard();
    expect(guard.allows(INTEGRATION_BRANCH)).toBe(true);
    expect(guard.refusal(INTEGRATION_BRANCH)).toBeNull();
  });

  it('treats an unknown base as illegal — unknown never resolves to a passing check', () => {
    const guard = taskGuard();
    expect(guard.allows(null)).toBe(false);
    expect(guard.allows(undefined)).toBe(false);
    expect(guard.allows('   ')).toBe(false);
  });

  it('names the integration branch and the offending PR in the refusal', () => {
    const refusal = taskGuard().refusal(TRUNK, { prNumber: 4242, action: 'adopt' });
    expect(refusal!.error).toContain(INTEGRATION_BRANCH);
    expect(refusal!.error).toContain(TRUNK);
    expect(refusal!.error).toContain('#4242');
    expect(refusal!.error).toContain('adopt');
    // The instruction an agent has to be able to act on without asking.
    expect(refusal!.hint).toContain(`base '${INTEGRATION_BRANCH}'`);
  });

  it('says "unknown" rather than quoting an empty base', () => {
    const refusal = taskGuard().refusal(null);
    expect(refusal!.error).toContain('unknown');
  });
});

describe('mission base guard — exemptions (unchanged from the derivation)', () => {
  it('exempts the mission-PR owner: its base IS trunk by design', () => {
    const guard = buildMissionBaseGuard({
      mission: OPTED_IN_MISSION,
      task: {
        title: `${MISSION_PR_TASK_PREFIX}Example mission`,
        taskClass: 'bookkeeping',
        missionId: 'mission-1',
        context: null,
      },
      head: INTEGRATION_BRANCH,
    });
    expect(guard.isMissionPrOwner).toBe(true);
    expect(guard.enforced).toBe(false);
    expect(guard.allows(TRUNK)).toBe(true);
  });

  it('exempts a stacked-plan phase: its base is the predecessor task’s branch', () => {
    const predecessor = 'buildd/predecessor00-earlier-thing';
    const guard = taskGuard({ context: { baseBranch: predecessor } });
    expect(guard.isStackedPhase).toBe(true);
    expect(guard.enforced).toBe(false);
    expect(guard.allows(predecessor)).toBe(true);
  });

  it('does NOT exempt a recovery task, whose context.baseBranch is its own head', () => {
    const guard = taskGuard({ context: { baseBranch: TASK_BRANCH } });
    expect(guard.isStackedPhase).toBe(false);
    expect(guard.enforced).toBe(true);
    expect(guard.allows(TRUNK)).toBe(false);
  });

  it('does NOT exempt the Option A′ default, where context.baseBranch IS the integration branch', () => {
    const guard = taskGuard({ context: { baseBranch: INTEGRATION_BRANCH } });
    expect(guard.isStackedPhase).toBe(false);
    expect(guard.enforced).toBe(true);
    expect(guard.allows(TRUNK)).toBe(false);
  });

  it('is inert for a mission with no integration base', () => {
    const guard = buildMissionBaseGuard({
      mission: { workingBranch: INTEGRATION_BRANCH, integrationBranchEnabled: false },
      task: { title: 'Fix a thing', taskClass: 'work', missionId: 'mission-1', context: null },
      head: TASK_BRANCH,
    });
    expect(guard.enforced).toBe(false);
    expect(guard.allows(TRUNK)).toBe(true);
    expect(guard.refusal(TRUNK)).toBeNull();
  });

  it('is inert for a mission flagged on but with no working branch recorded', () => {
    const guard = buildMissionBaseGuard({
      mission: { workingBranch: null, integrationBranchEnabled: true },
      task: { title: 'Fix a thing', taskClass: 'work', missionId: 'mission-1', context: null },
      head: TASK_BRANCH,
    });
    expect(guard.enforced).toBe(false);
    expect(guard.allows(TRUNK)).toBe(true);
  });

  it('is inert for a task with no mission at all', () => {
    const guard = buildMissionBaseGuard({
      mission: null,
      task: { title: 'Fix a thing', taskClass: 'work', missionId: null, context: null },
      head: TASK_BRANCH,
    });
    expect(guard.enforced).toBe(false);
    expect(guard.allows(TRUNK)).toBe(true);
  });

  it('is inert when there is no task row at all', () => {
    const guard = buildMissionBaseGuard({ mission: null, task: null, head: null });
    expect(guard.enforced).toBe(false);
    expect(guard.allows(TRUNK)).toBe(true);
  });
});
