import { describe, expect, it } from 'bun:test';
import { findBlockingPr } from '@buildd/core/path-overlap';
import { candidateLandingBase, partitionOpenPrsByLandingBase } from './open-pr-landing-base';

const MISSION_BRANCH = 'mission/example-integration-1a2b3c4d';

function pr(prNumber: number, prBaseRef: string | null, pathManifest: string[] | null) {
  return { taskId: `t-${prNumber}`, prNumber, prUrl: null, pathManifest, prBaseRef };
}

describe('candidateLandingBase', () => {
  it('a task with no mission lands on trunk', () => {
    expect(candidateLandingBase({ task: { context: {} }, mission: null, trunk: 'dev' })).toBe('dev');
  });

  it('a mission-branch child lands on the integration branch', () => {
    const mission = { workingBranch: MISSION_BRANCH, integrationBranchEnabled: true };
    expect(candidateLandingBase({ task: { context: {} }, mission, trunk: 'dev' })).toBe(MISSION_BRANCH);
  });

  it('an unknown trunk is unknown, never a guess', () => {
    expect(candidateLandingBase({ task: { context: {} }, mission: null, trunk: null })).toBeNull();
  });
});

describe('partitionOpenPrsByLandingBase', () => {
  // The live shape: a dev→mission refresh PR. Its task manifest grew to every
  // dev file the merge touched, and GitHub's own diff lists them too, because
  // that is what the PR brings into the mission branch. None of it changes
  // dev, so a dev-bound task is not waiting on it.
  it('a refresh PR into a mission branch does not block a trunk-bound task on dev-derived files', () => {
    const refresh = pr(3983, MISSION_BRANCH, ['apps/web/src/app/api/workers/claim/route.ts', 'apps/web/src/lib/pr-landing.ts']);
    const manifest = ['apps/web/src/app/api/workers/claim/route.ts'];
    expect(findBlockingPr(manifest, [refresh])).not.toBeNull(); // today's answer: a false HOLD
    const { sameBase, elsewhere } = partitionOpenPrsByLandingBase({ base: 'dev', trunk: 'dev', manifest }, [refresh]);
    expect(elsewhere.map(p => p.prNumber)).toEqual([3983]);
    expect(findBlockingPr(manifest, sameBase)).toBeNull();
  });

  it('a PR into the same base still blocks an overlapping candidate', () => {
    const devPr = pr(10, 'dev', ['apps/web/src/app/api/workers/claim/route.ts']);
    const manifest = ['apps/web/src/app/api/workers/claim/route.ts'];
    const { sameBase } = partitionOpenPrsByLandingBase({ base: 'dev', trunk: 'dev', manifest }, [devPr]);
    expect(findBlockingPr(manifest, sameBase)).toMatchObject({ prNumber: 10 });
  });

  it('a mission task is still blocked by an overlapping PR into its own mission branch', () => {
    const sibling = pr(11, MISSION_BRANCH, ['apps/web/src/lib/x.ts']);
    const manifest = ['apps/web/src/lib/x.ts'];
    const { sameBase } = partitionOpenPrsByLandingBase({ base: MISSION_BRANCH, trunk: 'dev', manifest }, [sibling]);
    expect(sameBase).toEqual([sibling]);
  });

  it('migrations on both sides stay blocking across bases (index collisions surface at the mission merge)', () => {
    const missionMigration = pr(12, MISSION_BRANCH, ['packages/core/drizzle/0270_x.sql', 'packages/core/db/schema.ts']);
    const manifest = ['packages/core/db/schema.ts'];
    const { sameBase, elsewhere } = partitionOpenPrsByLandingBase({ base: 'dev', trunk: 'dev', manifest }, [missionMigration]);
    expect(sameBase).toEqual([missionMigration]);
    expect(elsewhere).toEqual([]);
  });

  it('an unknown base on either side keeps the PR blocking (fail-safe)', () => {
    const noBase = pr(13, null, ['a.ts']);
    expect(partitionOpenPrsByLandingBase({ base: 'dev', trunk: 'dev', manifest: ['a.ts'] }, [noBase]).sameBase).toEqual([noBase]);
    const devPr = pr(14, 'dev', ['a.ts']);
    expect(partitionOpenPrsByLandingBase({ base: null, trunk: 'dev', manifest: ['a.ts'] }, [devPr]).sameBase).toEqual([devPr]);
  });

  it('a PR into a branch that is neither trunk nor a mission branch (a stacked phase) keeps blocking', () => {
    const stacked = pr(15, 'buildd/abcd1234-step-c', ['a.ts']);
    const { sameBase } = partitionOpenPrsByLandingBase({ base: 'dev', trunk: 'dev', manifest: ['a.ts'] }, [stacked]);
    expect(sameBase).toEqual([stacked]);
  });

  it('a PR into trunk does not block a task landing on a mission branch', () => {
    const devPr = pr(16, 'dev', ['a.ts']);
    const { elsewhere } = partitionOpenPrsByLandingBase({ base: MISSION_BRANCH, trunk: 'dev', manifest: ['a.ts'] }, [devPr]);
    expect(elsewhere).toEqual([devPr]);
  });
});
