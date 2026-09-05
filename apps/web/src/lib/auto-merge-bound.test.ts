import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  protectedBaseBranches,
  hasBuildProof,
  evaluateModelApproveBound,
  BUILD_PROOF_CHECK_TOKENS,
} from './auto-merge-bound';

// ── protectedBaseBranches ─────────────────────────────────────────────────────

describe('protectedBaseBranches', () => {
  it('includes main even when nothing is configured', () => {
    expect(protectedBaseBranches({})).toEqual(['main']);
    expect(protectedBaseBranches({ gitConfig: null, releaseConfig: null })).toEqual(['main']);
  });

  it('includes the workspace target/default branch and the prod branch', () => {
    expect(
      protectedBaseBranches({
        gitConfig: { targetBranch: 'dev', defaultBranch: 'trunk' },
        releaseConfig: { prodBranch: 'production' },
      }),
    ).toEqual(['main', 'dev', 'trunk', 'production']);
  });

  it('dedupes and drops empty values', () => {
    expect(
      protectedBaseBranches({
        gitConfig: { targetBranch: 'dev', defaultBranch: 'dev' },
        releaseConfig: { prodBranch: '' },
      }),
    ).toEqual(['main', 'dev']);
  });
});

// ── hasBuildProof ─────────────────────────────────────────────────────────────

describe('hasBuildProof', () => {
  it('accepts a completed successful build check', () => {
    expect(
      hasBuildProof([{ name: 'Build & Test / build', status: 'completed', conclusion: 'success' }]),
    ).toEqual({ permitted: true });
  });

  it('rejects zero check runs — no runs is not the same as green', () => {
    const result = hasBuildProof([]);
    expect(result.permitted).toBe(false);
    expect(result.permitted === false && result.reason).toContain('no build/test check reported');
  });

  it('rejects a PR whose only build check was skipped', () => {
    const result = hasBuildProof([{ name: 'build', status: 'completed', conclusion: 'skipped' }]);
    expect(result.permitted).toBe(false);
    expect(result.permitted === false && result.reason).toContain('successful conclusion');
    expect(result.permitted === false && result.reason).toContain('build=skipped');
  });

  it('rejects when unrelated checks succeeded but no build/test check ran', () => {
    const result = hasBuildProof([
      { name: 'Vercel Preview', status: 'completed', conclusion: 'success' },
    ]);
    expect(result.permitted).toBe(false);
    expect(result.permitted === false && result.reason).toContain('no build/test check reported');
    expect(result.permitted === false && result.reason).toContain('Vercel Preview');
  });

  it('rejects a build check that is still running', () => {
    const result = hasBuildProof([{ name: 'build', status: 'in_progress', conclusion: null }]);
    expect(result.permitted).toBe(false);
    expect(result.permitted === false && result.reason).toContain('successful conclusion');
  });

  it('exports the token list the CI-completeness warning also uses', () => {
    expect(BUILD_PROOF_CHECK_TOKENS).toContain('build');
    expect(BUILD_PROOF_CHECK_TOKENS).toContain('test');
    expect(BUILD_PROOF_CHECK_TOKENS).toContain('typecheck');
  });

  it('is the same list evaluateAutoMergeSafety warns about, read from the source', () => {
    // Asserted structurally because the drift it prevents is not otherwise
    // observable: the shared gate only console.warns about absent checks, so a
    // second, divergent literal there would warn about one set of checks while
    // hasBuildProof refused on another, and every behavioural test would stay
    // green. Reverting the constant back to an inline literal must fail here.
    const source = readFileSync(join(import.meta.dir, 'auto-merge.ts'), 'utf8');
    expect(source).toContain('BUILD_PROOF_CHECK_TOKENS.filter(');
    expect(source).not.toContain("['typecheck', 'build', 'test']");
  });
});

// ── evaluateModelApproveBound ─────────────────────────────────────────────────

const GREEN = [{ name: 'build', status: 'completed', conclusion: 'success' }];
const TRUNK = ['main', 'dev', 'production'];
const MISSION_BRANCH = 'mission/example-slug-0a1b2c3d';
const optedInMission = { workingBranch: MISSION_BRANCH, integrationBranchEnabled: true };

describe('evaluateModelApproveBound', () => {
  it("permits an unattended merge into the mission's own integration branch", () => {
    expect(
      evaluateModelApproveBound({
        baseRef: MISSION_BRANCH,
        mission: optedInMission,
        protectedBranches: TRUNK,
        checkRuns: GREEN,
      }),
    ).toEqual({ permitted: true });
  });

  // ── the trunk deny list ─────────────────────────────────────────────────────
  //
  // Each of these asserts the deny list's own wording. Several bases below would
  // also be refused by the positive mission test, so "dev is refused" on its own
  // would not tell the two gates apart.

  it('refuses the SAME approve when the base is dev', () => {
    const result = evaluateModelApproveBound({
      baseRef: 'dev',
      mission: optedInMission,
      protectedBranches: TRUNK,
      checkRuns: GREEN,
    });
    expect(result.permitted).toBe(false);
    expect(result.permitted === false && result.reason).toContain("base 'dev' is a protected trunk branch");
  });

  it('refuses when the base is main', () => {
    const result = evaluateModelApproveBound({
      baseRef: 'main',
      mission: optedInMission,
      protectedBranches: TRUNK,
      checkRuns: GREEN,
    });
    expect(result.permitted).toBe(false);
    expect(result.permitted === false && result.reason).toContain("base 'main' is a protected trunk branch");
  });

  it("refuses when the base is the workspace's prodBranch", () => {
    const result = evaluateModelApproveBound({
      baseRef: 'production',
      mission: optedInMission,
      protectedBranches: TRUNK,
      checkRuns: GREEN,
    });
    expect(result.permitted).toBe(false);
    expect(result.permitted === false && result.reason).toContain(
      "base 'production' is a protected trunk branch",
    );
  });

  it("refuses a trunk base that the mission's own working branch points at", () => {
    // The deny list runs BEFORE the positive test, and this is the case that
    // proves it has to: `missions.workingBranch` is data an agent can write, so a
    // mission pointed at trunk satisfies `isMissionIntegrationBase` for a PR
    // based on trunk. Only the deny list refuses this one.
    const result = evaluateModelApproveBound({
      baseRef: 'dev',
      mission: { workingBranch: 'dev', integrationBranchEnabled: true },
      protectedBranches: TRUNK,
      checkRuns: GREEN,
    });
    expect(result.permitted).toBe(false);
    expect(result.permitted === false && result.reason).toContain('protected trunk branch');
  });

  it('refuses a protected branch even when it is named mission/*', () => {
    const result = evaluateModelApproveBound({
      baseRef: 'mission/trunk',
      mission: { workingBranch: 'mission/trunk', integrationBranchEnabled: true },
      protectedBranches: ['main', 'mission/trunk'],
      checkRuns: GREEN,
    });
    expect(result.permitted).toBe(false);
    expect(result.permitted === false && result.reason).toContain('protected trunk branch');
  });

  // ── the positive mission test: the mission ROW, never the branch name ──────

  it('refuses a mission/-shaped base when the mission has not opted in', () => {
    // The whole reason this predicate is authoritative rather than a name shape:
    // a workspace is free to carry a mission/… branch that no mission owns, and
    // treating one as quarantined is what silently removes the human gate.
    const result = evaluateModelApproveBound({
      baseRef: MISSION_BRANCH,
      mission: { workingBranch: MISSION_BRANCH, integrationBranchEnabled: false },
      protectedBranches: TRUNK,
      checkRuns: GREEN,
    });
    expect(result.permitted).toBe(false);
    expect(result.permitted === false && result.reason).toContain(
      "is not this mission's integration branch",
    );
  });

  it("refuses a mission/-shaped base belonging to some OTHER mission", () => {
    const result = evaluateModelApproveBound({
      baseRef: 'mission/someone-elses-slug-9f8e7d6c',
      mission: optedInMission,
      protectedBranches: TRUNK,
      checkRuns: GREEN,
    });
    expect(result.permitted).toBe(false);
    expect(result.permitted === false && result.reason).toContain(
      "is not this mission's integration branch",
    );
  });

  it('refuses when no mission row was resolved', () => {
    for (const mission of [null, undefined, {}]) {
      const result = evaluateModelApproveBound({
        baseRef: MISSION_BRANCH,
        mission,
        protectedBranches: TRUNK,
        checkRuns: GREEN,
      });
      expect(result.permitted).toBe(false);
      expect(result.permitted === false && result.reason).toContain(
        "is not this mission's integration branch",
      );
    }
  });

  it('refuses a non-trunk, non-mission base (no CI, no quarantine)', () => {
    const result = evaluateModelApproveBound({
      baseRef: 'feat/foo',
      mission: optedInMission,
      protectedBranches: TRUNK,
      checkRuns: GREEN,
    });
    expect(result.permitted).toBe(false);
    expect(result.permitted === false && result.reason).toContain(
      "is not this mission's integration branch",
    );
  });

  it('refuses when the base ref is unknown — fail closed', () => {
    for (const baseRef of [null, undefined, '']) {
      const result = evaluateModelApproveBound({
        baseRef,
        mission: optedInMission,
        protectedBranches: TRUNK,
        checkRuns: GREEN,
      });
      expect(result.permitted).toBe(false);
      expect(result.permitted === false && result.reason).toContain('base ref is unknown');
    }
  });

  // ── build proof, checked last so a bad base never depends on CI ────────────

  it('refuses when the build workflow never ran on a mission base', () => {
    const result = evaluateModelApproveBound({
      baseRef: MISSION_BRANCH,
      mission: optedInMission,
      protectedBranches: TRUNK,
      checkRuns: [],
    });
    expect(result.permitted).toBe(false);
    expect(result.permitted === false && result.reason).toContain('no build/test check reported');
  });
});

// ── the CI signal the bound depends on ───────────────────────────────────────

describe('Build & Test pull_request trigger', () => {
  // hasBuildProof can only ever pass if the workflow actually runs on the PR.
  // A base-name allowlist makes that conditional on someone remembering to add
  // each new branch convention, and an unlisted base produces zero runs — which
  // is indistinguishable from green to any check that only looks for failures.
  const workflow = readFileSync(
    join(import.meta.dir, '../../../../.github/workflows/build.yml'),
    'utf8',
  );
  const pullRequestBranches = /\n  pull_request:[\s\S]*?\n    branches:\s*(.+)\n/.exec(workflow)?.[1];

  it('runs on every PR base ref via a catch-all', () => {
    expect(pullRequestBranches).toBeDefined();
    expect(pullRequestBranches).toContain("'**'");
  });

  it('still records mission/** as an intended base', () => {
    expect(pullRequestBranches).toContain('mission/**');
  });
});
